import { type LayoutNode, leaves, newNodeId, removeLeaf } from "./layout";
import { type PaneState, type Tab, newId } from "./tabs";

/** ペインの集まりと、その並べ方（分割ツリー） */
export type Workspace = { panes: Record<string, PaneState>; layout: LayoutNode };

export const newPaneId = () => newNodeId("p");
export const mapPanes = (w: Workspace, fn: (p: PaneState, id: string) => PaneState): Workspace => {
  const panes: Record<string, PaneState> = {};
  for (const [id, p] of Object.entries(w.panes)) panes[id] = fn(p, id);
  return { ...w, panes };
};
export const allTabs = (w: Workspace) => Object.values(w.panes).flatMap((p) => p.tabs);
/** 開いているファイル（差分の左右も含む、重複なし） */
export const filesOf = (w: Workspace) => [...new Set(allTabs(w).flatMap((t) => (t.kind === "doc" ? [t.path] : [t.left, t.right])))];
/** すべてのタブに fn を当てる。どのタブも変わらなければ元の w を返す（再描画しない） */
export const mapTabs = (w: Workspace, fn: (t: Tab) => Tab): Workspace => {
  let any = false;
  const panes: Record<string, PaneState> = {};
  for (const [id, p] of Object.entries(w.panes)) {
    let changed = false;
    const tabs = p.tabs.map((t) => {
      const n = fn(t);
      if (n !== t) changed = true;
      return n;
    });
    panes[id] = changed ? { ...p, tabs } : p;
    any ||= changed;
  }
  return any ? { ...w, panes } : w;
};
/** タブを取り除いた後の、前面のタブの位置 */
export const activeAfterRemove = (active: number, removedAt: number, len: number) =>
  Math.max(0, removedAt < active ? active - 1 : Math.min(active, len - 1));
export const cloneTab = (t: Tab): Tab => ({ ...t, id: newId(), ...(t.kind === "doc" ? { anchor: undefined } : {}) });

/**
 * タブがなくなったペインを消す（隣が広がる）。最後の 1 ペインは残す。
 * 消したときは、代わりに前面にするペイン（直前、なければ直後）を返す。
 */
export function dropIfEmpty(w: Workspace, id: string): { w: Workspace; neighbor?: string } {
  const order = leaves(w.layout);
  if (w.panes[id]?.tabs.length || order.length <= 1 || !order.includes(id)) return { w };
  const k = order.indexOf(id);
  const { [id]: _gone, ...panes } = w.panes;
  return { w: { layout: removeLeaf(w.layout, id), panes }, neighbor: order[k - 1] ?? order[k + 1] };
}
