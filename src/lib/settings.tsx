import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, saveSettings } from "./api";

export type DocWidth = "normal" | "wide" | "full";

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
};

export const DEFAULT_SETTINGS: Settings = { fontSize: 15, width: "normal", wrap: true, showHidden: false };
export const FONT_MIN = 10;
export const FONT_MAX = 28;

export const WIDTH_LABEL: Record<DocWidth, string> = { normal: "標準", wide: "広い", full: "全幅" };

type Ctx = {
  settings: Settings;
  update: (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void;
};

const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, update: () => {} });

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await loadSettings();
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    console.warn("settings", e);
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ initial, children }: { initial: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const first = useRef(true);

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

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
