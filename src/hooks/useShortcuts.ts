import { useEffect } from "react";
import { openNewWindow } from "../lib/api";
import { leaves } from "../lib/layout";
import { DEFAULT_SETTINGS, type useSettings } from "../lib/settings";
import { activeTab, emptyPane } from "../lib/tabs";
import { type useMenuActions } from "./useMenuActions";
import { type usePaneActions } from "./usePaneActions";
import { type useWorkspace } from "./useWorkspace";

export function useShortcuts(
  { livePane, activeRef, cycleTab, closeActiveTab, wsRef, toggleSplit, splitTab, focusPane, splitWith }:
    Pick<ReturnType<typeof useWorkspace>, "livePane" | "activeRef" | "cycleTab" | "closeActiveTab" | "wsRef" | "toggleSplit" | "splitTab" | "focusPane" | "splitWith">,
  { findInPane, toggleMode }: Pick<ReturnType<typeof usePaneActions>, "findInPane" | "toggleMode">,
  actions: ReturnType<typeof useMenuActions>,
  updateSettings: ReturnType<typeof useSettings>["update"],
  setSettingsOpen: (open: boolean) => void,
  setError: (error: string | null) => void,
) {
  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const i = livePane(activeRef.current);
      if (k === "," && !e.shiftKey) {
        // ⌘,: 設定（メニューのショートカットが先に受け取ることが多いが、念のため）
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.shiftKey && (k === "[" || k === "{" || k === "]" || k === "}")) {
        // ⌘⇧[ / ⌘⇧] でタブを移動
        e.preventDefault();
        cycleTab(k === "[" || k === "{" ? -1 : 1);
      } else if (k === "f" && !e.shiftKey) {
        // CodeMirror が自分で処理した場合（エディタにフォーカスがある）は何もしない
        if (e.defaultPrevented) return;
        e.preventDefault();
        findInPane(i);
      } else if (k === "=" || k === "+" || k === ";") {
        // ⌘+（JIS キーボードでは ⌘; の位置）で文字を大きく
        e.preventDefault();
        updateSettings((s) => ({ fontSize: s.fontSize + 1 }));
      } else if (k === "-") {
        e.preventDefault();
        updateSettings((s) => ({ fontSize: s.fontSize - 1 }));
      } else if (k === "0") {
        e.preventDefault();
        updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
      } else if (k === "s") {
        e.preventDefault();
        actions.current.save();
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        openNewWindow().catch((err) => setError(String(err)));
      } else if (k === "o") {
        e.preventDefault();
        actions.current[e.shiftKey ? "open-folder" : "open-file"]();
      } else if (k === "w") {
        e.preventDefault();
        closeActiveTab();
      } else if (k === "e") {
        e.preventDefault();
        if (activeTab(wsRef.current.panes[i] ?? emptyPane())?.kind === "doc") toggleMode(i);
      } else if (e.altKey && !e.shiftKey && (e.code === "Backslash" || e.code === "IntlYen" || k === "\\")) {
        // ⌘⌥\: 上下に分割／1画面に戻す
        e.preventDefault();
        toggleSplit("col");
      } else if (k === "\\" && !e.shiftKey && !e.altKey) {
        // ⌘\: 今のペインを右に分割（今のタブを複製して開く）
        e.preventDefault();
        splitTab(i, "right");
      } else if (/^[1-9]$/.test(k) && !e.shiftKey && !e.altKey) {
        // ⌘1〜⌘9: 画面上の順で n 番目のペインへ。1 つ先なら右端に新しいペインを作る（VS Code と同じ）
        e.preventDefault();
        const o = leaves(wsRef.current.layout);
        const n = Number(k) - 1;
        if (n < o.length) focusPane(o[n]);
        else if (n === o.length) splitWith(o[o.length - 1], "right", []);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
