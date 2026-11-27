/** ペインとタブの状態、セッション（session.json）の形式と移行 */

import { type LayoutNode, type PresetLayout, PRESET_COUNT, leaves as leavesOf, presetLayout, validLayout } from "./layout";
import type { DiskStamp, FileError, TextFormat, TextInfo, TextReadResult } from "./api";

import type { SearchLocation } from "./folderSearch";

export type ViewMode = "view" | "edit" | "split";

export const textFormat = (info: TextInfo): TextFormat & { lossy?: boolean; diskStamp: DiskStamp } => ({
  encoding: info.encoding === "UTF-8" ? undefined : info.encoding,
  bom: info.bom || undefined,
  lossy: info.lossy || undefined,
  diskStamp: info.diskStamp,
});

const sameStamp = (a: DiskStamp | undefined, b: DiskStamp) => a?.mtime === b.mtime && a.size === b.size;

export type DocTab = {
  id: string;
  kind: "doc";
  path: string;
  content: string;
  /** ディスク上の内容（未保存の判定に使う） */
  saved: string;
  mode: ViewMode;
  encoding?: string;
  bom?: boolean;
  /** BOM を編集した下書きの比較元 */
  savedBom?: boolean;
  diskStamp?: DiskStamp;
  lossy?: boolean;
  force?: boolean;
  readError?: FileError;
  /** 開いたら移動したい見出し（別ファイルの #見出し へのリンクから開いたとき） */
  anchor?: { id: string; nonce: number };
  line?: SearchLocation;
  scrollTo?: { top: number; nonce: number };
  /** ファイルが外部で削除された（同名で作り直されたら戻る） */
  deleted?: boolean;
  /** 未保存の変更があるときに、外部で書き換わった内容（再読み込みするか確認する） */
  external?: TextInfo;
  /** 外部で変更されたファイルを読み直せなかった理由 */
  externalReadError?: FileError;
};

export type DiffSide = "left" | "right";
export type DiffRead = { force?: boolean; error?: FileError };
export type DiffTab = {
  id: string;
  kind: "diff";
  left: string;
  right: string;
  leftText: string;
  rightText: string;
  reads?: Partial<Record<DiffSide, DiffRead>>;
};

export type Tab = DocTab | DiffTab;

/** ディスクから読み直した内容を、未保存の変更を残しながら反映する。 */
export function receiveDocText(tab: DocTab, info: TextInfo, force = tab.force): DocTab {
  const { text } = info;
  const format = textFormat(info);
  const clear = { ...format, force, deleted: false, readError: undefined, external: undefined, externalReadError: undefined };
  const bomEdited = tab.savedBom !== undefined && tab.savedBom !== !!tab.bom;
  const sameBaseBom = bomEdited ? tab.savedBom === info.bom : tab.bom === format.bom;
  const settled = !tab.deleted && !tab.readError && !tab.external && !tab.externalReadError && tab.force === force &&
    tab.encoding === format.encoding && sameBaseBom && tab.lossy === format.lossy &&
    sameStamp(tab.diskStamp, info.diskStamp);
  if (!isDirty(tab)) {
    return text === tab.saved && settled ? tab : { ...tab, ...clear, content: text, saved: text };
  }
  if (text === tab.content && !tab.readError && (!bomEdited || info.bom === !!tab.bom)) {
    return { ...tab, ...clear, saved: text, savedBom: undefined };
  }
  if (text === tab.saved && (!bomEdited || info.bom === tab.savedBom)) {
    return settled ? tab : { ...tab, ...clear, bom: bomEdited ? tab.bom : format.bom };
  }
  const external = tab.external;
  return !tab.deleted && !tab.readError && !tab.externalReadError && tab.force === force && external?.text === text &&
    external.encoding === info.encoding && external.bom === info.bom && external.lossy === info.lossy &&
    sameStamp(external.diskStamp, info.diskStamp)
    ? tab : { ...tab, force, external: info, deleted: false, readError: undefined, externalReadError: undefined };
}

export function receiveDiffText(tab: DiffTab, side: DiffSide, result: TextReadResult, force?: boolean): DiffTab {
  const key = side === "left" ? "leftText" : "rightText";
  const previous = tab.reads?.[side];
  if (result.info && tab[key] === result.info.text && !previous?.error && previous?.force === force) return tab;
  return {
    ...tab,
    [key]: result.info?.text ?? tab[key],
    reads: { ...tab.reads, [side]: { force, error: result.error } },
  };
}

export type PaneState = { tabs: Tab[]; active: number };

let seq = 0;
export const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export const emptyPane = (): PaneState => ({ tabs: [], active: 0 });
export const activeTab = (p: PaneState): Tab | undefined => p.tabs[p.active];
export const isDirty = (t: Tab | undefined): boolean => !!t && t.kind === "doc" &&
  (t.content !== t.saved || (t.savedBom !== undefined && t.savedBom !== !!t.bom));
export const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
export const tabTitle = (t: Tab) => (t.kind === "doc" ? baseName(t.path) : `${baseName(t.left)} ↔ ${baseName(t.right)}`);

// ---- セッション ----

export type SavedTab =
  | {
      kind?: "doc";
      path: string;
      mode: ViewMode;
      scroll: number;
      encoding?: string;
      bom?: boolean;
      force?: boolean;
      /** 未保存の編集内容（あれば） */
      draft?: string;
      /** draft を書き始めたときのディスク上の内容 */
      draftBase?: string;
      /** BOM を編集したときのディスク上の BOM の有無 */
      savedBom?: boolean;
    }
  | { kind: "diff"; left: string; right: string; scroll: number; force?: Partial<Record<DiffSide, boolean>> };

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
  /** サイドバーとペイン全体の幅（react-resizable-panels の Layout） */
  sidebar?: Record<string, number>;
};

export const defaultSession = (): Session => ({
  version: 4,
  root: null,
  panes: { p0: { tabs: [], active: 0 } },
  layout: { type: "pane", id: "p0" },
  activePane: "p0",
});

/** 版 3: 最大 3 ペインを決まった形（1画面 / 左右 / 上下 / 3分割）で並べていた */
type V3 = {
  version: 3;
  root: string | null;
  panes: SavedPane[];
  activeIdx: number;
  layout: PresetLayout;
  mdOnly?: boolean;
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
  mdOnly?: boolean;
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
      layouts,
    });
  }
  // 初期版（localStorage に保存していた頃）
  if (Array.isArray(s.paths)) {
    return migrateSession({
      version: 2,
      root: s.root ?? null,
      split: s.split,
      activeIdx: 0,
      layouts: {},
      panes: s.paths.map((path: string | null) => ({ path, mode: "view", scroll: 0 })),
    });
  }
  return null;
}
