import { type LayoutNode, type PresetLayout, type SplitNode, PRESET_COUNT, flipOuter, leaves, newNodeId, presetLayout, removeLeaf } from "./layout";
import { type PaneState, type Tab, emptyPane, isDirty, newId } from "./tabs";

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
export const cloneTab = (t: Tab): Tab => ({ ...t, id: newId(), ...(t.kind === "doc" ? { anchor: undefined, line: undefined, scrollTo: undefined } : {}) });

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

/** タブを閉じ、前面のペインが消えたら隣を前面にする */
export function closeTabIn(w: Workspace, paneId: string, tabId: string, activePane: string): { w: Workspace; focus?: string } {
  const p = w.panes[paneId];
  const k = p?.tabs.findIndex((t) => t.id === tabId) ?? -1;
  if (k < 0) return { w };
  const tabs = p.tabs.filter((t) => t.id !== tabId);
  const next = { ...w, panes: { ...w.panes, [paneId]: { tabs, active: activeAfterRemove(p.active, k, tabs.length) } } };
  const r = dropIfEmpty(next, paneId);
  return { w: r.w, focus: activePane === paneId ? r.neighbor : undefined };
}

type PresetSplitIds = { panes: string[]; split: string };
type LayoutChange = { w: Workspace; focus?: string; discardedTabIds?: string[] };

/** 入りきらないペインのタブを最後のペインに寄せる */
export function resetLayoutIn(
  w: Workspace,
  activePane: string,
  split?: { kind: Exclude<PresetLayout, "single">; ids: PresetSplitIds },
): LayoutChange {
  const order = leaves(w.layout);
  const cur = w.panes[activePane] ? activePane : order[0];
  const keep = split ? order.slice(0, PRESET_COUNT[split.kind]) : [cur];
  const sink = keep[keep.length - 1];
  if (split) keep.push(...split.ids.panes);
  const panes: Record<string, PaneState> = {};
  for (const id of keep) panes[id] = w.panes[id] ?? emptyPane();
  const s = panes[sink];
  const tabs = [...s.tabs];
  const discardedTabIds: string[] = [];
  for (const id of order) {
    if (keep.includes(id)) continue;
    for (const t of w.panes[id].tabs) {
      // 同じファイルを未編集で開いているだけなら、まとめる
      const dup = t.kind === "doc" && !isDirty(t) && tabs.some((x) => x.kind === "doc" && x.path === t.path);
      if (dup) discardedTabIds.push(t.id);
      else tabs.push(t);
    }
  }
  panes[sink] = { tabs, active: Math.min(s.active, Math.max(0, tabs.length - 1)) };
  return {
    w: { layout: presetLayout(split?.kind ?? "single", keep, split?.ids.split), panes },
    focus: keep.includes(cur) ? undefined : sink,
    discardedTabIds,
  };
}

export function toggleSplitIn(w: Workspace, activePane: string, dir: SplitNode["dir"], ids?: PresetSplitIds): LayoutChange {
  if (w.layout.type === "pane") {
    return ids ? resetLayoutIn(w, activePane, { kind: dir === "row" ? "cols2" : "rows2", ids }) : { w };
  }
  if (w.layout.dir === dir) return resetLayoutIn(w, activePane);
  return { w: { ...w, layout: flipOuter(w.layout, dir) } };
}
