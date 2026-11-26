import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { type Entry, readTree, watchFolder } from "../lib/api";
import { allTabs } from "../lib/workspace";
import { type useWorkspace } from "./useWorkspace";

export function useFolder(
  { clearTabs, confirmDirty, wsRef }: Pick<ReturnType<typeof useWorkspace>, "clearTabs" | "confirmDirty" | "wsRef">,
  setError: (error: string | null) => void,
) {
  const [root, setRootState] = useState<string | null>(null);
  const [tree, setTreeState] = useState<Entry[]>([]);
  /** ツリーの最新の状態（非同期の部分更新で、古いツリーに上書きしないため） */
  const treeRef = useRef<Entry[]>([]);
  const setTree = useCallback((t: Entry[]) => {
    treeRef.current = t;
    setTreeState(t);
  }, []);
  const rootRef = useRef<string | null>(null);
  const setRoot = useCallback((dir: string | null) => {
    rootRef.current = dir;
    setRootState(dir);
  }, []);

  const [watchedRoot, setWatchedRoot] = useState<string | null>(null);
  const watchRequest = useRef(0);
  const startWatchingFolder = useCallback(async (dir: string) => {
    const request = ++watchRequest.current;
    setWatchedRoot(null);
    await watchFolder(dir);
    if (request === watchRequest.current) setWatchedRoot(dir);
  }, []);

  /** フォルダのツリーを読み込み、監視を開始する */
  const openFolder = useCallback(async (dir: string, replaceTabs = false) => {
    try {
      const entries = await readTree(dir);
      if (replaceTabs) {
        if (!(await confirmDirty(allTabs(wsRef.current)))) return;
        clearTabs();
      }
      setRoot(dir);
      setTree(entries);
      await startWatchingFolder(dir);
      setError(null);
    } catch (e) {
      setError(`フォルダを開けませんでした: ${e}`);
    }
  }, [clearTabs, confirmDirty, setError, setRoot, setTree, startWatchingFolder, wsRef]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") await openFolder(dir, true);
  };

  const refreshTree = useCallback(() => {
    const r = rootRef.current;
    if (r) readTree(r).then(setTree).catch(() => {});
  }, [setTree]);

  return { root, rootRef, setRoot, tree, treeRef, setTree, watchedRoot, startWatchingFolder, openFolder, pickFolder, refreshTree };
}
