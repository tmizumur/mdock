import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Layout, Panel, Separator } from "react-resizable-panels";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Columns2, Columns3, Rows2, Square } from "lucide-react";
import FileTree from "./components/FileTree";
import UpdateButton from "./components/UpdateButton";
import Pane, { PaneCommand } from "./components/Pane";
import ViewMenu from "./components/ViewMenu";
import { ContextMenu, type MenuItem, useUnsavedDialog } from "./components/Dialogs";
import { DEFAULT_SETTINGS, useSettings } from "./lib/settings";
import { Entry, loadSession, norm, readText, readTree, saveSession, watchFolder, writeText } from "./lib/api";
import {
  type DiffTab,
  type DocTab,
  type PaneState,
  type SavedTab,
  type Session,
  type SplitLayout,
  type Tab,
  type ViewMode,
  MAX_PANES,
  PANE_COUNT,
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

const LAYOUTS: [SplitLayout, string, typeof Square][] = [
  ["single", "1画面", Square],
  ["cols2", "左右に2分割", Columns2],
  ["rows2", "上下に2分割", Rows2],
  ["cols3", "左右に3分割", Columns3],
];

/** ペイン i を表示できるレイアウト（今のレイアウトで見えなければ広げる） */
const layoutFor = (cur: SplitLayout, i: number): SplitLayout =>
  i < PANE_COUNT[cur] ? cur : i === 1 ? "cols2" : "cols3";

export default function App() {
  const [ready, setReady] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([emptyPane(), emptyPane(), emptyPane()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [layout, setLayout] = useState<SplitLayout>("cols2");
  const [mdOnly, setMdOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<(PaneCommand | undefined)[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const { ask, dialog } = useUnsavedDialog();
  const layouts = useRef<Session["layouts"]>({});
  /** タブごとのスクロール位置（タブ ID → px） */
  const scrolls = useRef(new Map<string, number>());

  // イベントハンドラから最新の状態を読むための参照
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const rootRef = useRef(root);
  rootRef.current = root;
  const activeRef = useRef(activeIdx);
  activeRef.current = activeIdx;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const mdOnlyRef = useRef(mdOnly);
  mdOnlyRef.current = mdOnly;

  const paneCount = PANE_COUNT[layout];

  const updatePane = (i: number, fn: (p: PaneState) => PaneState) => setPanes((ps) => ps.map((p, j) => (j === i ? fn(p) : p)));
  const updateActiveTab = (i: number, fn: (t: Tab) => Tab) =>
    updatePane(i, (p) => ({ ...p, tabs: p.tabs.map((t, k) => (k === p.active ? fn(t) : t)) }));

  /** ペインを前面にする（今のレイアウトで見えなければ分割を増やす） */
  const focusPane = useCallback((i: number) => {
    setLayout((l) => layoutFor(l, i));
    setActiveIdx(i);
  }, []);

  /**
   * ファイルを開く。既にそのペインで開いていればそのタブへ。
   * そうでなければ今のタブで開く（未保存の変更がある・差分・newTab のときは新しいタブ）。
   */
  const openFile = useCallback(
    async (path: string, idx: number, opts: { newTab?: boolean; anchor?: string } = {}) => {
      const anchor = opts.anchor ? { id: opts.anchor, nonce: Date.now() } : undefined;
      const has = (p: PaneState) => p.tabs.findIndex((t) => t.kind === "doc" && t.path === path);
      if (has(panesRef.current[idx]) < 0) {
        let text: string;
        try {
          text = await readText(path);
        } catch (e) {
          setError(`開けませんでした: ${e}`);
          return;
        }
        setPanes((ps) =>
          ps.map((p, j) => {
            if (j !== idx) return p;
            const k = has(p);
            if (k >= 0) return { ...p, active: k };
            const tab: DocTab = { id: newId(), kind: "doc", path, content: text, saved: text, mode: "view", anchor };
            const cur = p.tabs[p.active];
            if (!opts.newTab && cur?.kind === "doc" && !isDirty(cur)) {
              scrolls.current.delete(cur.id);
              return { ...p, tabs: p.tabs.map((t, i) => (i === p.active ? tab : t)) };
            }
            const at = p.tabs.length ? p.active + 1 : 0;
            return { tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)], active: at };
          }),
        );
      } else {
        updatePane(idx, (p) => {
          const k = has(p);
          return { ...p, active: k, tabs: p.tabs.map((t, i) => (i === k && anchor && t.kind === "doc" ? { ...t, anchor } : t)) };
        });
      }
      focusPane(idx);
      setError(null);
    },
    [focusPane],
  );

  /** フォルダを開く（ツリー読み込み + 監視開始） */
  const openFolder = useCallback(async (dir: string) => {
    try {
      const entries = await readTree(dir);
      setRoot(dir);
      setTree(entries);
      await watchFolder(dir);
      setError(null);
    } catch (e) {
      setError(`フォルダを開けませんでした: ${e}`);
    }
  }, []);

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

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    if (!(await confirmDirty(panesRef.current.flatMap((p) => p.tabs)))) return;
    setPanes([emptyPane(), emptyPane(), emptyPane()]);
    scrolls.current.clear();
    openFolder(dir);
  };

  /** タブを保存する。同じファイルを開いているほかのタブ（未編集のもの）にも反映する */
  const saveTab = useCallback(async (tabId: string): Promise<boolean> => {
    const t = panesRef.current.flatMap((p) => p.tabs).find((x) => x.id === tabId);
    if (!t || t.kind !== "doc") return true;
    if (t.content === t.saved) return true;
    const text = t.content;
    try {
      await writeText(t.path, text);
    } catch (e) {
      setError(`保存できませんでした: ${e}`);
      return false;
    }
    const next = panesRef.current.map((p) => ({
      ...p,
      tabs: p.tabs.map((x): Tab => {
        if (x.kind === "doc" && x.path === t.path) {
          if (x.id === tabId) return { ...x, saved: text };
          if (x.content === x.saved) return { ...x, content: text, saved: text };
          return { ...x, saved: text };
        }
        if (x.kind === "diff" && (x.left === t.path || x.right === t.path)) {
          return { ...x, ...(x.left === t.path ? { leftText: text } : {}), ...(x.right === t.path ? { rightText: text } : {}) };
        }
        return x;
      }),
    }));
    panesRef.current = next;
    setPanes(next);
    return true;
  }, []);

  const removeTab = (paneIdx: number, tabId: string) => {
    scrolls.current.delete(tabId);
    updatePane(paneIdx, (p) => {
      const k = p.tabs.findIndex((t) => t.id === tabId);
      if (k < 0) return p;
      const tabs = p.tabs.filter((t) => t.id !== tabId);
      const active = k < p.active ? p.active - 1 : Math.min(p.active, tabs.length - 1);
      return { tabs, active: Math.max(0, active) };
    });
  };

  const closeTab = async (paneIdx: number, tabIdx: number) => {
    const t = panesRef.current[paneIdx]?.tabs[tabIdx];
    if (!t) return;
    if (!(await confirmDirty([t]))) return;
    removeTab(paneIdx, t.id);
  };

  /** ⌘W: 今のタブを閉じる。どのペインにもタブがなければウィンドウを閉じる */
  const closeActiveTab = () => {
    const p = panesRef.current[activeRef.current];
    if (p?.tabs.length) closeTab(activeRef.current, p.active);
    else if (panesRef.current.slice(0, PANE_COUNT[layoutRef.current]).every((q) => !q.tabs.length)) getCurrentWindow().close();
  };

  const closeOthers = async (paneIdx: number, keepIdx: number) => {
    const p = panesRef.current[paneIdx];
    const others = p.tabs.filter((_, i) => i !== keepIdx);
    if (!(await confirmDirty(others))) return;
    const keep = p.tabs[keepIdx];
    others.forEach((t) => scrolls.current.delete(t.id));
    updatePane(paneIdx, (q) => {
      const tabs = q.tabs.filter((t) => t.id === keep.id);
      return { tabs, active: 0 };
    });
  };

  /** タブを移動する（同じペイン内の並べ替え、またはほかのペインへ） */
  const moveTab = (fromPane: number, fromIdx: number, toPane: number, toIdx: number) => {
    setPanes((ps) => {
      const tab = ps[fromPane]?.tabs[fromIdx];
      if (!tab) return ps;
      const next = ps.map((p) => ({ ...p, tabs: [...p.tabs] }));
      next[fromPane].tabs.splice(fromIdx, 1);
      let at = toIdx;
      if (fromPane === toPane && fromIdx < toIdx) at--;
      at = Math.max(0, Math.min(at, next[toPane].tabs.length));
      next[toPane].tabs.splice(at, 0, tab);
      next[toPane].active = at;
      if (fromPane !== toPane) {
        const f = next[fromPane];
        f.active = Math.max(0, fromIdx < f.active ? f.active - 1 : Math.min(f.active, f.tabs.length - 1));
      }
      return next;
    });
    focusPane(toPane);
  };

  const cycleTab = (delta: number) =>
    updatePane(activeRef.current, (p) => (p.tabs.length ? { ...p, active: (p.active + delta + p.tabs.length) % p.tabs.length } : p));

  /** 「もう片方のペイン」: 2分割ならもう一方、3分割なら右隣（右端なら左端） */
  const otherPane = (i: number) => {
    const n = PANE_COUNT[layoutRef.current];
    return n === 1 ? 1 : (i + 1) % n;
  };

  /** このタブと、もう片方のペインで開いているファイルの差分を新しいタブで開く */
  const compareWithOther = (paneIdx: number, tabIdx: number) => {
    const a = panesRef.current[paneIdx].tabs[tabIdx];
    const b = activeTab(panesRef.current[otherPane(paneIdx)]);
    if (a?.kind !== "doc" || b?.kind !== "doc") return;
    const tab: DiffTab = { id: newId(), kind: "diff", left: a.path, right: b.path, leftText: a.content, rightText: b.content };
    updatePane(paneIdx, (p) => ({ tabs: [...p.tabs.slice(0, tabIdx + 1), tab, ...p.tabs.slice(tabIdx + 1)], active: tabIdx + 1 }));
    focusPane(paneIdx);
  };

  const openTabMenu = (paneIdx: number, tabIdx: number, x: number, y: number) => {
    const p = panesRef.current[paneIdx];
    const t = p.tabs[tabIdx];
    const op = otherPane(paneIdx);
    const other = activeTab(panesRef.current[op]);
    const canCompare = t?.kind === "doc" && other?.kind === "doc" && PANE_COUNT[layoutRef.current] > 1;
    setMenu({
      x,
      y,
      items: [
        { label: "閉じる", onClick: () => closeTab(paneIdx, tabIdx) },
        { label: "ほかのタブを閉じる", onClick: () => closeOthers(paneIdx, tabIdx), disabled: p.tabs.length < 2 },
        "sep",
        {
          label: canCompare ? `もう片方のペインと比較（${tabTitle(other!)}）` : "もう片方のペインと比較",
          onClick: () => compareWithOther(paneIdx, tabIdx),
          disabled: !canCompare,
        },
        {
          label: "もう片方のペインへ移動",
          onClick: () => moveTab(paneIdx, tabIdx, op, panesRef.current[op].tabs.length),
        },
      ],
    });
  };

  // 起動時: 前回のフォルダ・タブ・表示モード・スクロール位置・未保存の編集を復元
  useEffect(() => {
    (async () => {
      const s = await restoreSession();
      setMdOnly(s.mdOnly);
      setLayout(s.layout);
      setActiveIdx(Math.min(s.activeIdx, PANE_COUNT[s.layout] - 1));
      layouts.current = s.layouts ?? {};
      if (s.root) {
        try {
          setTree(await readTree(s.root));
          setRoot(s.root);
          watchFolder(s.root).catch(() => {});
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
      const restored = await Promise.all(
        Array.from({ length: MAX_PANES }, async (_, i): Promise<PaneState> => {
          const p = s.panes[i];
          if (!p?.tabs?.length) return emptyPane();
          const results = await Promise.all(p.tabs.map(restoreTab));
          // 消えたタブを除いたうえで、選んでいたタブの位置を合わせる
          const keptBefore = results.slice(0, p.active).filter(Boolean).length;
          const tabs = results.filter((t): t is Tab => !!t);
          return { tabs, active: Math.min(keptBefore, Math.max(0, tabs.length - 1)) };
        }),
      );
      setPanes(restored);
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
    const s: Session = {
      version: 3,
      root: rootRef.current,
      panes: panesRef.current.map((p) => ({ tabs: p.tabs.map(saveTabState), active: p.active })),
      activeIdx: activeRef.current,
      layout: layoutRef.current,
      mdOnly: mdOnlyRef.current,
      layouts: layouts.current,
    };
    return saveSession(JSON.stringify(s)).catch((e) => console.warn("save session", e));
  }, []);
  const schedulePersist = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(persist, 400);
  }, [persist]);

  useEffect(() => {
    if (ready) schedulePersist();
  }, [ready, root, panes, activeIdx, layout, mdOnly, schedulePersist]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    await persist();
    await saveWindowState(StateFlags.ALL).catch(() => {});
  }, [persist]);

  // 閉じるとき（⌘Q を含む）: 未保存の変更があれば「保存 / 保存しない / キャンセル」を確認してから閉じる
  const onCloseRef = useRef<(ev: { preventDefault: () => void }) => Promise<void>>(async () => {});
  onCloseRef.current = async (ev) => {
    const dirty = panesRef.current.flatMap((p) => p.tabs).filter(isDirty);
    if (!dirty.length) {
      await flush();
      return;
    }
    ev.preventDefault();
    const c = await ask(
      dirty.length === 1 ? `「${tabTitle(dirty[0])}」の変更を保存しますか？` : `${dirty.length} 個のファイルに未保存の変更があります。保存しますか？`,
      "保存しないと、変更は失われます。",
    );
    if (c === "cancel") return;
    if (c === "save") {
      for (const t of dirty) if (!(await saveTab(t.id))) return;
    } else {
      // 保存しない: 編集内容を捨ててから状態を書き出す（次に開いたとき復元しない）
      panesRef.current = panesRef.current.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t.kind === "doc" ? { ...t, content: t.saved } : t)),
      }));
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

  // ファイル変更の監視: 開いているファイルは再読み込み、ツリーも更新
  useEffect(() => {
    if (!root) return;
    let treeTimer: number | undefined;
    const un = listen<string[]>("fs-change", async (ev) => {
      const changed = new Set(ev.payload.map(norm));
      const paths = new Set<string>();
      for (const p of panesRef.current)
        for (const t of p.tabs) {
          if (t.kind === "doc") paths.add(t.path);
          else paths.add(t.left).add(t.right);
        }
      const fresh = new Map<string, string>();
      await Promise.all(
        [...paths]
          .filter((p) => changed.has(norm(p)))
          .map((p) =>
            readText(p).then(
              (text) => void fresh.set(p, text),
              () => {}, // 削除された場合などは何もしない
            ),
          ),
      );
      if (fresh.size) {
        setPanes((ps) =>
          ps.map((p) => ({
            ...p,
            tabs: p.tabs.map((t): Tab => {
              if (t.kind === "diff") {
                const l = fresh.get(t.left);
                const r = fresh.get(t.right);
                return l === undefined && r === undefined ? t : { ...t, leftText: l ?? t.leftText, rightText: r ?? t.rightText };
              }
              const text = fresh.get(t.path);
              if (text === undefined || text === t.saved) return t;
              // 未保存の編集がある場合は上書きしない
              return t.content === t.saved ? { ...t, content: text, saved: text } : t;
            }),
          })),
        );
      }
      window.clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => readTree(root).then(setTree).catch(() => {}), 300);
    });
    return () => {
      un.then((f) => f());
      window.clearTimeout(treeTimer);
    };
  }, [root]);

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
      if (!(await confirmDirty(panesRef.current.flatMap((q) => q.tabs)))) return;
      setPanes([emptyPane(), emptyPane(), emptyPane()]);
      scrolls.current.clear();
      openFolder(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, [openFolder, openFile, confirmDirty]);

  const toggleMode = (i: number) =>
    updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, mode: t.mode === "view" ? "edit" : "view" } : t));

  const findInPane = (i: number) =>
    setCommands((cs) => {
      const next = [...cs];
      next[i] = { type: "find", n: (cs[i]?.n ?? 0) + 1 };
      return next;
    });

  // メニュー（⌘W・⌘O・⌘S など）から呼ばれる操作。最新の状態を使うため ref 経由で呼ぶ
  const actions = useRef<Record<string, () => void>>({});
  actions.current = {
    "open-folder": pickFolder,
    save: () => {
      const t = activeTab(panesRef.current[activeRef.current]);
      if (t) saveTab(t.id);
    },
    "close-tab": closeActiveTab,
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
      const i = activeRef.current;
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
      } else if (k === "o") {
        e.preventDefault();
        pickFolder();
      } else if (k === "w") {
        e.preventDefault();
        closeActiveTab();
      } else if (k === "e") {
        e.preventDefault();
        if (activeTab(panesRef.current[i])?.kind === "doc") toggleMode(i);
      } else if (k === "\\") {
        e.preventDefault();
        setLayout((l) => {
          if (l !== "single") setActiveIdx(0);
          return l === "single" ? "cols2" : "single";
        });
      } else if (k === "1" || k === "2" || k === "3") {
        e.preventDefault();
        focusPane(Number(k) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ツリーのクリック: 今のペインのタブで開く。⌘+クリックはもう片方のペイン、⌥+クリックは新しいタブ */
  const onTreeOpen = (path: string, otherPaneClick: boolean, newTab: boolean) => {
    const cur = Math.min(activeIdx, paneCount - 1);
    openFile(path, otherPaneClick ? otherPane(cur) : cur, { newTab });
  };

  const changeLayout = (l: SplitLayout) => {
    setLayout(l);
    if (activeIdx >= PANE_COUNT[l]) setActiveIdx(0);
  };

  const renderPane = (i: number) => (
    <Pane
      idx={i}
      pane={panes[i]}
      active={paneCount > 1 && activeIdx === i}
      rootDir={root}
      command={commands[i]}
      scrollOf={(id) => scrolls.current.get(id) ?? 0}
      onScroll={(id, top) => {
        scrolls.current.set(id, top);
        schedulePersist();
      }}
      onFocus={() => setActiveIdx(i)}
      onActivateTab={(k) => updatePane(i, (p) => ({ ...p, active: k }))}
      onCloseTab={(k) => closeTab(i, k)}
      onMoveTab={(fromPane, fromIdx, toIdx) => moveTab(fromPane, fromIdx, i, toIdx)}
      onTabMenu={(k, x, y) => openTabMenu(i, k, x, y)}
      onChange={(content) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, content } : t))}
      onMode={(mode: ViewMode) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, mode } : t))}
      onSave={() => {
        const t = activeTab(panesRef.current[i]);
        if (t) saveTab(t.id);
      }}
      onOpenLink={(p, anchor, newTab) => openFile(p, i, { anchor, newTab })}
    />
  );

  const visiblePaths = panes
    .slice(0, paneCount)
    .map((p) => activeTab(p))
    .flatMap((t) => (t?.kind === "doc" ? [t.path] : []));

  const onLayoutChanged = (key: string) => (l: Layout) => {
    layouts.current = { ...layouts.current, [key]: l };
    schedulePersist();
  };

  return (
    <div className="app" style={{ "--doc-font-size": `${settings.fontSize}px` } as React.CSSProperties}>
      <header className="toolbar">
        <button className="btn" onClick={pickFolder} title="フォルダを開く (⌘O)">
          フォルダを開く
        </button>
        <span className="root-name" title={root ?? ""}>
          {root ? norm(root).split("/").pop() : ""}
        </span>
        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <UpdateButton beforeRestart={flush} />
        <ViewMenu />
        <div className="segmented icons" role="group" aria-label="画面分割">
          {LAYOUTS.map(([l, label, Icon]) => (
            <button key={l} className={layout === l ? "on" : ""} onClick={() => changeLayout(l)} title={`${label}${l === "single" || l === "cols2" ? " (⌘\\)" : ""}`} aria-label={label}>
              <Icon size={15} />
            </button>
          ))}
        </div>
      </header>

      {ready && (
        <Group
          key={layout}
          orientation="horizontal"
          className="main"
          defaultLayout={layouts.current[layout]}
          onLayoutChanged={onLayoutChanged(layout)}
        >
          <Panel id="sidebar" defaultSize="22" minSize={160} collapsible>
            <aside className="sidebar">
              <div className="sidebar-head">
                <span>ファイル</span>
                <label title="Markdown ファイルだけを表示">
                  <input type="checkbox" checked={mdOnly} onChange={(e) => setMdOnly(e.target.checked)} /> .md のみ
                </label>
              </div>
              {root ? (
                <FileTree entries={tree} mdOnly={mdOnly} openPaths={visiblePaths} onOpen={onTreeOpen} />
              ) : (
                <div className="tree-empty">
                  <button className="btn" onClick={pickFolder}>フォルダを開く</button>
                  <small>ここにフォルダをドロップしても開けます</small>
                </div>
              )}
            </aside>
          </Panel>
          <Separator className="sep" />
          {layout === "rows2" ? (
            <Panel id="panes" minSize={240}>
              <Group orientation="vertical" className="main-v" defaultLayout={layouts.current["rows2-v"]} onLayoutChanged={onLayoutChanged("rows2-v")}>
                <Panel id="pane-0" minSize={120}>{renderPane(0)}</Panel>
                <Separator className="sep sep-h" />
                <Panel id="pane-1" minSize={120}>{renderPane(1)}</Panel>
              </Group>
            </Panel>
          ) : (
            Array.from({ length: paneCount }, (_, i) => [
              i > 0 && <Separator key={`sep-${i}`} className="sep" />,
              <Panel key={`pane-${i}`} id={`pane-${i}`} minSize={200}>
                {renderPane(i)}
              </Panel>,
            ])
          )}
        </Group>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog}
    </div>
  );
}
