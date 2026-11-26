/**
 * ペインの分割レイアウト（入れ子の分割ツリー）。
 * 各ノードは「横並び / 縦並びの分割（子と比率）」か「ペイン」。
 */

export type Side = "left" | "right" | "top" | "bottom";

export type PaneNode = { type: "pane"; id: string };
export type SplitNode = {
  type: "split";
  id: string;
  /** row = 横並び（左右に分割）、col = 縦並び（上下に分割） */
  dir: "row" | "col";
  children: LayoutNode[];
  /** 子ごとの比率（%、合計 100） */
  sizes: number[];
};
export type LayoutNode = PaneNode | SplitNode;

export type PresetLayout = "single" | "cols2" | "rows2" | "cols3";
export const PRESET_COUNT: Record<PresetLayout, number> = { single: 1, cols2: 2, rows2: 2, cols3: 3 };

let seq = 0;
export const newNodeId = (prefix = "n") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** ペインの ID を、画面上の順（左上から）に並べる */
export function leaves(n: LayoutNode): string[] {
  return n.type === "pane" ? [n.id] : n.children.flatMap(leaves);
}

const even = (k: number) => Array.from({ length: k }, () => 100 / k);

/** 比率を合計 100 にそろえる */
function fit(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || sizes.some((s) => !(s >= 0))) return even(sizes.length);
  return sizes.map((s) => (s * 100) / sum);
}

/** 子が 1 つの分割はその子に置き換え、同じ向きの分割が入れ子になっていればまとめる */
function tidy(n: LayoutNode): LayoutNode {
  if (n.type === "pane") return n;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c0, i) => {
    const c = tidy(c0);
    const s = n.sizes[i] ?? 100 / n.children.length;
    if (c.type === "split" && c.dir === n.dir) {
      c.children.forEach((g, j) => {
        children.push(g);
        sizes.push((s * c.sizes[j]) / 100);
      });
    } else {
      children.push(c);
      sizes.push(s);
    }
  });
  if (children.length === 1) return children[0];
  return { ...n, children, sizes: fit(sizes) };
}

/** 一番外側の分割の向きを変え、同じ向きになった子の分割をまとめる */
export function flipOuter(root: LayoutNode, dir: "row" | "col"): LayoutNode {
  return root.type === "split" ? tidy({ ...root, dir }) : root;
}

/** target のペインの side 側に、新しいペイン newId を作る（target は半分の大きさになる） */
export function splitLeaf(root: LayoutNode, target: string, side: Side, newId: string): LayoutNode {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const leaf: PaneNode = { type: "pane", id: newId };
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") {
      if (n.id !== target) return n;
      return { type: "split", id: newNodeId("s"), dir, children: before ? [leaf, n] : [n, leaf], sizes: [50, 50] };
    }
    // 同じ向きの分割の直下なら、兄弟として隣に入れる
    const k = n.children.findIndex((c) => c.type === "pane" && c.id === target);
    if (k >= 0 && n.dir === dir) {
      const half = n.sizes[k] / 2;
      const children = [...n.children];
      const sizes = [...n.sizes];
      const at = before ? k : k + 1;
      sizes[k] = half;
      children.splice(at, 0, leaf);
      sizes.splice(at, 0, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return tidy(walk(root));
}

/** ペインを取り除く（隣のペインが広がる）。最後の 1 つは消さない */
export function removeLeaf(root: LayoutNode, id: string): LayoutNode {
  if (leaves(root).length <= 1) return root;
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n.type === "pane") return n.id === id ? null : n;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    let freed = 0;
    let freedAt = -1;
    n.children.forEach((c, i) => {
      const w = walk(c);
      if (w) {
        children.push(w);
        sizes.push(n.sizes[i]);
      } else {
        freed += n.sizes[i];
        freedAt = children.length; // 消えた子の右（下）隣の位置
      }
    });
    if (!children.length) return null;
    if (freedAt >= 0) {
      // 空いた分は直前の兄弟（なければ直後）に渡す
      const to = freedAt > 0 ? freedAt - 1 : 0;
      sizes[to] += freed;
    }
    return { ...n, children, sizes };
  };
  return tidy(walk(root) ?? root);
}

/** 分割ノードの比率を変える */
export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === "pane") return root;
  if (root.id === splitId) return root.sizes.length === sizes.length ? { ...root, sizes: fit(sizes) } : root;
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) };
}

/** 決まった形のレイアウト（リセット用）。ids の順にペインを並べる */
export function presetLayout(kind: PresetLayout, ids: string[]): LayoutNode {
  const panes: PaneNode[] = ids.map((id) => ({ type: "pane", id }));
  if (kind === "single" || panes.length === 1) return panes[0];
  return { type: "split", id: newNodeId("s"), dir: kind === "rows2" ? "col" : "row", children: panes, sizes: even(panes.length) };
}

/** 保存しておいたツリーを検査する（壊れていたら null） */
export function validLayout(n: any, seen = new Set<string>()): LayoutNode | null {
  if (!n || typeof n !== "object" || typeof n.id !== "string" || seen.has(n.id)) return null;
  seen.add(n.id);
  if (n.type === "pane") return { type: "pane", id: n.id };
  if (n.type !== "split" || (n.dir !== "row" && n.dir !== "col") || !Array.isArray(n.children) || !n.children.length) return null;
  const children: LayoutNode[] = [];
  for (const c of n.children) {
    const v = validLayout(c, seen);
    if (!v) return null;
    children.push(v);
  }
  const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length ? fit(n.sizes.map(Number)) : even(children.length);
  return tidy({ type: "split", id: n.id, dir: n.dir, children, sizes });
}
