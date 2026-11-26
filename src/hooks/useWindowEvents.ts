import { useCallback, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { dirname, norm, statPaths, takePendingOpens } from "../lib/api";
import { type useFolder } from "./useFolder";
import { type useWorkspace } from "./useWorkspace";

export function useWindowTitle(root: string | null) {
  // ウィンドウタイトル
  useEffect(() => {
    const name = root ? norm(root).split("/").pop() : null;
    getCurrentWindow().setTitle(name ? `${name} — Mdock` : "Mdock").catch(() => {});
  }, [root]);
}

export function useFileOpen(
  ready: boolean,
  { rootRef, openFolder }: Pick<ReturnType<typeof useFolder>, "rootRef" | "openFolder">,
  { activeRef, openFile }: Pick<ReturnType<typeof useWorkspace>, "activeRef" | "openFile">,
  setError: (error: string | null) => void,
) {
  const openFiles = useCallback(async (paths: string[], openParent = true) => {
    if (!paths.length) return;
    const pane = activeRef.current;
    if (openParent && !rootRef.current) await openFolder(dirname(paths[0]) || "/");
    for (const path of paths) await openFile(path, pane, { newTab: true });
  }, [activeRef, openFile, openFolder, rootRef]);

  useWindowDrop(openFolder, openFiles);
  useFinderOpen(ready, openFolder, openFiles);

  return async () => {
    try {
      const paths = await open({
        multiple: true,
        filters: [
          { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
          // macOS のファイル種別を指定して、拡張子のないファイルも選べるようにする
          { name: "すべてのファイル", extensions: ["public.item"] },
        ],
      });
      if (paths) await openFiles(paths);
    } catch (e) {
      setError(`ファイルを開けませんでした: ${e}`);
    }
  };
}

async function directoryPaths(paths: string[]) {
  const stats = await statPaths(paths).catch(() => []);
  return new Set(paths.filter((_, i) => stats[i]?.is_dir));
}

function useWindowDrop(
  openFolder: ReturnType<typeof useFolder>["openFolder"],
  openFiles: (paths: string[], openParent?: boolean) => Promise<void>,
) {
  // フォルダ・ファイルのドラッグ&ドロップ
  useEffect(() => {
    let active = true;
    const un = getCurrentWebview().onDragDropEvent(async (ev) => {
      if (!active || ev.payload.type !== "drop" || !ev.payload.paths.length) return;
      const paths = ev.payload.paths;
      const dirs = await directoryPaths(paths);
      if (!active) return;
      const dir = paths.find((p) => dirs.has(p));
      if (dir) await openFolder(dir, true);
      if (active) await openFiles(paths.filter((p) => !dirs.has(p)), false);
    });
    return () => {
      active = false;
      un.then((f) => f());
    };
  }, [openFolder, openFiles]);
}

function useFinderOpen(
  ready: boolean,
  openFolder: ReturnType<typeof useFolder>["openFolder"],
  openFiles: (paths: string[]) => Promise<void>,
) {
  // Finder の関連付けと「このアプリで開く」
  useEffect(() => {
    if (!ready) return;
    const openPaths = async () => {
      const paths = await takePendingOpens().catch(() => []);
      if (!paths.length) return;
      const dirs = await directoryPaths(paths);
      for (const path of paths) {
        if (dirs.has(path)) await openFolder(path, true);
        else await openFiles([path]);
      }
    };
    openPaths();
    const un = getCurrentWindow().listen("open-paths", openPaths);
    return () => {
      un.then((f) => f());
    };
  }, [ready, openFolder, openFiles]);
}
