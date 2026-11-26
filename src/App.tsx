import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Group, Layout, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree, { ExplorerControls } from "./components/FileTree";
import Pane, { type PaneCommand, type PaneOutline } from "./components/Pane";
import Outline from "./components/Outline";
import StatusBar from "./components/StatusBar";
import WindowBar from "./components/WindowBar";
import SettingsDialog from "./components/SettingsDialog";
import { useGitStatus } from "./lib/git";
import { ContextMenu, type MenuItem, useUnsavedDialog } from "./components/Dialogs";
import { DEFAULT_SETTINGS, useSettings } from "./lib/settings";
import { Entry, cancelQuit, dirname, loadSession, norm, openNewWindow, printWindow, readDirs, readText, readTree, saveSession, statPaths, takePendingOpens, watchFiles, watchFolder, writeText } from "./lib/api";
import { type FsChange, changeMatcher, dirsToReread, indexTree, irrelevantForTree, matchedAncestor, pathKey, sameEntries, spliceTree } from "./lib/liveReload";
import { renderAllPending } from "./lib/markdown";
import { type DragItem, type DropTarget, setDropHandler, setTabCountReader, useDragPos, useDrag } from "./lib/dnd";
import { type LayoutNode, type PresetLayout, type Side, PRESET_COUNT, leaves, newNodeId, presetLayout, removeLeaf, setSizes, splitLeaf } from "./lib/layout";
import {
  type DiffTab,
  type DocTab,
  type PaneState,
  type SavedPane,
  type SavedTab,
  type Session,
  type Tab,
  type ViewMode,
  activeTab,
  defaultSession,
  emptyPane,
  isDirty,
  migrateSession,
  newId,
  tabTitle,
} from "./lib/tabs";

/** 保存しておいた状態を読む。壊れていたら初期状態から始める。 */
async function restoreSession(): Promise<Session> {
  try {
    const raw = await loadSession();
    const s = migrateSession(raw ? JSON.parse(raw) : null) ?? migrateSession(JSON.parse(localStorage.getItem("mdock.session") ?? "null"));
    if (s) return s;
  } catch (e) {
    console.warn("session", e);
  }
  return defaultSession();
}

/** ペインの集まりと、その並べ方（分割ツリー） */
type Workspace = { panes: Record<string, PaneState>; layout: LayoutNode };

