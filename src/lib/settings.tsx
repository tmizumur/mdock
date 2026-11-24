import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, saveSettings } from "./api";
import { applyTheme, onSystemThemeChange } from "./theme";

export type DocWidth = "normal" | "wide" | "full";
export type ThemePref = "auto" | "light" | "dark";
export type EditorFont = "mono" | "sans" | "serif";

/** アプリ全体の設定（ペインやファイルごとではない）。settings.json に保存する。 */
export type Settings = {
  /** 本文の文字サイズ（px） */
  fontSize: number;
  /** プレビュー本文の幅 */
  width: DocWidth;
  /** エディタとプレビューのコードブロックを折り返す */
  wrap: boolean;
  /** ツリーに . から始まるファイル・フォルダも出す */
  showHidden: boolean;
  /** ツリーに Markdown ファイルだけを出す */
  mdOnly: boolean;
  /** 配色（自動は OS の設定に合わせる） */
  theme: ThemePref;
  /** エディタの書体 */
  editorFont: EditorFont;
  /** 新しい版を自動で確認する（1時間ごと） */
  autoUpdate: boolean;
  /** ツリーに git の変更状態を出す */
  gitStatus: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 15,
  width: "normal",
  wrap: true,
  showHidden: false,
  mdOnly: true,
  theme: "auto",
  editorFont: "mono",
  autoUpdate: true,
  gitStatus: true,
};
export const FONT_MIN = 10;
export const FONT_MAX = 28;

export const WIDTH_LABEL: Record<DocWidth, string> = { normal: "標準", wide: "広い", full: "全幅" };
export const THEME_LABEL: Record<ThemePref, string> = { auto: "自動", light: "ライト", dark: "ダーク" };
export const EDITOR_FONT_LABEL: Record<EditorFont, string> = { mono: "等幅", sans: "ゴシック", serif: "明朝" };

/** settings.json に保存されていた項目（新しく増えた項目を、以前の保存場所から引き継ぐのに使う） */
export const savedKeys = new Set<string>();

type Ctx = {
  settings: Settings;
  /** 実際に使っている配色（テーマが「自動」なら OS の設定） */
  dark: boolean;
  update: (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void;
};

const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, dark: false, update: () => {} });

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await loadSettings();
    if (raw) {
      const saved = JSON.parse(raw);
      Object.keys(saved).forEach((k) => savedKeys.add(k));
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (e) {
    console.warn("settings", e);
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ initial, children }: { initial: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const first = useRef(true);
  const [dark, setDark] = useState(() => applyTheme(initial.theme) === "dark");

  // テーマ（自動 / ライト / ダーク）を画面に反映する。自動のときは OS の切り替えにも追従する
  useEffect(() => {
    const apply = () => setDark(applyTheme(settings.theme) === "dark");
    apply();
    return onSystemThemeChange(apply);
  }, [settings.theme]);

  const update = useCallback<Ctx["update"]>((patch) => {
    setSettings((s) => {
      const p = typeof patch === "function" ? patch(s) : patch;
      const next = { ...s, ...p };
      next.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next.fontSize)));
      return next;
    });
  }, []);

  // ほかのウィンドウで設定を変えたら、こちらにも反映する
  const remote = useRef<string | null>(null);
  useEffect(() => {
    const un = listen<string>("settings-changed", (ev) => {
      try {
        const next = { ...DEFAULT_SETTINGS, ...JSON.parse(ev.payload) } as Settings;
        setSettings((cur) => {
          if (JSON.stringify(cur) === JSON.stringify(next)) return cur;
          remote.current = JSON.stringify(next);
          return next;
        });
      } catch {
        /* 壊れた内容は無視 */
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const json = JSON.stringify(settings);
    if (remote.current === json) return; // ほかのウィンドウから来た変更は書き戻さない
    remote.current = null;
    saveSettings(json).catch((e) => console.warn("save settings", e));
  }, [settings]);

  return <SettingsContext.Provider value={{ settings, dark, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
