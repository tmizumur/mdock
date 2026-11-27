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
    print: () => printPane(activeRef.current),
    settings: () => setSettingsOpen(true),
  };
  useEffect(() => {
    const un = getCurrentWindow().listen<string>("menu", (ev) => actions.current[ev.payload]?.());
    return () => {
      un.then((f) => f());
    };
  }, []);

  return actions;
}
