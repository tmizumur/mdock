/** ペインとタブの状態、セッション（session.json）の形式と移行 */

import { type LayoutNode, type PresetLayout, PRESET_COUNT, leaves as leavesOf, presetLayout, validLayout } from "./layout";

export type ViewMode = "view" | "edit" | "split";

export type DocTab = {
  id: string;
  kind: "doc";
  path: string;
  content: string;
  /** ディスク上の内容（未保存の判定に使う） */
  saved: string;
  mode: ViewMode;
  /** 開いたら移動したい見出し（別ファイルの #見出し へのリンクから開いたとき） */
  anchor?: { id: string; nonce: number };
};

export type DiffTab = {
  id: string;
  kind: "diff";
  left: string;
  right: string;
  leftText: string;
  rightText: string;
};

export type Tab = DocTab | DiffTab;

export type PaneState = { tabs: Tab[]; active: number };

let seq = 0;
export const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export const emptyPane = (): PaneState => ({ tabs: [], active: 0 });
export const activeTab = (p: PaneState): Tab | undefined => p.tabs[p.active];
export const isDirty = (t: Tab | undefined): boolean => !!t && t.kind === "doc" && t.content !== t.saved;
export const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
export const tabTitle = (t: Tab) => (t.kind === "doc" ? baseName(t.path) : `${baseName(t.left)} ↔ ${baseName(t.right)}`);

// ---- セッション ----

export type SavedTab =
  | {
      kind?: "doc";
      path: string;
      mode: ViewMode;
      scroll: number;
      /** 未保存の編集内容（あれば） */
      draft?: string;
      /** draft を書き始めたときのディスク上の内容。ファイルが外で変わっていたら draft は捨てる */
      draftBase?: string;
    }
  | { kind: "diff"; left: string; right: string; scroll: number };

export type SavedPane = { tabs: SavedTab[]; active: number };

/** 版 4: 入れ子の分割ツリー。ペインは ID で持つ */
export type Session = {
  version: 4;
  root: string | null;
  /** ペイン ID → タブ */
  panes: Record<string, SavedPane>;
  /** 分割ツリー（比率を含む） */
  layout: LayoutNode;
  activePane: string;
  mdOnly: boolean;
  /** サイドバーとペイン全体の幅（react-resizable-panels の Layout） */
  sidebar?: Record<string, number>;
};

export const defaultSession = (): Session => ({
  version: 4,
  root: null,
  panes: { p0: { tabs: [], active: 0 } },
  layout: { type: "pane", id: "p0" },
  activePane: "p0",
  mdOnly: true,
});

/** 版 3: 最大 3 ペインを決まった形（1画面 / 左右 / 上下 / 3分割）で並べていた */
type V3 = {
  version: 3;
  root: string | null;
  panes: SavedPane[];
  activeIdx: number;
  layout: PresetLayout;
  mdOnly: boolean;
  layouts: Record<string, Record<string, number>>;
};

function fromV3(s: V3): Session {
  const kind: PresetLayout = PRESET_COUNT[s.layout] ? s.layout : "cols2";
  const n = PRESET_COUNT[kind];
  const saved = Array.isArray(s.panes) ? s.panes : [];
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const panes: Record<string, SavedPane> = {};
  ids.forEach((id, i) => (panes[id] = { tabs: [...(saved[i]?.tabs ?? [])], active: saved[i]?.active ?? 0 }));
  // 見えていなかったペインのタブは、最後のペインに寄せる（なくさない）
  const last = panes[ids[n - 1]];
  for (const p of saved.slice(n)) last.tabs.push(...(p?.tabs ?? []));
  const layout = presetLayout(kind, ids);
  const sizes = s.layouts?.[kind === "rows2" ? "rows2-v" : kind];
  if (layout.type === "split" && sizes) {
    const v = ids.map((id) => Number(sizes[`pane-${ids.indexOf(id)}`]));
    if (v.every((x) => x > 0)) layout.sizes = v;
  }
  const side = s.layouts?.[kind]?.sidebar;
  return {
    version: 4,
    root: s.root ?? null,
    panes,
    layout: validLayout(layout) ?? layout,
    activePane: ids[Math.min(Math.max(0, s.activeIdx ?? 0), n - 1)],
    mdOnly: s.mdOnly ?? true,
    ...(side > 0 ? { sidebar: { sidebar: side, panes: 100 - side } } : {}),
  };
}

type V2Pane = { path: string | null; mode: "view" | "edit"; scroll: number; draft?: string; draftBase?: string };
type V2 = {
  version: 2;
  root: string | null;
  panes: V2Pane[];
  activeIdx: number;
  split: boolean;
  mdOnly: boolean;
  layouts: { split?: Record<string, number>; single?: Record<string, number> };
};

/** 以前の形式から、今の形式（版 4）に移す */
export function migrateSession(s: any): Session | null {
  if (!s || typeof s !== "object") return null;
  if (s.version === 4) {
    const layout = validLayout(s.layout);
    if (!layout) return null;
    const ids = leavesOf(layout);
    const panes: Record<string, SavedPane> = {};
    for (const id of ids) {
      const p = s.panes?.[id];
      panes[id] = { tabs: Array.isArray(p?.tabs) ? p.tabs : [], active: Number(p?.active) || 0 };
    }
    return {
      version: 4,
      root: s.root ?? null,
      panes,
      layout,
      activePane: ids.includes(s.activePane) ? s.activePane : ids[0],
      mdOnly: s.mdOnly ?? true,
      ...(s.sidebar && typeof s.sidebar === "object" ? { sidebar: s.sidebar } : {}),
    };
  }
  if (s.version === 3 && Array.isArray(s.panes)) return fromV3(s as V3);
  if (s.version === 2 && Array.isArray(s.panes)) {
    const v2 = s as V2;
    const panes: SavedPane[] = [0, 1, 2].map((i) => {
      const p = v2.panes[i];
      if (!p?.path) return { tabs: [], active: 0 };
      const { path, mode, scroll, draft, draftBase } = p;
      return { tabs: [{ path, mode: mode ?? "view", scroll: scroll ?? 0, draft, draftBase }], active: 0 };
    });
    const layouts: V3["layouts"] = {};
    if (v2.layouts?.split) layouts.cols2 = v2.layouts.split;
    if (v2.layouts?.single) layouts.single = v2.layouts.single;
    return fromV3({
      version: 3,
      root: v2.root ?? null,
      panes,
      activeIdx: v2.split ? v2.activeIdx ?? 0 : 0,
      layout: v2.split === false ? "single" : "cols2",
      mdOnly: v2.mdOnly ?? true,
      layouts,
    });
  }
  // 初期版（localStorage に保存していた頃）
  if (Array.isArray(s.paths)) {
    return migrateSession({
      version: 2,
      root: s.root ?? null,
      split: s.split,
      mdOnly: s.mdOnly,
      activeIdx: 0,
      layouts: {},
      panes: s.paths.map((path: string | null) => ({ path, mode: "view", scroll: 0 })),
    });
  }
  return null;
}