const newPaneId = () => newNodeId("p");
const mapPanes = (w: Workspace, fn: (p: PaneState, id: string) => PaneState): Workspace => {
  const panes: Record<string, PaneState> = {};
  for (const [id, p] of Object.entries(w.panes)) panes[id] = fn(p, id);
  return { ...w, panes };
};
const allTabs = (w: Workspace) => Object.values(w.panes).flatMap((p) => p.tabs);
/** 開いているファイル（差分の左右も含む、重複なし） */
const filesOf = (w: Workspace) => [...new Set(allTabs(w).flatMap((t) => (t.kind === "doc" ? [t.path] : [t.left, t.right])))];
/** すべてのタブに fn を当てる。どのタブも変わらなければ元の w を返す（再描画しない） */
const mapTabs = (w: Workspace, fn: (t: Tab) => Tab): Workspace => {
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
const activeAfterRemove = (active: number, removedAt: number, len: number) =>
  Math.max(0, removedAt < active ? active - 1 : Math.min(active, len - 1));
const cloneTab = (t: Tab): Tab => ({ ...t, id: newId(), ...(t.kind === "doc" ? { anchor: undefined } : {}) });

/**
 * タブがなくなったペインを消す（隣が広がる）。最後の 1 ペインは残す。
 * 消したときは、代わりに前面にするペイン（直前、なければ直後）を返す。
 */
function dropIfEmpty(w: Workspace, id: string): { w: Workspace; neighbor?: string } {
  const order = leaves(w.layout);
  if (w.panes[id]?.tabs.length || order.length <= 1 || !order.includes(id)) return { w };
  const k = order.indexOf(id);
  const { [id]: _gone, ...panes } = w.panes;
  return { w: { layout: removeLeaf(w.layout, id), panes }, neighbor: order[k - 1] ?? order[k + 1] };
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTreeState] = useState<Entry[]>([]);
  /** ツリーの最新の状態（非同期の部分更新で、古いツリーに上書きしないため） */
  const treeRef = useRef<Entry[]>([]);
  const setTree = useCallback((t: Entry[]) => {
    treeRef.current = t;
    setTreeState(t);
  }, []);
  const [ws, setWs] = useState<Workspace>(() => ({ panes: { p0: emptyPane() }, layout: { type: "pane", id: "p0" } }));
  const [activeIdx, setActiveIdx] = useState("p0");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<string, PaneCommand>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const git = useGitStatus(root, settings.gitStatus, settings.statusBar);
  const [outline, setOutline] = useState<PaneOutline>();
  const [watchedRoot, setWatchedRoot] = useState<string | null>(null);
  const [watchedFiles, setWatchedFiles] = useState("");
  const watchRequest = useRef(0);
  const startWatchingFolder = useCallback(async (dir: string) => {
    const request = ++watchRequest.current;
    setWatchedRoot(null);
    await watchFolder(dir);
    if (request === watchRequest.current) setWatchedRoot(dir);
  }, []);
  const { ask, dialog } = useUnsavedDialog();
  /** サイドバーとペイン全体の幅 */
  const sidebarLayout = useRef<Session["sidebar"]>(undefined);
  const sidebarPanel = useRef<PanelImperativeHandle>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** タブごとのスクロール位置（タブ ID → px） */
  const scrolls = useRef(new Map<string, number>());

  // イベントハンドラから最新の状態を読むための参照
  // ペインの状態は ref を正とし、変えるときは apply で ref と state を同時に更新する
  // （非同期の処理が続けて変更しても、古い状態で上書きしないように）
  const wsRef = useRef(ws);
  const apply = useCallback((fn: (w: Workspace) => Workspace) => {
    const next = fn(wsRef.current);
    if (next === wsRef.current) return;
    wsRef.current = next;
    setWs(next);
  }, []);
  const rootRef = useRef(root);
  rootRef.current = root;
  const activeRef = useRef(activeIdx);

  const order = leaves(ws.layout);

  const updatePane = (id: string, fn: (p: PaneState) => PaneState) =>
    apply((w) => (w.panes[id] ? { ...w, panes: { ...w.panes, [id]: fn(w.panes[id]) } } : w));
  const updateActiveTab = (id: string, fn: (t: Tab) => Tab) =>
    updatePane(id, (p) => ({ ...p, tabs: p.tabs.map((t, k) => (k === p.active ? fn(t) : t)) }));

  /** ペインを前面にする */
  const focusPane = useCallback((id: string) => {
    activeRef.current = id;
    setActiveIdx(id);
  }, []);
  /** 存在するペイン（消えていれば前面のペイン、それもなければ先頭） */
  const livePane = (id: string) => {
    const w = wsRef.current;
    return w.panes[id] ? id : w.panes[activeRef.current] ? activeRef.current : leaves(w.layout)[0];
  };

  /** target のペインの side 側に新しいペインを作り、tabs を入れる。新しいペインの ID を返す */
  const splitWith = (target: string, side: Side, tabs: Tab[]) => {
    const id = newPaneId();
    apply((w) => ({
      layout: splitLeaf(w.layout, w.panes[target] ? target : leaves(w.layout)[0], side, id),
      panes: { ...w.panes, [id]: { tabs, active: 0 } },
    }));
    focusPane(id);
    return id;
  };

  /**
   * ファイルを開く。既にそのペインで開いていればそのタブへ。
   * そうでなければ今のタブで開く（未保存の変更がある・差分・newTab のときは新しいタブ）。
   * split を指定すると、そのペインの横（上下）に新しいペインを作って開く。at はタブを入れる位置。
   */
  const openFile = useCallback(
    async (path: string, paneId: string, opts: { newTab?: boolean; anchor?: string; split?: Side; at?: number } = {}) => {
      const anchor = opts.anchor ? { id: opts.anchor, nonce: Date.now() } : undefined;
      const has = (p: PaneState | undefined) => (p ? p.tabs.findIndex((t) => t.kind === "doc" && t.path === path) : -1);
      const read = async () => {
        try {
          return await readText(path);
        } catch (e) {
          setError(`開けませんでした: ${e}`);
          return null;
        }
      };
      const makeTab = (text: string): DocTab => ({ id: newId(), kind: "doc", path, content: text, saved: text, mode: "view", anchor });
      if (opts.split) {
        const text = await read();
        if (text === null) return;
        splitWith(paneId, opts.split, [makeTab(text)]);
        setError(null);
        return;
      }
      if (has(wsRef.current.panes[livePane(paneId)]) < 0) {
        const text = await read();
        if (text === null) return;
        const id = livePane(paneId);
        updatePane(id, (p) => {
          const k = has(p);
          if (k >= 0) return { ...p, active: k };
          const tab = makeTab(text);
          const cur = p.tabs[p.active];
          if (!opts.newTab && opts.at === undefined && cur?.kind === "doc" && !isDirty(cur)) {
            scrolls.current.delete(cur.id);
            return { ...p, tabs: p.tabs.map((t, i) => (i === p.active ? tab : t)) };
          }
          const at = Math.max(0, Math.min(opts.at ?? (p.tabs.length ? p.active + 1 : 0), p.tabs.length));
          return { tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)], active: at };
        });
        focusPane(id);
      } else {
        const id = livePane(paneId);
        updatePane(id, (p) => {
          const k = has(p);
          return { ...p, active: k, tabs: p.tabs.map((t, i) => (i === k && anchor && t.kind === "doc" ? { ...t, anchor } : t)) };
        });
        focusPane(id);
      }
      setError(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusPane],
  );

  /** 未保存のタブがあれば確認する。true なら続けてよい */
  const confirmDirty = useCallback(
    async (tabs: Tab[]): Promise<boolean> => {
      const dirty = tabs.filter(isDirty);
      if (!dirty.length) return true;
      const c = await ask(
        dirty.length === 1 ? `「${tabTitle(dirty[0])}」の変更を保存しますか？` : `${dirty.length} 個のファイルに未保存の変更があります。保存しますか？`,
        "保存しないと、変更は失われます。",
      );
      if (c === "cancel") return false;
      if (c === "save") {
        for (const t of dirty) if (!(await saveTab(t.id))) return false;
      }
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask],
  );

  /** すべてのタブを閉じる（分割の形はそのまま） */
  const clearTabs = useCallback(() => {
    apply((w) => mapPanes(w, () => emptyPane()));
    scrolls.current.clear();
  }, [apply]);

  /** フォルダのツリーを読み込み、監視を開始する */
  const openFolder = useCallback(async (dir: string, replaceTabs = false) => {
    try {
      const entries = await readTree(dir);
      if (replaceTabs) {
        if (!(await confirmDirty(allTabs(wsRef.current)))) return;
        clearTabs();
      }
      setRoot(dir);
      setTree(entries);
      await startWatchingFolder(dir);
      setError(null);
    } catch (e) {
      setError(`フォルダを開けませんでした: ${e}`);
    }
  }, [clearTabs, confirmDirty, setTree, startWatchingFolder]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") await openFolder(dir, true);
  };

  /** タブを保存する。同じファイルを開いているほかのタブ（未編集のもの）にも反映する */
  const saveTab = useCallback(async (tabId: string): Promise<boolean> => {
    const t = allTabs(wsRef.current).find((x) => x.id === tabId);
    if (!t || t.kind !== "doc") return true;
    if (t.content === t.saved) return true;
    const text = t.content;
    try {
      await writeText(t.path, text);
    } catch (e) {
      setError(`保存できませんでした: ${e}`);
      return false;
    }
    apply((w) =>
      mapPanes(w, (p) => ({
      ...p,
      tabs: p.tabs.map((x): Tab => {
        if (x.kind === "doc" && x.path === t.path) {
          const clear = { external: undefined, deleted: false };
          if (x.id === tabId) return { ...x, saved: text, ...clear };
          if (x.content === x.saved) return { ...x, content: text, saved: text, ...clear };
          return { ...x, saved: text, ...clear };
        }
        if (x.kind === "diff" && (x.left === t.path || x.right === t.path)) {
          return { ...x, ...(x.left === t.path ? { leftText: text } : {}), ...(x.right === t.path ? { rightText: text } : {}) };
        }
        return x;
      }),
      })),
    );
    return true;
  }, [apply]);

  /** ペインを消して（タブがなければ）、隣のペインを前面にする */
  const commitRemoveIfEmpty = (w: Workspace, id: string): Workspace => {
    const r = dropIfEmpty(w, id);
    if (r.neighbor && activeRef.current === id) focusPane(r.neighbor);
    return r.w;
  };

  const removeTab = (paneId: string, tabId: string) => {
    scrolls.current.delete(tabId);
    apply((w) => {
      const p = w.panes[paneId];
      const k = p?.tabs.findIndex((t) => t.id === tabId) ?? -1;
      if (k < 0) return w;
      const tabs = p.tabs.filter((t) => t.id !== tabId);
      const next = { ...w, panes: { ...w.panes, [paneId]: { tabs, active: activeAfterRemove(p.active, k, tabs.length) } } };
      // 最後のタブを閉じたらペインも消す（隣が広がる）
      return commitRemoveIfEmpty(next, paneId);
    });
  };

  const closeTab = async (paneId: string, tabIdx: number) => {
    const t = wsRef.current.panes[paneId]?.tabs[tabIdx];
    if (!t) return;
    if (!(await confirmDirty([t]))) return;
    removeTab(paneId, t.id);
  };

  /** ⌘W: 今のタブを閉じる。ペインが空なら（ほかにペインがあれば）ペインを閉じ、何もなければウィンドウを閉じる */
  const closeActiveTab = () => {
    const w = wsRef.current;
    const id = livePane(activeRef.current);
    const p = w.panes[id];
    if (p?.tabs.length) closeTab(id, p.active);
    else if (leaves(w.layout).length > 1) apply((x) => commitRemoveIfEmpty(x, id));
    else getCurrentWindow().close();
  };

  const closeOthers = async (paneId: string, keepIdx: number) => {
    const p = wsRef.current.panes[paneId];
    if (!p) return;
    const others = p.tabs.filter((_, i) => i !== keepIdx);
    if (!(await confirmDirty(others))) return;
    const keep = p.tabs[keepIdx];
    others.forEach((t) => scrolls.current.delete(t.id));
    updatePane(paneId, (q) => ({ tabs: q.tabs.filter((t) => t.id === keep.id), active: 0 }));
  };

  /**
   * タブを移動する（同じペイン内の並べ替え、ほかのペインへ、または新しいペインに分割して）。
   * 元のペインが空になったら、そのペインは消える。
   */
  const moveTab = (fromPane: string, tabId: string, to: { paneId: string; index?: number; split?: Side }) => {
    let dest = to.paneId;
    apply((w) => {
      const src = w.panes[fromPane];
      const k = src?.tabs.findIndex((t) => t.id === tabId) ?? -1;
      if (k < 0 || (!to.split && !w.panes[to.paneId])) return w;
      const tab = src.tabs[k];
      // 同じペインで、タブが 1 つしかないなら分割しない
      if (to.split && fromPane === to.paneId && src.tabs.length <= 1) return w;
      let layout = w.layout;
      const panes = { ...w.panes };
      const rest = src.tabs.filter((t) => t.id !== tabId);
      panes[fromPane] = { tabs: rest, active: activeAfterRemove(src.active, k, rest.length) };
      if (to.split) {
        dest = newPaneId();
        layout = splitLeaf(layout, to.paneId, to.split, dest);
        panes[dest] = { tabs: [tab], active: 0 };
      } else {
        const d = panes[dest];
        let at = to.index ?? d.tabs.length;
        if (fromPane === dest && k < at) at--;
        at = Math.max(0, Math.min(at, d.tabs.length));
        const tabs = [...d.tabs];
        tabs.splice(at, 0, tab);
        panes[dest] = { tabs, active: at };
      }
      let next: Workspace = { layout, panes };
      if (fromPane !== dest) next = dropIfEmpty(next, fromPane).w;
      return next;
    });
    if (wsRef.current.panes[dest]) focusPane(dest);
  };

  /** タブを複製して、そのペインの side 側の新しいペインに開く（⌘\ ・「右に分割」） */
  const splitTab = (paneId: string, side: Side) => {
    const t = activeTab(wsRef.current.panes[paneId] ?? emptyPane());
    const copy = t ? cloneTab(t) : null;
    if (copy && t) scrolls.current.set(copy.id, scrolls.current.get(t.id) ?? 0);
    splitWith(paneId, side, copy ? [copy] : []);
  };

  // ドラッグ＆ドロップ（タブ・ツリーのファイル）をペインに落としたとき
  const onDrop = (item: DragItem, target: DropTarget) => {
    const split = target.type === "pane" && target.zone !== "center" ? target.zone : undefined;
    if (item.kind === "tab") {
      if (target.type === "tabbar") moveTab(item.paneId, item.tabId, { paneId: target.paneId, index: target.index });
      else moveTab(item.paneId, item.tabId, { paneId: target.paneId, split });
    } else {
      if (target.type === "tabbar") openFile(item.path, target.paneId, { at: target.index });
      else openFile(item.path, target.paneId, split ? { split } : { newTab: true });
    }
  };
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    setDropHandler((item, target) => onDropRef.current(item, target));
    setTabCountReader((id) => wsRef.current.panes[id]?.tabs.length ?? 0);
  }, []);

  const cycleTab = (delta: number) =>
    updatePane(activeRef.current, (p) => (p.tabs.length ? { ...p, active: (p.active + delta + p.tabs.length) % p.tabs.length } : p));

  /** 「隣のペイン」: 画面上の順で次のペイン（最後なら先頭）。1 ペインなら null */
  const otherPane = (id: string): string | null => {
    const o = leaves(wsRef.current.layout);
    if (o.length < 2) return null;
    return o[(o.indexOf(id) + 1) % o.length];
  };

  /** このタブと、隣のペインで開いているファイルの差分を新しいタブで開く */
  const compareWithOther = (paneId: string, tabIdx: number) => {
    const op = otherPane(paneId);
    const a = wsRef.current.panes[paneId]?.tabs[tabIdx];
    const b = op ? activeTab(wsRef.current.panes[op]) : undefined;
    if (a?.kind !== "doc" || b?.kind !== "doc") return;
    const tab: DiffTab = { id: newId(), kind: "diff", left: a.path, right: b.path, leftText: a.content, rightText: b.content };
    updatePane(paneId, (p) => ({ tabs: [...p.tabs.slice(0, tabIdx + 1), tab, ...p.tabs.slice(tabIdx + 1)], active: tabIdx + 1 }));
    focusPane(paneId);
  };

  const openTabMenu = (paneId: string, tabIdx: number, x: number, y: number) => {
    const p = wsRef.current.panes[paneId];
    const t = p?.tabs[tabIdx];
    if (!t) return;
    const op = otherPane(paneId);
    const other = op ? activeTab(wsRef.current.panes[op]) : undefined;
    const canCompare = t.kind === "doc" && other?.kind === "doc";
    const splitThis = (side: Side) => {
      updatePane(paneId, (q) => ({ ...q, active: tabIdx }));
      splitTab(paneId, side);
    };
    setMenu({
      x,
      y,
      items: [
        { label: "閉じる", onClick: () => closeTab(paneId, tabIdx) },
        { label: "ほかのタブを閉じる", onClick: () => closeOthers(paneId, tabIdx), disabled: p.tabs.length < 2 },
        "sep",
        { label: "右に分割 (⌘\\)", onClick: () => splitThis("right") },
        { label: "下に分割", onClick: () => splitThis("bottom") },
        "sep",
        {
          label: canCompare ? `隣のペインと比較（${tabTitle(other!)}）` : "隣のペインと比較",
          onClick: () => compareWithOther(paneId, tabIdx),
          disabled: !canCompare,
        },
        op
          ? { label: "隣のペインへ移動", onClick: () => moveTab(paneId, t.id, { paneId: op }), disabled: false }
          : { label: "右に新しいペインを作って移動", onClick: () => moveTab(paneId, t.id, { paneId, split: "right" }), disabled: p.tabs.length < 2 },
      ],
    });
  };

  /** レイアウトのリセット（1画面 / 左右 / 上下 / 3分割）。入りきらないペインのタブは最後のペインに寄せる */
  const resetLayout = (kind: PresetLayout) => {
    let focus: string | undefined;
    apply((w) => {
      const o = leaves(w.layout);
      const n = PRESET_COUNT[kind];
      const cur = w.panes[activeRef.current] ? activeRef.current : o[0];
      const keep = kind === "single" ? [cur] : o.slice(0, n);
      const sink = keep[keep.length - 1];
      while (keep.length < n) keep.push(newPaneId());
      const panes: Record<string, PaneState> = {};
      for (const id of keep) panes[id] = w.panes[id] ?? emptyPane();
      const s = panes[sink];
      const tabs = [...s.tabs];
      for (const id of o) {
        if (keep.includes(id)) continue;
        for (const t of w.panes[id].tabs) {
          // 同じファイルを未編集で開いているだけなら、まとめる
          const dup = t.kind === "doc" && !isDirty(t) && tabs.some((x) => x.kind === "doc" && x.path === t.path);
          if (dup) scrolls.current.delete(t.id);
          else tabs.push(t);
        }
      }
      panes[sink] = { tabs, active: Math.min(s.active, Math.max(0, tabs.length - 1)) };
      if (!keep.includes(cur)) focus = sink;
      return { layout: presetLayout(kind, keep), panes };
    });
    if (focus) focusPane(focus);
  };

  // 起動時: 前回のフォルダ・タブ・表示モード・スクロール位置・未保存の編集を復元
  useEffect(() => {
    (async () => {
      const s = await restoreSession();
      sidebarLayout.current = s.sidebar;
      if (s.root) {
        try {
          setTree(await readTree(s.root));
          setRoot(s.root);
          startWatchingFolder(s.root).catch(() => {});
        } catch {
          /* フォルダが消えていた場合は何も開かない */
        }
      }
      const restoreTab = async (t: SavedTab): Promise<Tab | null> => {
        try {
          const id = newId();
          scrolls.current.set(id, t.scroll ?? 0);
          if (t.kind === "diff") {
            const [leftText, rightText] = await Promise.all([readText(t.left), readText(t.right)]);
            return { id, kind: "diff", left: t.left, right: t.right, leftText, rightText };
          }
          const text = await readText(t.path);
          const draft = t.draft !== undefined && t.draftBase === text ? t.draft : text;
          return { id, kind: "doc", path: t.path, content: draft, saved: text, mode: t.mode ?? "view" };
        } catch {
          return null; // ファイルが消えていたら、そのタブは開かない
        }
      };
      const restorePane = async (p: SavedPane | undefined): Promise<PaneState> => {
        if (!p?.tabs?.length) return emptyPane();
        const results = await Promise.all(p.tabs.map(restoreTab));
        // 消えたタブを除いたうえで、選んでいたタブの位置を合わせる
        const keptBefore = results.slice(0, p.active).filter(Boolean).length;
        const tabs = results.filter((t): t is Tab => !!t);
        return { tabs, active: Math.min(keptBefore, Math.max(0, tabs.length - 1)) };
      };
      const ids = leaves(s.layout);
      const restored = await Promise.all(ids.map((id) => restorePane(s.panes[id])));
      const panes: Record<string, PaneState> = {};
      ids.forEach((id, i) => (panes[id] = restored[i]));
      apply(() => ({ layout: s.layout, panes }));
      focusPane(ids.includes(s.activePane) ? s.activePane : ids[0]);
      setReady(true);
    })();
  }, []);

  // 状態をファイルに保存（変更から少し待ってまとめて書く）
  const saveTimer = useRef<number | undefined>(undefined);
  const persist = useCallback(() => {
    const saveTabState = (t: Tab): SavedTab => {
      const scroll = scrolls.current.get(t.id) ?? 0;
      if (t.kind === "diff") return { kind: "diff", left: t.left, right: t.right, scroll };
      return {
        path: t.path,
        mode: t.mode,
        scroll,
        ...(t.content !== t.saved ? { draft: t.content, draftBase: t.saved } : {}),
      };
    };
    const w = wsRef.current;
    const panes: Session["panes"] = {};
    for (const id of leaves(w.layout)) {
      const p = w.panes[id] ?? emptyPane();
      panes[id] = { tabs: p.tabs.map(saveTabState), active: p.active };
    }
    const s: Session = {
      version: 4,
      root: rootRef.current,
      panes,
      layout: w.layout,
      activePane: activeRef.current,
      ...(sidebarLayout.current ? { sidebar: sidebarLayout.current } : {}),
    };
    return saveSession(JSON.stringify(s)).catch((e) => console.warn("save session", e));
  }, []);
  const schedulePersist = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(persist, 400);
  }, [persist]);

  useEffect(() => {
    if (ready) schedulePersist();
  }, [ready, root, ws, activeIdx, schedulePersist]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    await persist();
    await saveWindowState(StateFlags.ALL).catch(() => {});
  }, [persist]);

  // 閉じるとき（⌘Q を含む）: 未保存の変更があれば「保存 / 保存しない / キャンセル」を確認してから閉じる
  const onCloseRef = useRef<(ev: { preventDefault: () => void }) => Promise<void>>(async () => {});
  onCloseRef.current = async (ev) => {
    const dirty = allTabs(wsRef.current).filter(isDirty);
    if (!dirty.length) {
      await flush();
      return;
    }
    ev.preventDefault();
    const c = await ask(
      dirty.length === 1 ? `「${tabTitle(dirty[0])}」の変更を保存しますか？` : `${dirty.length} 個のファイルに未保存の変更があります。保存しますか？`,
      "保存しないと、変更は失われます。",
    );
    if (c === "cancel") {
      cancelQuit().catch(() => {}); // ⌘Q の終了も取りやめる
      return;
    }
    if (c === "save") {
      for (const t of dirty)
        if (!(await saveTab(t.id))) {
          cancelQuit().catch(() => {});
          return;
        }
    } else {
      // 保存しない: 編集内容を捨ててから状態を書き出す（次に開いたとき復元しない）
      apply((w) => mapPanes(w, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === "doc" ? { ...t, content: t.saved } : t)) })));
    }
    await flush();
    await getCurrentWindow().destroy();
  };

  // ウィンドウを動かしたとき・閉じるときにも保存する
  useEffect(() => {
    const win = getCurrentWindow();
    let t: number | undefined;
    const saveWin = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => saveWindowState(StateFlags.ALL).catch(() => {}), 500);
    };
    const uns = [win.onMoved(saveWin), win.onResized(saveWin), win.onCloseRequested((ev) => onCloseRef.current(ev))];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);

  // ウィンドウタイトル
  useEffect(() => {
    const name = root ? norm(root).split("/").pop() : null;
    getCurrentWindow().setTitle(name ? `${name} — Mdock` : "Mdock").catch(() => {});
  }, [root]);

  // ---- 外部（AI・ほかのエディタ・git など）での変更の反映 ----

  /** パスごとの読み込みの世代（後から始めた読み込みの結果を優先し、古い結果で上書きしない） */
  const readGen = useRef(new Map<string, number>());

  /**
   * 開いているタブを読み直す（裏のタブ・ほかのペインも）。
   * 未保存の変更が無ければそのまま差し替え、あれば上書きせずに「外部で変更されました」を出す。
   * 削除されたら「削除されました」を出し、同名で作り直されたら戻す。名前の変更・移動も、同じ内容のファイルがあれば追う。
   */
  const reloadTabs = useCallback(
    async (change: FsChange) => {
      const match = changeMatcher(change);
      const targets = filesOf(wsRef.current).filter(match);
      if (!targets.length) return;
      const gens = targets.map((p) => {
        const g = (readGen.current.get(p) ?? 0) + 1;
        readGen.current.set(p, g);
        return g;
      });
      const results = await Promise.all(targets.map((p) => readText(p).catch(() => null)));
      const fresh = new Map<string, string>();
      const missing: string[] = [];
      targets.forEach((p, i) => {
        if (readGen.current.get(p) !== gens[i]) return; // もっと新しい読み込みが走っている
        const r = results[i];
        if (r === null) missing.push(p);
        else fresh.set(p, r);
      });
      // 読めなかったもの: 本当に消えたかを確かめる（権限などで読めないだけなら何もしない）
      let gone: string[] = [];
      if (missing.length) {
        const st = await statPaths(missing).catch(() => null);
        gone = st ? missing.filter((_, i) => !st[i]?.exists) : [];
      }
      // 名前の変更・移動: 同じ変更の中に、消えたファイルと同じ内容のファイルがあれば移動先とみなす
      const moved = new Map<string, string>();
      if (gone.length && !change.rescan) {
        const open = new Set(filesOf(wsRef.current).map(pathKey));
        const cands = change.paths.filter((c) => !open.has(pathKey(c))).slice(0, 20);
        for (const g of gone) {
          const tab = allTabs(wsRef.current).find((t): t is DocTab => t.kind === "doc" && t.path === g);
          const anc = tab && matchedAncestor(change.paths, g);
          if (!tab || !anc) continue;
          const rest = norm(g).slice(norm(anc).length); // フォルダごと動いたときの、その中での位置
          for (const c of cands) {
            if (pathKey(c) === pathKey(anc)) continue;
            const to = norm(c) + rest;
            if ([...moved.values()].includes(to)) continue;
            const text = await readText(to).catch(() => null);
            if (text !== null && text === tab.saved) {
              moved.set(g, to);
              break;
            }
          }
        }
      }
      if (!fresh.size && !gone.length) return;
      const goneSet = new Set(gone);
      apply((w) =>
        mapTabs(w, (t): Tab => {
          if (t.kind === "diff") {
            const l = fresh.get(t.left);
            const r = fresh.get(t.right);
            if ((l === undefined || l === t.leftText) && (r === undefined || r === t.rightText)) return t;
            return { ...t, leftText: l ?? t.leftText, rightText: r ?? t.rightText };
          }
          const to = moved.get(t.path);
          if (to) return { ...t, path: to, deleted: false };
          if (goneSet.has(t.path)) return t.deleted ? t : { ...t, deleted: true, external: undefined };
          const text = fresh.get(t.path);
          if (text === undefined) return t;
          const settled = !t.deleted && t.external === undefined;
          if (t.content === t.saved) {
            // 未保存の変更なし: そのまま差し替える（同じ内容なら何もしない＝描き直さない）
            if (text === t.saved && settled) return t;
            return { ...t, content: text, saved: text, deleted: false, external: undefined };
          }
          // 未保存の変更あり: 上書きしない
          if (text === t.content) return { ...t, saved: text, deleted: false, external: undefined }; // 外と同じ内容になった（自分の保存など）
          if (text === t.saved) return settled ? t : { ...t, deleted: false, external: undefined };
          return t.external === text && !t.deleted ? t : { ...t, external: text, deleted: false };
        }),
      );
    },
    [apply],
  );

  /** ツリーの部分更新の順番待ち（読み直している間に届いた変更は、終わってからまとめて読む） */
  const treeQueue = useRef({ paths: new Set<string>(), all: false, running: false });
  /** ツリーを読み直す。変更のあったフォルダだけ読み、全体は必要なときだけ。展開状態・選択・スクロール位置は保たれる */
  const refreshTreeFor = useCallback(
    async (change: FsChange) => {
      const q = treeQueue.current;
      const r0 = rootRef.current;
      if (!r0) return;
      if (change.rescan) q.all = true;
      else for (const p of change.paths) if (!irrelevantForTree(r0, p)) q.paths.add(p);
      if (q.running) return;
      q.running = true;
      try {
        while (q.all || q.paths.size) {
          const root = rootRef.current;
          if (!root) break;
          const all = q.all;
          const paths = [...q.paths];
          q.all = false;
          q.paths.clear();
          let plan: string[] | "all" = "all";
          if (!all) {
            const st = await statPaths(paths).catch(() => null);
            if (st) plan = dirsToReread(root, indexTree(treeRef.current), paths, new Map(paths.map((p, i) => [pathKey(p), st[i]])));
          }
          if (rootRef.current !== root) break;
          if (plan === "all") {
            const next = await readTree(root).catch(() => [] as Entry[]); // フォルダが消えたら空にする（戻れば読み直す）
            if (rootRef.current !== root) break;
            if (!sameEntries(treeRef.current, next)) setTree(next);
          } else if (plan.length) {
            const res = await readDirs(plan).catch(() => null);
            if (rootRef.current !== root) break;
            if (!res) {
              q.all = true;
              continue;
            }
            let t = treeRef.current;
            plan.forEach((d, i) => {
              const kids = res[i];
              const n = kids ? spliceTree(t, d, kids) : null;
              if (n) t = n;
              else q.all = true; // 見つからない・消えていた → 全体を読み直す
            });
            if (t !== treeRef.current) setTree(t);
          }
        }
      } finally {
        q.running = false;
      }
    },
    [setTree],
  );

  // 監視からの知らせ（変更から 100ms ほどで届く）
  useEffect(() => {
    const un = listen<FsChange>("fs-change", (ev) => {
      const change = { paths: ev.payload.paths ?? [], rescan: !!ev.payload.rescan };
      reloadTabs(change);
      refreshTreeFor(change);
    });
    return () => {
      un.then((f) => f());
    };
  }, [reloadTabs, refreshTreeFor]);

  // 開いているファイルを監視側に伝える（開いたフォルダの外のファイルも監視するため）
  const watchKey = filesOf(ws).sort().join("\n");
  useEffect(() => {
    if (!ready) return;
    let current = true;
    watchFiles(watchKey ? watchKey.split("\n") : []).then(
      () => { if (current) setWatchedFiles(watchKey); },
      () => { if (current) setWatchedFiles(""); },
    );
    return () => { current = false; };
  }, [watchKey, ready, root]);

  // 取りこぼし対策: ウィンドウに戻ってきたら、開いているファイル（更新時刻とサイズ）とツリーを確かめ直す
  const known = useRef(new Map<string, string>());
  const lastTreeCheck = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const recheck = async () => {
      const paths = filesOf(wsRef.current);
      if (paths.length) {
        const st = await statPaths(paths).catch(() => null);
        if (st) {
          const changed = paths.filter((p, i) => {
            const sig = st[i]?.exists ? `${st[i].mtime}:${st[i].size}` : "gone";
            const k = pathKey(p);
            const old = known.current.get(k);
            known.current.set(k, sig);
            return old !== sig;
          });
          if (changed.length) reloadTabs({ paths: changed, rescan: false });
        }
      }
      const now = Date.now();
      if (now - lastTreeCheck.current > 2000) {
        lastTreeCheck.current = now;
        refreshTreeFor({ paths: [], rescan: true });
      }
    };
    recheck(); // 今の状態を覚えておく
    const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && recheck());
    const onVis = () => document.visibilityState === "visible" && recheck();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      un.then((f) => f());
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, reloadTabs, refreshTreeFor]);

  // フォルダ・ファイルのドラッグ&ドロップ
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (ev) => {
      if (ev.payload.type !== "drop" || !ev.payload.paths.length) return;
      const p = ev.payload.paths[0];
      try {
        await readTree(p);
      } catch {
        // フォルダでなければファイルとして新しいタブで開く
        openFile(p, activeRef.current, { newTab: true });
        return;
      }
      openFolder(p, true);
    });
    return () => {
      un.then((f) => f());
    };
  }, [openFolder, openFile]);

  const refreshTree = useCallback(() => {
    const r = rootRef.current;
    if (r) readTree(r).then(setTree).catch(() => {});
  }, []);

  /** ツリーで名前を変えたら、そのファイル（フォルダならその中）を開いているタブのパスも直す */
  const onRenamed = (from: string, to: string) => {
    const move = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    apply((w) =>
      mapPanes(w, (p) => ({
        ...p,
        tabs: p.tabs.map((t): Tab => (t.kind === "doc" ? { ...t, path: move(t.path) } : { ...t, left: move(t.left), right: move(t.right) })),
      })),
    );
  };

  /**
   * 印刷 / PDF に書き出し: そのペインのプレビューだけを、ライト配色で印刷する。
   * 編集中なら表示モードにし、まだ描いていないコード・図・画像を先に描いてから印刷ダイアログを出す。
   */
  const printPane = async (i: string) => {
    const p = wsRef.current.panes[i];
    const t = p && activeTab(p);
    if (t?.kind !== "doc") return;
    focusPane(i);
    if (t.mode === "edit") updateActiveTab(i, (x) => (x.kind === "doc" ? { ...x, mode: "view" } : x));
    await new Promise((r) => setTimeout(r, 150));
    const body = document.querySelector<HTMLElement>(`.pane[data-pane="${i}"] .markdown-body`);
    if (body) await renderAllPending(body);
    try {
      await printWindow();
    } catch {
      window.print();
    }
  };

  /** Finder から開かれたファイル・フォルダ（関連付け・このアプリで開く）。フォルダ未選択なら親フォルダをルートにする */
  const openPaths = async () => {
    const paths = await takePendingOpens().catch(() => [] as string[]);
    for (const p of paths) {
      let isDir = false;
      try {
        await readTree(p);
        isDir = true;
      } catch {
        /* ファイル */
      }
      if (isDir) {
        if (!(await confirmDirty(allTabs(wsRef.current)))) continue;
        clearTabs();
        await openFolder(p);
      } else {
        if (!rootRef.current) await openFolder(dirname(p));
        await openFile(p, activeRef.current, { newTab: true });
      }
    }
  };
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;
  useEffect(() => {
    if (!ready) return;
    openPathsRef.current();
    const un = getCurrentWindow().listen("open-paths", () => openPathsRef.current());
    return () => {
      un.then((f) => f());
    };
  }, [ready]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const toggleMode = (i: string) =>
    updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, mode: t.mode === "view" ? "edit" : "view" } : t));

  const findInPane = (i: string) => setCommands((cs) => ({ ...cs, [i]: { type: "find", n: (cs[i]?.n ?? 0) + 1 } }));

  // メニュー（⌘W・⌘O・⌘S など）から呼ばれる操作。最新の状態を使うため ref 経由で呼ぶ
  const actions = useRef<Record<string, () => void>>({});
  actions.current = {
    "open-folder": pickFolder,
    save: () => {
      const p = wsRef.current.panes[activeRef.current];
      const t = p && activeTab(p);
      if (t) saveTab(t.id);
    },
    "close-tab": closeActiveTab,
    print: () => printPane(activeRef.current),
    settings: () => setSettingsOpen(true),
  };
  useEffect(() => {
    const un = getCurrentWindow().listen<string>("menu", (ev) => actions.current[ev.payload]?.());
    return () => {
      un.then((f) => f());
    };
  }, []);

  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const i = livePane(activeRef.current);
      if (k === "," && !e.shiftKey) {
        // ⌘,: 設定（メニューのショートカットが先に受け取ることが多いが、念のため）
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.shiftKey && (k === "[" || k === "{" || k === "]" || k === "}")) {
        // ⌘⇧[ / ⌘⇧] でタブを移動
        e.preventDefault();
        cycleTab(k === "[" || k === "{" ? -1 : 1);
      } else if (k === "f" && !e.shiftKey) {
        // CodeMirror が自分で処理した場合（エディタにフォーカスがある）は何もしない
        if (e.defaultPrevented) return;
        e.preventDefault();
        findInPane(i);
      } else if (k === "=" || k === "+" || k === ";") {
        // ⌘+（JIS キーボードでは ⌘; の位置）で文字を大きく
        e.preventDefault();
        updateSettings((s) => ({ fontSize: s.fontSize + 1 }));
      } else if (k === "-") {
        e.preventDefault();
        updateSettings((s) => ({ fontSize: s.fontSize - 1 }));
      } else if (k === "0") {
        e.preventDefault();
        updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
      } else if (k === "s") {
        e.preventDefault();
        actions.current.save();
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        openNewWindow().catch((err) => setError(String(err)));
      } else if (k === "o") {
        e.preventDefault();
        pickFolder();
      } else if (k === "w") {
        e.preventDefault();
        closeActiveTab();
      } else if (k === "e") {
        e.preventDefault();
        if (activeTab(wsRef.current.panes[i] ?? emptyPane())?.kind === "doc") toggleMode(i);
      } else if (k === "\\" && !e.shiftKey) {
        // ⌘\: 今のペインを右に分割（今のタブを複製して開く）
        e.preventDefault();
        splitTab(i, "right");
      } else if (/^[1-9]$/.test(k) && !e.shiftKey && !e.altKey) {
        // ⌘1〜⌘9: 画面上の順で n 番目のペインへ。1 つ先なら右端に新しいペインを作る（VS Code と同じ）
        e.preventDefault();
        const o = leaves(wsRef.current.layout);
        const n = Number(k) - 1;
        if (n < o.length) focusPane(o[n]);
        else if (n === o.length) splitWith(o[o.length - 1], "right", []);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ツリーのクリック: 今のペインのタブで開く。⌘+クリックは隣のペイン（1 ペインなら右に分割）、⌥+クリックは新しいタブ */
  const onTreeOpen = (path: string, otherPaneClick: boolean, newTab: boolean) => {
    const cur = livePane(activeRef.current);
    if (!otherPaneClick) openFile(path, cur, { newTab });
    else {
      const op = otherPane(cur);
      openFile(path, op ?? cur, op ? { newTab } : { split: "right" });
    }
  };

  const renderPane = (i: string) => (
    <Pane
      key={i}
      idx={i}
      pane={ws.panes[i] ?? emptyPane()}
      active={activeIdx === i}
      onOutline={setOutline}
      rootDir={root}
      command={commands[i]}
      scrollOf={(id) => scrolls.current.get(id) ?? 0}
      onScroll={(id, top) => {
        scrolls.current.set(id, top);
        schedulePersist();
      }}
      onFocus={() => activeRef.current !== i && focusPane(i)}
      onActivateTab={(k) => updatePane(i, (p) => ({ ...p, active: k }))}
      onCloseTab={(k) => closeTab(i, k)}
      onTabMenu={(k, x, y) => openTabMenu(i, k, x, y)}
      onChange={(content) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, content } : t))}
      onMode={(mode: ViewMode) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, mode } : t))}
      onSave={() => {
        const p = wsRef.current.panes[i];
        const t = p && activeTab(p);
        if (t) saveTab(t.id);
      }}
      onReloadExternal={() =>
        updateActiveTab(i, (t) =>
          t.kind === "doc" && t.external !== undefined ? { ...t, content: t.external, saved: t.external, external: undefined } : t,
        )
      }
      onKeepMine={() => updateActiveTab(i, (t) => (t.kind === "doc" && t.external !== undefined ? { ...t, saved: t.external, external: undefined } : t))}
      onOpenLink={(p, anchor, newTab) => openFile(p, i, { anchor, newTab })}
      onPrint={() => printPane(i)}
      printTarget={activeIdx === i}
    />
  );

  const currentTab = ws.panes[activeIdx] ? activeTab(ws.panes[activeIdx]) : undefined;
  const activeOutline = currentTab?.kind === "doc" && outline?.paneId === activeIdx &&
    outline.tabId === currentTab.id && outline.mode === currentTab.mode ? outline.outline : undefined;

  const visiblePaths = order
    .map((id) => ws.panes[id] && activeTab(ws.panes[id]))
    .flatMap((t) => (t?.kind === "doc" ? [t.path] : []));

  /** 分割の境界をドラッグして比率が変わったら、ツリーに書き戻す */
  const onSplitResized = (splitId: string, ids: string[]) => (l: Layout) => {
    const sizes = ids.map((id) => l[id]);
    if (sizes.some((x) => !(x >= 0))) return;
    apply((w) => {
      const next = setSizes(w.layout, splitId, sizes);
      const same = JSON.stringify(next) === JSON.stringify(w.layout);
      return same ? w : { ...w, layout: next };
    });
  };

  /** 分割ツリーを、入れ子の react-resizable-panels で描く */
  const renderNode = (n: LayoutNode): ReactNode => {
    if (n.type === "pane") return renderPane(n.id);
    const ids = n.children.map((c) => c.id);
    const horiz = n.dir === "row";
    return (
      <Group
        key={`${n.id}:${ids.join(",")}`}
        orientation={horiz ? "horizontal" : "vertical"}
        className="split-group"
        defaultLayout={Object.fromEntries(ids.map((id, i) => [id, n.sizes[i]]))}
        onLayoutChanged={onSplitResized(n.id, ids)}
      >
        {n.children.map((c, i) => [
          i > 0 && <Separator key={`sep-${c.id}`} className={horiz ? "sep" : "sep sep-h"} />,
          <Panel key={c.id} id={c.id} minSize={horiz ? 160 : 100}>
            {renderNode(c)}
          </Panel>,
        ])}
      </Group>
    );
  };

  return (
    <div className="app" style={{ "--doc-font-size": `${settings.fontSize}px` } as React.CSSProperties}>
      <WindowBar
        root={root}
        branch={git.branch}
        error={error}
        layout={ws.layout}
        sidebarOpen={sidebarOpen}
        ready={ready}
        onToggleSidebar={() => {
          const panel = sidebarPanel.current;
          if (panel?.isCollapsed()) panel.expand();
          else panel?.collapse();
        }}
        onPickFolder={pickFolder}
        onOpenFolder={(dir) => openFolder(dir, true)}
        onLayout={resetLayout}
        onSettings={() => setSettingsOpen(true)}
        beforeRestart={flush}
      />

      {ready && (
        <Group
          orientation="horizontal"
          className="main"
          defaultLayout={sidebarLayout.current}
          onLayoutChanged={(l) => {
            sidebarLayout.current = l;
            schedulePersist();
          }}
        >
          <Panel id="sidebar" defaultSize={264} minSize={248} maxSize={280} groupResizeBehavior="preserve-pixel-size" collapsible panelRef={sidebarPanel}
            onResize={(size) => setSidebarOpen(size.asPercentage > 0)}>
            <aside className="sidebar">
              {root ? (
                <FileTree
                  key={root}
                  root={root}
                  entries={tree}
                  openPaths={visiblePaths}
                  onOpen={onTreeOpen}
                  onChanged={refreshTree}
                  onRenamed={onRenamed}
                  onError={setError}
                  git={git.lookup}
                />
              ) : (
                <>
                  <ExplorerControls />
                  <div className="tree-empty">
                    <button className="btn" onClick={pickFolder}>フォルダを開く</button>
                    <small>ここにフォルダをドロップしても開けます</small>
                  </div>
                </>
              )}
              <Outline outline={activeOutline} />
            </aside>
          </Panel>
          <Separator className="sep" />
          <Panel id="panes" minSize={240}>
            {renderNode(ws.layout)}
          </Panel>
        </Group>
      )}
      {settings.statusBar && (
        <StatusBar
          live={root ? watchedRoot === root : !!watchKey && watchedFiles === watchKey}
          branch={git.branch}
          modified={git.modified}
          added={git.added}
          tab={currentTab}
          fontSize={settings.fontSize}
        />
      )}
      <DragGhost />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog}
      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
    </div>
  );
}

/** ドラッグ中、ポインタの横に出す札（何を動かしているか） */
function DragGhost() {
  const { item } = useDrag();
  const pos = useDragPos();
  if (!item) return null;
  return (
    <div className="drag-ghost" style={{ left: pos.x + 14, top: pos.y + 12 }}>
      {item.title}
    </div>
  );
}
