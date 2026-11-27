import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirname, norm, readTree, takePendingOpens } from "../lib/api";
import { allTabs } from "../lib/workspace";
import { type useFolder } from "./useFolder";
import { type useWorkspace } from "./useWorkspace";

export function useWindowTitle(root: string | null) {
  // ウィンドウタイトル
  useEffect(() => {
    const name = root ? norm(root).split("/").pop() : null;
    getCurrentWindow().setTitle(name ? `${name} — Mdock` : "Mdock").catch(() => {});
  }, [root]);
}

export function useWindowDrop(
  openFolder: ReturnType<typeof useFolder>["openFolder"],
  { activeRef, openFile }: Pick<ReturnType<typeof useWorkspace>, "activeRef" | "openFile">,
) {
  // フォルダ・ファイルのドラッグ&ドロップ
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (ev) => {
      if (ev.payload.type !== "drop" || !ev.payload.paths.length) return;
      const p = ev.payload.paths[0];
      try {
        await readTree(p);
      } catch {
        // フォルダでなければファイルとして新しいタブで開く
        openFile(p, activeRef.current, { newTab: true });
        return;
      }
      openFolder(p, true);
    });
    return () => {
      un.then((f) => f());
    };
  }, [openFolder, openFile, activeRef]);
}

export function useFinderOpen(
  ready: boolean,
  { rootRef, openFolder }: Pick<ReturnType<typeof useFolder>, "rootRef" | "openFolder">,
  { activeRef, clearTabs, confirmDirty, openFile, wsRef }:
    Pick<ReturnType<typeof useWorkspace>, "activeRef" | "clearTabs" | "confirmDirty" | "openFile" | "wsRef">,
) {
  /** Finder から開かれたファイル・フォルダ（関連付け・このアプリで開く）。フォルダ未選択なら親フォルダをルートにする */
  const openPaths = async () => {
    const paths = await takePendingOpens().catch(() => [] as string[]);
    for (const p of paths) {
      let isDir = false;
      try {
        await readTree(p);
        isDir = true;
      } catch {
        /* ファイル */
      }
      if (isDir) {
        if (!(await confirmDirty(allTabs(wsRef.current)))) continue;
        clearTabs();
        await openFolder(p);
      } else {
        if (!rootRef.current) await openFolder(dirname(p));
        await openFile(p, activeRef.current, { newTab: true });
      }
    }
  };
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;
  useEffect(() => {
    if (!ready) return;
    openPathsRef.current();
    const un = getCurrentWindow().listen("open-paths", () => openPathsRef.current());
    return () => {
      un.then((f) => f());
    };
  }, [ready]);
}
