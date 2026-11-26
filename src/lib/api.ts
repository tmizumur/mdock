import { invoke } from "@tauri-apps/api/core";

export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  children: Entry[];
  loaded?: boolean;
};

export type TextInfo = { text: string; encoding: string; bom: boolean };
export type TextFormat = { encoding?: string; bom?: boolean };
const fileErrorMessages = {
  not_found: "ファイルが見つかりません。",
  permission_denied: "ファイルへのアクセス権限がありません。",
  is_directory: "フォルダです。",
  not_regular_file: "通常のファイルではありません。",
  large_file: "大きなファイルです。",
  too_large: "ファイルが大きすぎます（上限は 100 MB です）。",
  invalid_encoding: "文字コードを判定できません。",
  unrepresentable: "指定した文字コードで保存できない文字があります。",
  other: "ファイルの操作中にエラーが発生しました。",
};
export type FileError = { code: keyof typeof fileErrorMessages; message: string; size?: number };

export function parseFileError(error: unknown): FileError {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      Object.prototype.hasOwnProperty.call(fileErrorMessages, error.code)) {
    const code = error.code as FileError["code"];
    const message = "message" in error && typeof error.message === "string" && error.message
      ? error.message : fileErrorMessages[code];
    const size = "size" in error && typeof error.size === "number" && Number.isSafeInteger(error.size) && error.size >= 0
      ? error.size : undefined;
    return { code, message, size };
  }
  return { code: "other", message: fileErrorMessages.other };
}

export const readTree = (root: string, maxDepth?: number) => invoke<Entry[]>("read_tree", { root, maxDepth });
export const readTextInfo = (path: string, force = false) => invoke<TextInfo>("read_text", { path, force });
export const readText = async (path: string) => (await readTextInfo(path)).text;
export const writeText = (path: string, content: string, format: TextFormat = {}) =>
  invoke<void>("write_text", { path, content, ...format });

export type TextReadResult = { info: TextInfo; error?: undefined } | { info?: undefined; error: FileError };
export async function readTextResult(path: string, force = false): Promise<TextReadResult> {
  try {
    return { info: await readTextInfo(path, force) };
  } catch (error) {
    return { error: parseFileError(error) };
  }
}
export const watchFolder = (root: string) => invoke<void>("watch_folder", { root });
/** 開いているファイルの一覧（フォルダの外のファイルも監視するため） */
export const watchFiles = (paths: string[]) => invoke<void>("watch_files", { paths });
/** 変更のあったフォルダだけ読み直す（フォルダごとの中身。消えていれば null） */
export const readDirs = (dirs: string[], root: string) => invoke<(Entry[] | null)[]>("read_dirs", { dirs, root });

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
