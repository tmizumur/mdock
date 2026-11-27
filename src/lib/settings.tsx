import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, saveSettings } from "./api";

export type DocWidth = "normal" | "wide" | "full";
export type EditorFont = "mono" | "sans" | "serif";

/** アプリ全体の設定（ペインやファイルごとではない）。settings.json に保存する。 */
export type Settings = {
  /** 本文の文字サイズ（px） */
  fontSize: number;
  /** プレビュー本文の幅 */
  width: DocWidth;
  /** エディタとプレビューのコードブロックを折り返す */
  wrap: boolean;
  /** 画面のアニメーションを表示する */
  animations: boolean;
  /** ウィンドウ下部にステータスバーを表示する */
  statusBar: boolean;
  /** エディタの書体 */
  editorFont: EditorFont;
  /** 新しい版を自動で確認する（1時間ごと） */
  autoUpdate: boolean;
  /** ツリーに git の変更状態を出す */
  gitStatus: boolean;
  /** ツリーなどから仮のタブで開く */
  previewTabs: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 15,
  width: "normal",
  wrap: true,
  animations: true,
  statusBar: true,
  editorFont: "mono",
  autoUpdate: true,
  gitStatus: true,
  previewTabs: true,
};
export const FONT_MIN = 10;
export const FONT_MAX = 28;

export const WIDTH_LABEL: Record<DocWidth, string> = { normal: "標準", wide: "広い", full: "全幅" };
export const EDITOR_FONT_LABEL: Record<EditorFont, string> = { mono: "等幅", sans: "ゴシック", serif: "明朝" };

type Ctx = {
  settings: Settings;
  update: (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void;
};

const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, update: () => {} });

function withDefaults(saved: Partial<Settings>): Settings {
  const next = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (typeof saved[key] === typeof next[key]) Object.assign(next, { [key]: saved[key] });
  }
  return next;
}

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await loadSettings();
    if (raw) {
      return withDefaults(JSON.parse(raw));
    }
  } catch (e) {
    console.warn("settings", e);
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ initial, children }: { initial: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const first = useRef(true);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("no-motion", !settings.animations);
    return () => document.documentElement.classList.remove("no-motion");
  }, [settings.animations]);

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
        const next = withDefaults(JSON.parse(ev.payload));
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

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
