import { invoke } from "@tauri-apps/api/core";

export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  children: Entry[];
};

export const readTree = (root: string) => invoke<Entry[]>("read_tree", { root });
export const readText = (path: string) => invoke<string>("read_text", { path });
export const writeText = (path: string, content: string) =>
  invoke<void>("write_text", { path, content });
export const watchFolder = (root: string) => invoke<void>("watch_folder", { root });
/** 開いているファイルの一覧（フォルダの外のファイルも監視するため） */
export const watchFiles = (paths: string[]) => invoke<void>("watch_files", { paths });
/** 変更のあったフォルダだけ読み直す（フォルダごとの中身。消えていれば null） */
export const readDirs = (dirs: string[]) => invoke<(Entry[] | null)[]>("read_dirs", { dirs });

export type Stat = { exists: boolean; is_dir: boolean; is_executable?: boolean; mtime: number; size: number };
export const statPaths = (paths: string[]) => invoke<Stat[]>("stat_paths", { paths });
export const confirmOpenUrl = (url: string) => invoke<void>("confirm_open_url", { url });

export const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);

/** パスの区切りを "/" にそろえる（Mac 前提だが念のため） */
export const norm = (p: string) => p.replace(/\\/g, "/");

export const dirname = (p: string) => norm(p).replace(/\/[^/]*$/, "");

/** base ファイルからの相対パスを絶対パスに解決する */
export function resolvePath(baseFile: string, rel: string): string {
  const parts = (rel.startsWith("/") ? rel : `${dirname(baseFile)}/${rel}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
}

export const loadSession = () => invoke<string | null>("load_session");
export const saveSession = (json: string) => invoke<void>("save_session", { json });
export const loadSettings = () => invoke<string | null>("load_settings");
export const saveSettings = (json: string) => invoke<void>("save_settings", { json });

/** URL エンコードされている可能性のあるパスを戻す（壊れた % はそのまま） */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- ファイル操作（開いているフォルダの中だけ） ----
export const createEntry = (dir: string, name: string, isDir: boolean) =>
  invoke<string>("create_entry", { dir, name, isDir });
export const renameEntry = (path: string, newName: string) => invoke<string>("rename_entry", { path, newName });
export const trashEntry = (path: string) => invoke<void>("trash_entry", { path });

// ---- ウィンドウ・印刷・Finder から開かれたファイル ----
export const openNewWindow = () => invoke<void>("open_new_window");
export const cancelQuit = () => invoke<void>("cancel_quit");
export const printWindow = () => invoke<void>("print_window");
export const takePendingOpens = () => invoke<string[]>("take_pending_opens");

/** クリップボードにコピー（使えない環境では execCommand で代わりに） */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.parentNode?.removeChild(ta);
  }
}
