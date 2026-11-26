/** アウトラインの絞り込みと折りたたみ（表示する行の計算） */

export type OutlineHeading = { level: number; text: string };

export type OutlineRow = {
  /** headings の中の位置 */
  index: number;
  /** 子の見出しがあるか（折りたためるか） */
  hasChildren: boolean;
  /** 絞り込みで一致していない親の見出し（階層がわかるよう薄く出す） */
  dim: boolean;
};

/** i 番目の見出しの直後から、その子孫（より深い見出し）が続く範囲の終わり（含まない） */
function subtreeEnd(headings: OutlineHeading[], i: number): number {
  let j = i + 1;
  while (j < headings.length && headings[j].level > headings[i].level) j++;
  return j;
}

/**
 * 表示する行。filter があれば、一致する見出しとその親だけ（折りたたみは無視）。
 * なければ、折りたたんだ見出しの子孫を隠す。
 */
export function outlineRows(headings: OutlineHeading[], filter: string, collapsed: ReadonlySet<number>): OutlineRow[] {
  const hasChildren = (i: number) => i + 1 < headings.length && headings[i + 1].level > headings[i].level;
  const q = filter.trim().toLowerCase();
  if (q) {
    const show = new Map<number, boolean>(); // index → 一致したか
    const parents: number[] = []; // 今の見出しの祖先（浅い順）
    headings.forEach((h, i) => {
      while (parents.length && headings[parents[parents.length - 1]].level >= h.level) parents.pop();
      if (h.text.toLowerCase().includes(q)) {
        for (const p of parents) if (!show.has(p)) show.set(p, false);
        show.set(i, true);
      }
      parents.push(i);
    });
    return [...show.keys()].sort((a, b) => a - b).map((index) => ({ index, hasChildren: hasChildren(index), dim: !show.get(index) }));
  }
  const rows: OutlineRow[] = [];
  for (let i = 0; i < headings.length; ) {
    rows.push({ index: i, hasChildren: hasChildren(i), dim: false });
    i = collapsed.has(i) ? subtreeEnd(headings, i) : i + 1;
  }
  return rows;
}

/** 今いる見出しが隠れていたら、表示されている一番近い祖先を返す（なければ -1） */
export function visibleCurrent(headings: OutlineHeading[], rows: OutlineRow[], current: number): number {
  if (current < 0) return -1;
  const shown = new Set(rows.map((r) => r.index));
  if (shown.has(current)) return current;
  let level = headings[current]?.level ?? 0;
  for (let i = current - 1; i >= 0; i--) {
    if (headings[i].level >= level) continue;
    if (shown.has(i)) return i;
    level = headings[i].level;
  }
  return -1;
}
