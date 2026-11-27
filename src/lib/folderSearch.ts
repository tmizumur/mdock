import { invoke } from "@tauri-apps/api/core";

export const MAX_SEARCH_RESULTS = 5000;

export type FolderMatch = {
  line: number;
  text: string;
  start: number;
  end: number;
  column: number;
  length: number;
};

type FileMatches = {
  path: string;
  relativePath: string;
  matches: FolderMatch[];
};

export type FolderSearchResults = {
  files: FileMatches[];
  count: number;
  truncated: boolean;
};

export type SearchLocation = {
  line: number;
  nonce: number;
  column: number;
  length: number;
  query: string;
  matchText: string;
};

export function searchFolder(root: string, query: string, caseSensitive: boolean, regex: boolean) {
  return invoke<FolderSearchResults>("search_folder", { root, query, caseSensitive, regex, maxResults: MAX_SEARCH_RESULTS });
}

export function cancelFolderSearch() {
  return invoke<void>("search_cancel");
}

export function splitMatch({ text, start, end }: Pick<FolderMatch, "text" | "start" | "end">) {
  return { before: text.slice(0, start), match: text.slice(start, end), after: text.slice(end) };
}

export function sourceMatch(text: string, { column, length, matchText }: SearchLocation) {
  const match = text.slice(column, column + length);
  return match.startsWith(matchText) ? match : "";
}

// 同じ結果への移動は、タブやモードを切り替えても繰り返さない。
export const handledSearchLocations = new WeakSet<SearchLocation>();
export const SEARCH_HIGHLIGHT_MS = 2000;

export function previewSearchBlock(root: HTMLElement, line: number) {
  let block: HTMLElement | undefined;
  let blockLine = -1;
  for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const start = Number(el.dataset.line);
    if (!Number.isFinite(start) || start < 0) continue;
    if (!block || (start <= line && (blockLine > line || start >= blockLine))) {
      block = el;
      blockLine = start;
    }
  }
  return block ? { block, blockLine } : undefined;
}

// 同じブロックに同じ文字列が並ぶときの、一致の順番を求める。
export function previewMatchIndex(lines: string[], blockLine: number, location: SearchLocation, match: string) {
  if (!match) return 0;
  let index = 0;
  for (let line = blockLine; line <= location.line; line++) {
    const text = lines[line] ?? "";
    const end = line === location.line ? location.column : text.length;
    for (let at = text.indexOf(match); at >= 0 && at + match.length <= end; at = text.indexOf(match, at + match.length)) {
      index++;
    }
  }
  return index;
}
