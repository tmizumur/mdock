import { Suspense, lazy, useEffect, useRef, useState } from "react";
import PreviewPane, { type FindState } from "./PreviewPane";
import TabBar from "./TabBar";
import DiffView from "./DiffView";
import type { EditorHandle } from "./Editor";
import type { Heading } from "./OverviewRuler";
import { type DocTab, type PaneState, type ViewMode, activeTab, isDirty } from "../lib/tabs";
import { editorTopLine, previewTopLine, scrollEditorToLine, scrollPreviewToLine } from "../lib/scrollSync";

// エディタは編集モードにしたときだけ読み込む（起動を速くするため）
const Editor = lazy(() => import("./Editor"));

/** App からペインへの指示（⌘F など）。n は押すたびに増える。 */
export type PaneCommand = { type: "find"; n: number };

type Props = {
  idx: number;
  pane: PaneState;
  active: boolean;
  rootDir: string | null;
  command?: PaneCommand;
  /** タブごとのスクロール位置 */
  scrollOf: (tabId: string) => number;
  onScroll: (tabId: string, top: number) => void;
  onFocus: () => void;
  onActivateTab: (i: number) => void;
  onCloseTab: (i: number) => void;
  onMoveTab: (fromPane: number, fromIdx: number, toIdx: number) => void;
  onTabMenu: (i: number, x: number, y: number) => void;
  onChange: (content: string) => void;
  onMode: (mode: ViewMode) => void;
  onSave: () => void;
  onOpenLink: (path: string, anchor?: string, newTab?: boolean) => void;
};

const MODES: [ViewMode, string, string][] = [
  ["view", "表示", "表示 (⌘E で編集と切り替え)"],
  ["edit", "編集", "編集 (⌘E)"],
  ["split", "編集＋プレビュー", "左にエディタ、右にプレビュー（スクロールが連動）"],
];

export default function Pane(props: Props) {
  const { idx, pane, active, rootDir, command, scrollOf, onScroll, onFocus, onChange, onMode, onSave, onOpenLink } = props;
  const tab = activeTab(pane);
  const doc = tab?.kind === "doc" ? tab : undefined;
  const editor = useRef<EditorHandle>(null);
  const [find, setFind] = useState<FindState>({ open: false, query: "", index: 0, focus: 0 });
  const [trail, setTrail] = useState<{ items: Heading[]; scrollTo: (top: number) => void }>({ items: [], scrollTo: () => {} });

  // タブを切り替えたらパンくずを消す（新しいプレビューが描かれたら出し直す）
  useEffect(() => setTrail((t) => ({ ...t, items: [] })), [tab?.id, doc?.mode]);

  // ⌘F: 表示中はプレビュー内検索、編集中は CodeMirror の検索
  useEffect(() => {
    if (!command || command.type !== "find" || !doc) return;
    if (doc.mode === "view") setFind((f) => ({ ...f, open: true, focus: f.focus + 1 }));
    else editor.current?.openSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.n]);

  const dirty = isDirty(doc);
  const rel = doc && rootDir && doc.path.startsWith(rootDir) ? doc.path.slice(rootDir.length + 1) : doc?.path;

  return (
    <section className={`pane ${active ? "active" : ""}`} onMouseDown={onFocus} data-pane={idx}>
      <TabBar
        paneIdx={idx}
        pane={pane}
        onActivate={props.onActivateTab}
        onClose={props.onCloseTab}
        onMove={props.onMoveTab}
        onContextMenu={props.onTabMenu}
      />
      {doc && (
        <header className="pane-header">
          <span className="pane-title" title={doc.path}>
            <span className="pane-file">{rel}</span>
            {dirty && <span className="dirty" title="未保存の変更があります">●</span>}
            {doc.mode !== "edit" && trail.items.length > 0 && (
              <span className="crumbs" title={trail.items.map((h) => h.text).join(" › ")}>
                {trail.items.map((h, i) => (
                  <span key={i} className="crumb" onClick={() => trail.scrollTo(h.top - 8)}>
                    {h.text}
                  </span>
                ))}
              </span>
            )}
          </span>
          <span className="pane-actions">
            <div className="segmented" role="group" aria-label="表示モード">
              {MODES.map(([m, label, title]) => (
                <button key={m} className={doc.mode === m ? "on" : ""} title={title} onClick={() => doc.mode !== m && onMode(m)}>
                  {label}
                </button>
              ))}
            </div>
            {doc.mode !== "view" && (
              <button className="btn" disabled={!dirty} onClick={onSave} title="保存 (⌘S)">
                保存
              </button>
            )}
          </span>
        </header>
      )}
      {!tab ? (
        <div className="placeholder">
          左のツリーからファイルを選んでください
          <small>⌘+クリックでもう片方のペイン、⌥+クリックで新しいタブに開けます</small>
        </div>
      ) : tab.kind === "diff" ? (
        <div className="pane-main">
          <div className="pane-body" key={tab.id}>
            <DiffView tab={tab} />
          </div>
        </div>
      ) : tab.mode === "view" ? (
        <PreviewPane
          key={tab.id}
          id={`pane-${idx}`}
          tab={tab}
          initialScroll={scrollOf(tab.id)}
          onScroll={(top) => onScroll(tab.id, top)}
          find={find}
          setFind={setFind}
          onTrail={(items, scrollTo) => setTrail({ items, scrollTo })}
          onOpenLink={onOpenLink}
        />
      ) : tab.mode === "edit" ? (
        <div className="pane-main">
          <div className="pane-body editor-body">
            <Suspense fallback={null}>
              <Editor
                key={tab.id}
                ref={editor}
                value={tab.content}
                onChange={onChange}
                initialScroll={scrollOf(tab.id)}
                onScroll={(top) => onScroll(tab.id, top)}
              />
            </Suspense>
          </div>
        </div>
      ) : (
        <SplitEditor
          key={tab.id}
          idx={idx}
          tab={tab}
          editor={editor}
          onChange={onChange}
          onOpenLink={onOpenLink}
          onTrail={(items, scrollTo) => setTrail({ items, scrollTo })}
          initialScroll={scrollOf(tab.id)}
          onScroll={(top) => onScroll(tab.id, top)}
        />
      )}
    </section>
  );
}

