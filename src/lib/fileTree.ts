import { type Entry, norm } from "./api";

export type Creating = { dir: string; isDir: boolean };
export type Row =
  | { kind: "entry"; entry: Entry; depth: number; parent: string }
  | { kind: "create"; dir: string; isDir: boolean; depth: number };

export function isFolderOpen(path: string, depth: number, open: Record<string, boolean>, expandTop: boolean) {
  return open[path] ?? (expandTop && depth === 0);
}

export function treeRows(
  entries: Entry[],
  root: string,
  { open, expandTop, creating }: {
    open: Record<string, boolean>;
    expandTop: boolean;
    creating: Creating | null;
  },
): Row[] {
  const rows: Row[] = [];
  if (creating && norm(creating.dir) === norm(root)) rows.push({ kind: "create", dir: root, isDir: creating.isDir, depth: 0 });
  const walk = (list: Entry[], depth: number, parent: string) => {
    for (const entry of list) {
      rows.push({ kind: "entry", entry, depth, parent });
      if (entry.is_dir && isFolderOpen(entry.path, depth, open, expandTop)) {
        if (creating && creating.dir === entry.path) rows.push({ kind: "create", dir: entry.path, isDir: creating.isDir, depth: depth + 1 });
        walk(entry.children, depth + 1, entry.path);
      }
    }
  };
  walk(entries, 0, root);
  return rows;
}
