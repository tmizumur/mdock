/** 外部（AI・ほかのエディタ・git など）での変更を、ツリーと開いているタブに反映するための計算 */

import { type Entry, type Stat, norm } from "./api";

/** watcher から届く変更 */
export type FsChange = { paths: string[]; rescan: boolean };

export const FILES_CHANGED = "mdock:files-changed";

declare global {
  interface WindowEventMap {
    [FILES_CHANGED]: CustomEvent<FsChange>;
  }
}

/** パスの比較用の形（macOS は大文字小文字を区別しないので小文字にそろえる） */
export const pathKey = (p: string) => norm(p).replace(/\/+$/, "").toLowerCase();

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

/**
 * 変更が path に関係するか。自身が変わったときのほか、上のフォルダのパスで届いた
 * （フォルダごと移動・削除された、FSEvents がまとめて知らせた）ときも関係ありとする。
 */
export function changeMatcher(change: FsChange): (path: string) => boolean {
  if (change.rescan) return () => true;
  const set = new Set(change.paths.map(pathKey));
  return (path) => {
    for (let k = pathKey(path); k.length > 0; k = parentOf(k)) if (set.has(k)) return true;
    return false;
  };
}

/** changed の中で、path 自身か上のフォルダにあたるもの（元の大文字小文字のまま） */
export function matchedAncestor(changed: string[], path: string): string | undefined {
  const keys = new Map(changed.map((c) => [pathKey(c), c]));
  for (let k = pathKey(path); k.length > 0; k = parentOf(k)) {
    const hit = keys.get(k);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** ツリーに出さないフォルダ（Rust の SKIP_DIRS と同じ） */
const SKIP = new Set(["node_modules", "target", "dist", "build", ".git", ".venv", "__pycache__", ".next", ".cache", ".turbo", ".svn", ".hg"]);

/** ツリーの表示に関係しない変更か（対象フォルダの外、除外フォルダとその中身、.DS_Store） */
export function irrelevantForTree(root: string, path: string): boolean {
  const r = pathKey(root);
  const k = pathKey(path);
  if (k !== r && !k.startsWith(r + "/")) return true;
  const segs = norm(path).slice(norm(root).replace(/\/+$/, "").length + 1).split("/").filter(Boolean);
  return segs.some((s) => SKIP.has(s) || s === ".DS_Store");
}

export function indexTree(tree: Entry[]): Map<string, Entry> {
  const m = new Map<string, Entry>();
  const walk = (es: Entry[]) => {
    for (const e of es) {
      m.set(pathKey(e.path), e);
      if (e.is_dir) walk(e.children);
    }
  };
  walk(tree);
  return m;
}

/** 一度に部分的に読み直すフォルダの上限。これより多ければ全体を読み直す */
const MAX_DIRS = 30;

/**
 * ツリーのうち読み直すフォルダ。"all" なら全体、空なら読み直さなくてよい。
 * - ツリーにあるファイルが今もファイルとしてある（中身が変わっただけ）→ 何もしない
 * - 新しくできた・消えた・種類が変わった → それを含むフォルダ（ツリーにある一番近いもの）を読み直す
 * - ツリーにあるフォルダ自体のパスで届いた → そのフォルダを読み直す
 */
export function dirsToReread(
  root: string,
  index: Map<string, Entry>,
  changed: string[],
  stats: Map<string, Stat>,
): string[] | "all" {
  const rootKey = pathKey(root);
  const dirs = new Map<string, string>();
  const rootPath = norm(root).replace(/\/+$/, "");
  /** p を含むフォルダのうち、ツリーにある一番近いもの（無ければ開いたフォルダ） */
  const nearestDir = (p: string) => {
    for (let d = parentOf(norm(p)); ; d = parentOf(d)) {
      const dk = pathKey(d);
      if (dk.length <= rootKey.length) return rootPath;
      if (index.get(dk)?.is_dir) return d;
    }
  };
  for (const c of changed) {
    const k = pathKey(c);
    if (k === rootKey) return "all";
    const e = index.get(k);
    const st = stats.get(k);
    if (e && st?.exists && e.is_dir === st.is_dir) {
      if (!e.is_dir) continue; // 中身の変更だけ
      dirs.set(k, e.path);
      continue;
    }
    const d = nearestDir(c);
    if (pathKey(d) === rootKey) return "all";
    dirs.set(pathKey(d), d);
  }
  // 上のフォルダを読み直すなら、その中は読み直さなくてよい
  const keys = [...dirs.keys()].sort();
  const keep: string[] = [];
  for (const k of keys) if (!keep.some((a) => k.startsWith(a + "/"))) keep.push(k);
  if (keep.length > MAX_DIRS) return "all";
  return keep.map((k) => dirs.get(k)!);
}

/** 構造が同じか（同じなら再描画しない） */
export function sameEntries(a: Entry[], b: Entry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.name !== y.name || x.is_dir !== y.is_dir) return false;
    if (x.is_dir && !sameEntries(x.children, y.children)) return false;
  }
  return true;
}

/**
 * dir の中身を children に差し替えたツリー（変わらない部分は同じオブジェクトのまま）。
 * dir がツリーに見つからなければ null。
 */
export function spliceTree(tree: Entry[], dir: string, children: Entry[]): Entry[] | null {
  const target = pathKey(dir);
  let found = false;
  const visit = (es: Entry[]): Entry[] => {
    let changed = false;
    const out = es.map((e) => {
      if (!e.is_dir) return e;
      const k = pathKey(e.path);
      if (k === target) {
        found = true;
        if (sameEntries(e.children, children)) return e;
        changed = true;
        return { ...e, children };
      }
      if (target.startsWith(k + "/")) {
        const next = visit(e.children);
        if (next !== e.children) {
          changed = true;
          return { ...e, children: next };
        }
      }
      return e;
    });
    return changed ? out : es;
  };
  const next = visit(tree);
  return found ? next : null;
}
