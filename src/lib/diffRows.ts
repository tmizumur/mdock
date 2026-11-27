import { diffLines, type Change } from "diff";

type Cell = { n: number; text: string } | null;
export type Row = { left: Cell; right: Cell; kind: "same" | "change" | "del" | "add" };

const splitLines = (s: string) => {
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** 行単位の差分を、左右に並べる行の一覧にする（削除と追加が続くときは横に並べる） */
export function rowsFromChanges(changes: readonly Change[]): { rows: Row[]; added: number; removed: number } {
  const rows: Row[] = [];
  let ln = 1;
  let rn = 1;
  let added = 0;
  let removed = 0;
  let pending: string[] = [];
  const flush = () => {
    for (const text of pending) rows.push({ left: { n: ln++, text }, right: null, kind: "del" });
    pending = [];
  };
  for (const part of changes) {
    const lines = splitLines(part.value);
    if (part.removed) {
      flush();
      pending = lines;
      removed += lines.length;
    } else if (part.added) {
      added += lines.length;
      lines.forEach((text, i) => {
        const l = pending[i];
        if (l !== undefined) rows.push({ left: { n: ln++, text: l }, right: { n: rn++, text }, kind: "change" });
        else rows.push({ left: null, right: { n: rn++, text }, kind: "add" });
      });
      pending = pending.slice(lines.length);
      flush();
    } else {
      flush();
      for (const text of lines) rows.push({ left: { n: ln++, text }, right: { n: rn++, text }, kind: "same" });
    }
  }
  flush();
  return { rows, added, removed };
}

export function buildRows(a: string, b: string) {
  return rowsFromChanges(diffLines(a, b));
}

export function countLines(text: string): number {
  let count = text.length > 0 && !text.endsWith("\n") ? 1 : 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

export function isTooLarge(a: string, b: string): boolean {
  return a.length + b.length >= 4_000_000 || countLines(a) + countLines(b) >= 20_000;
}

export type Result = ReturnType<typeof rowsFromChanges> | { tooLarge: true } | { error: string };

export function computeRows(a: string, b: string): Result {
  try {
    if (isTooLarge(a, b)) return { tooLarge: true };
    const changes = diffLines(a, b, { timeout: 10_000 });
    return changes ? rowsFromChanges(changes) : { tooLarge: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type Item =
  | { type: "row"; row: Row }
  | { type: "fold"; id: number; start: number; end: number; count: number };

export function foldRows(rows: readonly Row[], context = 3, expanded?: ReadonlySet<number>): Item[] {
  const items: Item[] = [];
  const appendRows = (start: number, end: number) => {
    for (let i = start; i < end; i++) items.push({ type: "row", row: rows[i] });
  };

  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "same") {
      appendRows(index, index + 1);
      index++;
      continue;
    }

    const start = index;
    while (index < rows.length && rows[index].kind === "same") index++;
    const foldStart = start === 0 ? start : start + context;
    const foldEnd = index === rows.length ? index : index - context;
    const count = foldEnd - foldStart;

    if ((start === 0 && index === rows.length) || count <= 1 || expanded?.has(foldStart)) {
      appendRows(start, index);
    } else {
      appendRows(start, foldStart);
      items.push({ type: "fold", id: foldStart, start: foldStart, end: foldEnd, count });
      appendRows(foldEnd, index);
    }
  }
  return items;
}
