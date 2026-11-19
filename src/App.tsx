import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "./components/FileTree";
import Pane, { PaneState, emptyPane } from "./components/Pane";
import { Entry, norm, readText, readTree, watchFolder, writeText } from "./lib/api";

const STORE_KEY = "mdock.session";

type Session = { root: string | null; paths: (string | null)[]; split: boolean; mdOnly: boolean };

function loadSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "");
    if (s && Array.isArray(s.paths)) return s;
  } catch {
    /* 初回起動など */
  }
  return { root: null, paths: [null, null], split: true, mdOnly: true };
}

export default function App() {
  const initial = useRef(loadSession()).current;
  const [root, setRoot] = useState<string | null>(initial.root);
  const [tree, setTree] = useState<Entry[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([emptyPane(), emptyPane()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [split, setSplit] = useState(initial.split);
  const [mdOnly, setMdOnly] = useState(initial.mdOnly);
  const [error, setError] = useState<string | null>(null);

  // イベントハンドラから最新の状態を読むための参照
  const panesRef = useRef(panes);
  panesRef.current = panes;

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

  // 起動時: 前回のフォルダとファイルを復元
  useEffect(() => {
    if (initial.root) {
      openFolder(initial.root).then(() =>
        initial.paths.forEach((p, i) => p && openFile(p, i)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 状態を保存
  useEffect(() => {
    const s: Session = { root, paths: panes.map((p) => p.path), split, mdOnly };
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  }, [root, panes, split, mdOnly]);

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

      <Group orientation="horizontal" className="main">
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
    </div>
  );
}
