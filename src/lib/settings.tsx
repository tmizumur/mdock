import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
};

export const DEFAULT_SETTINGS: Settings = { fontSize: 15, width: "normal", wrap: true };
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

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    saveSettings(JSON.stringify(settings)).catch((e) => console.warn("save settings", e));
  }, [settings]);

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
