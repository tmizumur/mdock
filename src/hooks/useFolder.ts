import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { type Entry, readDirs, readTree, watchFolder } from "../lib/api";
import { sameEntries, spliceTree } from "../lib/liveReload";
import { allTabs } from "../lib/workspace";
import { type useWorkspace } from "./useWorkspace";

type FolderLoad = { request: number; pending?: Promise<void>; expanding: Set<string> };

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
  const [watchedRoot, setWatchedRoot] = useState<string | null>(null);
  const openRequest = useRef(0);
  const folderLoadRef = useRef<FolderLoad | null>(null);

  /** 先に浅いツリーを表示し、監視を開始してから全体を読む */
  const openFolder = useCallback(async (dir: string, replaceTabs = false, restoring = false) => {
    if (restoring && openRequest.current !== 0) return;
    const request = ++openRequest.current;
    try {
      const entries = await readTree(dir, 2);
      if (request !== openRequest.current) return;
      if (replaceTabs && !(await confirmDirty(allTabs(wsRef.current)))) return;
      if (request !== openRequest.current) return;
      if (replaceTabs) clearTabs();

      const load: FolderLoad = { request, expanding: new Set() };
      folderLoadRef.current = load;
      rootRef.current = dir;
      setRootState(dir);
      setTree(entries);
      setWatchedRoot(null);
      if (!restoring) setError(null);
      load.pending = (async () => {
        try {
          await watchFolder(dir);
          if (folderLoadRef.current?.request === request) setWatchedRoot(dir);
        } catch (e) {
          if (!restoring && folderLoadRef.current?.request === request) setError(`フォルダを監視できませんでした: ${e}`);
        }
        try {
          if (folderLoadRef.current?.request !== request) return;
          const next = await readTree(dir);
          if (folderLoadRef.current?.request === request && !sameEntries(treeRef.current, next)) setTree(next);
        } catch (e) {
          if (folderLoadRef.current?.request === request) setError(`フォルダを読み込めませんでした: ${e}`);
        } finally {
          load.pending = undefined;
        }
      })();
    } catch (e) {
      if (!restoring && request === openRequest.current) setError(`フォルダを開けませんでした: ${e}`);
    }
  }, [clearTabs, confirmDirty, setError, setTree, wsRef]);

  const loadDirectory = useCallback(async (dir: string) => {
    const load = folderLoadRef.current;
    const root = rootRef.current;
    if (!load || !root || load.expanding.has(dir)) return;
    load.expanding.add(dir);
    try {
      const [children] = await readDirs([dir], root, 2);
      if (folderLoadRef.current !== load || !children) return;
      const tree = treeRef.current;
      const next = spliceTree(tree, dir, children, true);
      if (next && next !== tree) setTree(next);
    } catch (e) {
      if (folderLoadRef.current === load) setError(`フォルダを読み込めませんでした: ${e}`);
    } finally {
      load.expanding.delete(dir);
    }
  }, [setError, setTree]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") await openFolder(dir, true);
  };

  return { root, rootRef, tree, treeRef, setTree, folderLoadRef, watchedRoot, openFolder, pickFolder, loadDirectory };
}
