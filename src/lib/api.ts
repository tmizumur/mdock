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