/** 編集＋プレビュー: 左にエディタ、右にプレビュー。スクロールを行単位で同期する。 */
function SplitEditor({
  idx,
  tab,
  editor,
  onChange,
  onOpenLink,
  onTrail,
  initialScroll,
  onScroll,
}: {
  idx: number;
  tab: DocTab;
  editor: React.RefObject<EditorHandle | null>;
  onChange: (content: string) => void;
  onOpenLink: Props["onOpenLink"];
  onTrail: (items: Heading[], scrollTo: (top: number) => void) => void;
  initialScroll: number;
  onScroll: (top: number) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  // 片方を動かしたとき、もう片方のスクロールイベントで戻ってこないようにする
  const lock = useRef<{ by: "editor" | "preview"; until: number } | null>(null);
  const locked = (by: "editor" | "preview") => {
    const l = lock.current;
    return !!l && l.by !== by && performance.now() < l.until;
  };
  const [noFind, setNoFind] = useState<FindState>({ open: false, query: "", index: 0, focus: 0 });

  const fromEditor = () => {
    const v = editor.current?.view();
    if (!v || !preview.current || locked("editor")) return;
    lock.current = { by: "editor", until: performance.now() + 250 };
    scrollPreviewToLine(preview.current, editorTopLine(v));
  };
  const fromPreview = () => {
    const v = editor.current?.view();
    if (!v || !preview.current || locked("preview")) return;
    lock.current = { by: "preview", until: performance.now() + 250 };
    scrollEditorToLine(v, previewTopLine(preview.current));
  };
  // スクロールのたびに計算せず、1フレームに1回だけ合わせる。
  // エディタは行の高さを描画後に測り直すので、少し後にもう一度合わせる。
  const timers = useRef({ editor: { frame: 0, settle: 0 }, preview: { frame: 0, settle: 0 } });
  const schedule = (by: "editor" | "preview") => {
    if (locked(by)) return; // もう片方を動かしたことで起きたスクロールは無視
    const t = timers.current[by];
    const fn = by === "editor" ? fromEditor : fromPreview;
    cancelAnimationFrame(t.frame);
    t.frame = requestAnimationFrame(() => (t.frame = requestAnimationFrame(fn)));
    window.clearTimeout(t.settle);
    t.settle = window.setTimeout(fn, 150);
  };
  useEffect(
    () => () => {
      for (const t of Object.values(timers.current)) {
        cancelAnimationFrame(t.frame);
        window.clearTimeout(t.settle);
      }
    },
    [],
  );

  // プレビューを描き直した後（入力で高さが変わった後）も、エディタの位置に合わせる
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!lock.current || lock.current.by === "editor") {
        lock.current = null;
        fromEditor();
      }
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.content]);

  return (
    <div className="split-edit">
      <div className="split-col editor-body">
        <Suspense fallback={null}>
          <Editor
            ref={editor}
            value={tab.content}
            onChange={onChange}
            initialScroll={initialScroll}
            onScroll={(top) => {
              onScroll(top);
              schedule("editor");
            }}
          />
        </Suspense>
      </div>
      <div className="split-col">
        <PreviewPane
          id={`pane-${idx}-split`}
          tab={tab}
          initialScroll={0}
          onScroll={() => schedule("preview")}
          find={noFind}
          setFind={setNoFind}
          onTrail={onTrail}
          onOpenLink={onOpenLink}
          scrollerRef={preview}
        />
      </div>
    </div>
  );
}
