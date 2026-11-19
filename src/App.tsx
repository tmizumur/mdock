import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Layout, Panel, Separator } from "react-resizable-panels";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "./components/FileTree";
import Pane, { PaneState, emptyPane } from "./components/Pane";
import { Entry, loadSession, norm, readText, readTree, saveSession, watchFolder, writeText } from "./lib/api";

type SavedPane = {
  path: string | null;
  mode: "view" | "edit";
  scroll: number;
  /** 未保存の編集内容（あれば） */
  draft?: string;
  /** draft を書き始めたときのディスク上の内容。ファイルが外で変わっていたら draft は捨てる */
  draftBase?: string;
};

type Session = {
  version: 2;
  root: string | null;
  panes: SavedPane[];
  activeIdx: number;
  split: boolean;
  mdOnly: boolean;
  layouts: { split?: Layout; single?: Layout };
};

const defaultSession = (): Session => ({
  version: 2,
  root: null,
  panes: [
    { path: null, mode: "view", scroll: 0 },
    { path: null, mode: "view", scroll: 0 },
  ],
  activeIdx: 0,
  split: true,
  mdOnly: true,
  layouts: {},
});

/** 保存しておいた状態を読む。壊れていたら初期状態から始める。 */
async function restoreSession(): Promise<Session> {
  try {
    const raw = await loadSession();
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.version === 2 && Array.isArray(s.panes)) return { ...defaultSession(), ...s };
    }
    // 初期版（localStorage に保存していた頃）からの引き継ぎ
    const old = JSON.parse(localStorage.getItem("mdock.session") ?? "null");
    if (old && Array.isArray(old.paths)) {
      return {
        ...defaultSession(),
        root: old.root,
        split: old.split,
        mdOnly: old.mdOnly,
        panes: old.paths.map((path: string | null) => ({ path, mode: "view", scroll: 0 })),
      };
    }
  } catch (e) {
    console.warn("session", e);
  }
  return defaultSession();
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([emptyPane(), emptyPane()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [split, setSplit] = useState(true);
  const [mdOnly, setMdOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreScroll, setRestoreScroll] = useState<({ path: string; top: number } | undefined)[]>([]);
  const layouts = useRef<Session["layouts"]>({});
  const scrolls = useRef<number[]>([0, 0]);

  // イベントハンドラから最新の状態を読むための参照
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const rootRef = useRef(root);
  rootRef.current = root;
  const activeRef = useRef(activeIdx);
  activeRef.current = activeIdx;
  const splitRef = useRef(split);
  splitRef.current = split;
  const mdOnlyRef = useRef(mdOnly);
  mdOnlyRef.current = mdOnly;

  const updatePane = (i: number, patch: Partial<PaneState>) =>
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  /** ファイルを指定ペインに開く */
  const openFile = useCallback(async (path: string, idx: number) => {
    try {
      const text = await readText(path);
      setPanes((ps) =>
        ps.map((p, j) => (j === idx ? { path, content: text, saved: text, mode: p.path === path ? p.mode : "view" } : p)),
      );
      setActiveIdx(idx);
      if (idx === 1) setSplit(true);
      setError(null);
    } catch (e) {
      setError(`開けませんでした: ${e}`);
    }
  }, []);

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

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setPanes([emptyPane(), emptyPane()]);
      openFolder(dir);
    }
  };

  // 起動時: 前回のフォルダ・ファイル・表示モード・スクロール位置・未保存の編集を復元
  useEffect(() => {
    (async () => {
      const s = await restoreSession();
      setSplit(s.split);
      setMdOnly(s.mdOnly);
      setActiveIdx(s.split ? s.activeIdx : 0);
      layouts.current = s.layouts ?? {};
      scrolls.current = s.panes.map((p) => p.scroll ?? 0);
      setRestoreScroll(s.panes.map((p) => (p.path ? { path: p.path, top: p.scroll ?? 0 } : undefined)));
      if (s.root) {
        try {
          setTree(await readTree(s.root));
          setRoot(s.root);
          watchFolder(s.root).catch(() => {});
        } catch {
          /* フォルダが消えていた場合は何も開かない */
        }
      }
      const restored = await Promise.all(
        [0, 1].map(async (i): Promise<PaneState> => {
          const p = s.panes[i];
          if (!p?.path) return emptyPane();
          try {
            const text = await readText(p.path);
            const draft = p.draft !== undefined && p.draftBase === text ? p.draft : text;
            return { path: p.path, content: draft, saved: text, mode: p.mode ?? "view" };
          } catch {
            return emptyPane();
          }
        }),
      );
      setPanes(restored);
      setReady(true);
    })();
  }, []);

  // 状態をファイルに保存（変更から少し待ってまとめて書く）
  const saveTimer = useRef<number | undefined>(undefined);
  const persist = useCallback(() => {
    const ps = panesRef.current;
    const s: Session = {
      version: 2,
      root: rootRef.current,
      panes: ps.map((p, i) => ({
        path: p.path,
        mode: p.mode,
        scroll: scrolls.current[i] ?? 0,
        ...(p.content !== p.saved ? { draft: p.content, draftBase: p.saved } : {}),
      })),
      activeIdx: activeRef.current,
      split: splitRef.current,
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
  }, [ready, root, panes, activeIdx, split, mdOnly, schedulePersist]);

  // 終了するとき・ウィンドウを動かしたときにも保存する
  useEffect(() => {
    const win = getCurrentWindow();
    let t: number | undefined;
    const saveWin = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => saveWindowState(StateFlags.ALL).catch(() => {}), 500);
    };
    const uns = [
      win.onMoved(saveWin),
      win.onResized(saveWin),
      win.onCloseRequested(async () => {
        window.clearTimeout(saveTimer.current);
        await persist();
        await saveWindowState(StateFlags.ALL).catch(() => {});
      }),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, [persist]);

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
      for (const [i, p] of panesRef.current.entries()) {
        if (!p.path || !changed.has(norm(p.path))) continue;
        try {
          const text = await readText(p.path);
          // 未保存の編集がある場合は上書きしない
          setPanes((ps) =>
            ps.map((q, j) =>
              j === i && q.path === p.path && text !== q.saved
                ? q.content === q.saved
                  ? { ...q, content: text, saved: text }
                  : q
                : q,
            ),
          );
        } catch {
          /* 削除された場合などは何もしない */
        }
      }
      window.clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => readTree(root).then(setTree).catch(() => {}), 300);
    });
    return () => {
      un.then((f) => f());
      window.clearTimeout(treeTimer);
    };
  }, [root]);

  // フォルダのドラッグ&ドロップ
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (ev) => {
      if (ev.payload.type !== "drop" || !ev.payload.paths.length) return;
      const p = ev.payload.paths[0];
      try {
        await readTree(p);
        setPanes([emptyPane(), emptyPane()]);
        openFolder(p);
      } catch {
        // フォルダでなければファイルとして開く
        openFile(p, activeIdx);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [openFolder, openFile, activeIdx]);

  const save = useCallback(async (i: number) => {
    const p = panesRef.current[i];
    if (!p.path || p.content === p.saved) return;
    try {
      await writeText(p.path, p.content);
      setPanes((ps) => ps.map((q, j) => (j === i ? { ...q, saved: p.content } : q)));
    } catch (e) {
      setError(`保存できませんでした: ${e}`);
    }
  }, []);

  const toggleMode = (i: number) =>
    updatePane(i, { mode: panesRef.current[i].mode === "view" ? "edit" : "view" });

  const closePane = (i: number) => {
    const p = panesRef.current[i];
    if (p.content !== p.saved && !window.confirm("保存していない変更があります。閉じますか？")) return;
    updatePane(i, emptyPane());
  };

  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        save(activeIdx);
      } else if (k === "o") {
        e.preventDefault();
        pickFolder();
      } else if (k === "e") {
        e.preventDefault();
        if (panesRef.current[activeIdx].path) toggleMode(activeIdx);
      } else if (k === "\\") {
        e.preventDefault();
        setSplit((s) => {
          if (s) setActiveIdx(0);
          return !s;
        });
      } else if (k === "1" || k === "2") {
        e.preventDefault();
        const i = Number(k) - 1;
        if (i === 1) setSplit(true);
        setActiveIdx(i);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, save]);

  const onTreeOpen = (path: string, otherPane: boolean) => {
    const idx = otherPane ? (activeIdx === 0 ? 1 : 0) : split ? activeIdx : 0;
    openFile(path, idx);
  };

  const renderPane = (i: number) => (
    <Pane
      pane={panes[i]}
      active={split && activeIdx === i}
      rootDir={root}
      onFocus={() => setActiveIdx(i)}
      onChange={(content) => updatePane(i, { content })}
      onToggleMode={() => toggleMode(i)}
      onSave={() => save(i)}
      onClose={() => closePane(i)}
      onOpenLink={(p) => openFile(p, i)}
      restoreScroll={restoreScroll[i]}
      onScroll={(top) => {
        scrolls.current[i] = top;
        schedulePersist();
      }}
    />
  );

  return (
    <div className="app">
      <header className="toolbar">
        <button className="btn" onClick={pickFolder} title="フォルダを開く (⌘O)">
          フォルダを開く
        </button>
        <span className="root-name" title={root ?? ""}>
          {root ? norm(root).split("/").pop() : ""}
        </span>
        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <div className="segmented" role="group" aria-label="画面分割">
          <button className={!split ? "on" : ""} onClick={() => { setSplit(false); setActiveIdx(0); }} title="1画面 (⌘\)">
            1画面
          </button>
          <button className={split ? "on" : ""} onClick={() => setSplit(true)} title="2画面 (⌘\)">
            2画面
          </button>
        </div>
      </header>

      {ready && (
      <Group
        key={split ? "split" : "single"}
        orientation="horizontal"
        className="main"
        defaultLayout={split ? layouts.current.split : layouts.current.single}
        onLayoutChanged={(layout) => {
          layouts.current = { ...layouts.current, [split ? "split" : "single"]: layout };
          schedulePersist();
        }}
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
              <FileTree entries={tree} mdOnly={mdOnly} openPaths={panes.map((p) => p.path ?? "")} onOpen={onTreeOpen} />
            ) : (
              <div className="tree-empty">
                <button className="btn" onClick={pickFolder}>フォルダを開く</button>
                <small>ここにフォルダをドロップしても開けます</small>
              </div>
            )}
          </aside>
        </Panel>
        <Separator className="sep" />
        <Panel id="pane-0" minSize={240}>{renderPane(0)}</Panel>
        {split && <Separator className="sep" />}
        {split && <Panel id="pane-1" minSize={240}>{renderPane(1)}</Panel>}
      </Group>
      )}
    </div>
  );
}
