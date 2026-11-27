import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activeTab } from "../lib/tabs";
import { type useFolder } from "./useFolder";
import { type usePaneActions } from "./usePaneActions";
import { type useWorkspace } from "./useWorkspace";

export function useMenuActions(
  { activeRef, wsRef, saveTab, closeActiveTab }: Pick<ReturnType<typeof useWorkspace>, "activeRef" | "wsRef" | "saveTab" | "closeActiveTab">,
  pickFiles: () => Promise<void>,
  pickFolder: ReturnType<typeof useFolder>["pickFolder"],
  printPane: ReturnType<typeof usePaneActions>["printPane"],
  setSettingsOpen: (open: boolean) => void,
  toggleSearch: () => void,
) {
  // メニュー（⌘W・⌘O・⌘S など）から呼ばれる操作。最新の状態を使うため ref 経由で呼ぶ
  const actions = useRef<Record<string, () => void>>({});
  actions.current = {
    "open-file": pickFiles,
    "open-folder": pickFolder,
    "search-folder": toggleSearch,
    save: () => {
      const p = wsRef.current.panes[activeRef.current];
      const t = p && activeTab(p);
      if (t) saveTab(t.id);
    },
    "close-tab": closeActiveTab,
    "close-window": () => getCurrentWindow().close(),
    print: () => printPane(activeRef.current),
    settings: () => setSettingsOpen(true),
  };
  // メニューのキー（アクセラレータ）とアプリのキー処理の両方が同じキーを受け取っても、1回だけ実行する
  const last = useRef<{ id: string; at: number; source: "key" | "menu" } | null>(null);
  const run = useRef((id: string, source: "key" | "menu") => {
    const now = performance.now();
    const l = last.current;
    if (l && l.id === id && l.source !== source && now - l.at < 400) return;
    last.current = { id, at: now, source };
    actions.current[id]?.();
  }).current;
  useEffect(() => {
    const un = getCurrentWindow().listen<string>("menu", (ev) => run(ev.payload, "menu"));
    return () => {
      un.then((f) => f());
    };
  }, [run]);

  return { actions, run };
}
