/** ペインとタブの状態、セッション（session.json）の形式と移行 */

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

export type SplitLayout = "single" | "cols2" | "rows2" | "cols3";

export const PANE_COUNT: Record<SplitLayout, number> = { single: 1, cols2: 2, rows2: 2, cols3: 3 };
export const MAX_PANES = 3;

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

export type Session = {
  version: 3;
  root: string | null;
  panes: SavedPane[];
  activeIdx: number;
  layout: SplitLayout;
  mdOnly: boolean;
  /** react-resizable-panels の幅（レイアウトごと） */
  layouts: Record<string, Record<string, number>>;
};

export const defaultSession = (): Session => ({
  version: 3,
  root: null,
  panes: [{ tabs: [], active: 0 }, { tabs: [], active: 0 }, { tabs: [], active: 0 }],
  activeIdx: 0,
  layout: "cols2",
  mdOnly: true,
  layouts: {},
});

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

/** 以前の形式（1ペイン1ファイル）から、タブ付きの形式に移す */
export function migrateSession(s: any): Session | null {
  if (!s || typeof s !== "object") return null;
  if (s.version === 3 && Array.isArray(s.panes)) {
    const d = defaultSession();
    const panes = [0, 1, 2].map((i) => s.panes[i] ?? { tabs: [], active: 0 });
    return { ...d, ...s, panes, layout: PANE_COUNT[s.layout as SplitLayout] ? s.layout : d.layout };
  }
  if (s.version === 2 && Array.isArray(s.panes)) {
    const v2 = s as V2;
    const panes: SavedPane[] = [0, 1, 2].map((i) => {
      const p = v2.panes[i];
      if (!p?.path) return { tabs: [], active: 0 };
      const { path, mode, scroll, draft, draftBase } = p;
      return { tabs: [{ path, mode: mode ?? "view", scroll: scroll ?? 0, draft, draftBase }], active: 0 };
    });
    const layouts: Session["layouts"] = {};
    if (v2.layouts?.split) layouts.cols2 = v2.layouts.split;
    if (v2.layouts?.single) layouts.single = v2.layouts.single;
    return {
      version: 3,
      root: v2.root ?? null,
      panes,
      activeIdx: v2.split ? v2.activeIdx ?? 0 : 0,
      layout: v2.split === false ? "single" : "cols2",
      mdOnly: v2.mdOnly ?? true,
      layouts,
    };
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
