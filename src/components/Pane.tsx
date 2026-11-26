import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Columns2, Eye, Pencil, Printer } from "lucide-react";
import PreviewPane, { type FindState } from "./PreviewPane";
import TabBar from "./TabBar";
import DiffView from "./DiffView";
import type { EditorHandle } from "./Editor";
import type { OutlineState } from "./Outline";
import { type FileError, norm } from "../lib/api";
import { markdownHeadings } from "../lib/markdown";
import { type DiffSide, type DocTab, type PaneState, type ViewMode, activeTab, isDirty } from "../lib/tabs";
import { useDrag } from "../lib/dnd";
import { editorTopLine, previewTopLine, scrollEditorToLine, scrollPreviewToLine } from "../lib/scrollSync";

// エディタは編集モードにしたときだけ読み込む（起動を速くするため）
const Editor = lazy(() => import("./Editor"));

/** App からペインへの指示（⌘F など）。n は押すたびに増える。 */
export type PaneCommand = { type: "find"; n: number };

export type PaneOutline = { paneId: string; tabId: string; mode: ViewMode; outline: OutlineState };

type Props = {
  /** ペイン ID（分割ツリーの葉） */
  idx: string;
  pane: PaneState;
  active: boolean;
  rootDir: string | null;
  onOutline: (value: PaneOutline) => void;
  command?: PaneCommand;
  /** タブごとのスクロール位置 */
  scrollOf: (tabId: string) => number;
  onScroll: (tabId: string, top: number) => void;
  onFocus: () => void;
  onActivateTab: (i: number) => void;
  onCloseTab: (i: number) => void;
  onTabMenu: (i: number, x: number, y: number) => void;
  onChange: (content: string) => void;
  onMode: (mode: ViewMode) => void;
  onSave: () => void;
  onRetryRead: (tabId: string, force: boolean, side?: DiffSide) => void;
  /** 外部で変更された内容を読み込む（自分の未保存の変更は捨てる） */
  onReloadExternal: () => void;
  /** 外部の変更を読み込まず、自分の変更を保持する */
  onKeepMine: () => void;
  onOpenLink: (path: string, anchor?: string, newTab?: boolean) => void;
  onPrint: () => void;
  /** 印刷するときに出すペイン（前面のペイン） */
  printTarget: boolean;
};

const MODES: [ViewMode, string, string, typeof Eye][] = [
  ["view", "表示", "表示 (⌘E で編集と切り替え)", Eye],
  ["edit", "編集", "編集 (⌘E)", Pencil],
  ["split", "並べて", "左にエディタ、右にプレビュー（スクロールが連動）", Columns2],
];

export default function Pane(props: Props) {
  const { idx, pane, active, rootDir, command, scrollOf, onScroll, onFocus, onChange, onMode, onSave, onOpenLink } = props;
  const tab = activeTab(pane);
  const doc = tab?.kind === "doc" ? tab : undefined;
  const failedSides = tab?.kind === "diff"
    ? (["left", "right"] as const).flatMap((side) => {
      const error = tab.reads?.[side]?.error;
      return error ? [{ side, error }] : [];
    })
    : [];
  const editor = useRef<EditorHandle>(null);
  const [find, setFind] = useState<FindState>({ open: false, query: "", index: 0, focus: 0 });
  /** 「並べて」で最後に触った側（⌘F をどちらの検索にするか） */
  const splitSide = useRef<"editor" | "preview">("editor");
  const [reported, setReported] = useState<{ tabId: string; mode: ViewMode; outline: OutlineState }>();
  const tabId = doc?.readError ? undefined : doc?.id;
  const mode = doc?.mode;
  const editSource = mode === "edit" && !doc?.readError ? doc?.content : undefined;
  const editHeadings = useMemo(() => editSource === undefined ? undefined : markdownHeadings(editSource), [editSource]);
  const onOutline = useCallback((outline: OutlineState) => {
    if (tabId && mode) setReported({ tabId, mode, outline });
  }, [tabId, mode]);
  const outline = reported?.tabId === tabId && reported?.mode === mode ? reported?.outline : undefined;
  const publishOutline = props.onOutline;
  useEffect(() => {
    if (active && tabId && mode && outline) publishOutline({ paneId: idx, tabId, mode, outline });
  }, [active, idx, tabId, mode, outline, publishOutline]);

  // ⌘F: 表示中はプレビュー内検索、編集中は CodeMirror の検索。
  // 「並べて」ではプレビュー側を最後に触っていればプレビュー内検索（エディタにフォーカスがあれば CodeMirror が先に受け取る）
  useEffect(() => {
    if (!command || command.type !== "find" || !doc || doc.readError) return;
    if (doc.mode === "view" || (doc.mode === "split" && splitSide.current === "preview")) {
      setFind((f) => ({ ...f, open: true, focus: f.focus + 1 }));
    } else editor.current?.openSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.n]);

  const dirty = isDirty(doc);
  const path = doc ? norm(doc.path) : "";
  const root = rootDir ? norm(rootDir).replace(/\/$/, "") : null;
  const pathCrumbs = (root !== null && path.startsWith(root + "/") ? path.slice(root.length + 1) : path).split("/").filter(Boolean);
  if (pathCrumbs.length === 1 && root) pathCrumbs.unshift(root.split("/").pop() ?? root);
  const headingCrumbs: number[] = [];
  if (outline) {
    let level = 7;
    for (let i = outline.current; i >= 0 && level > 1; i--) {
      if (outline.headings[i].level >= level) continue;
      level = outline.headings[i].level;
      headingCrumbs.unshift(i);
    }
  }

  return (
    <section className={`pane ${props.printTarget ? "print-target" : ""}`} onMouseDown={onFocus} data-pane={idx}>
      <TabBar
        paneId={idx}
        pane={pane}
        onActivate={props.onActivateTab}
        onClose={props.onCloseTab}
        onContextMenu={props.onTabMenu}
        actions={doc && !doc.readError && (
          <div className="segmented pane-modes" role="group" aria-label="表示モード">
            {MODES.map(([m, label, title, Icon]) => (
              <button key={m} className={doc.mode === m ? "on" : ""} aria-pressed={doc.mode === m} aria-label={label} title={title} onClick={() => doc.mode !== m && onMode(m)}>
                <Icon size={13} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </div>
        )}
      />
      <div className="pane-drop-area">
      {tab && (
        <header className="pane-header">
          <nav className="crumbs" aria-label="パンくず" title={doc?.path}>
            {(tab.kind === "diff" ? [`${tab.left} ↔ ${tab.right}`] : pathCrumbs).map((part, i) => (
              <span className="crumb" key={i}>
                {i > 0 && <ChevronRight size={12} aria-hidden="true" />}
                <span>{part}</span>
              </span>
            ))}
            {outline && headingCrumbs.map((i) => (
              <span className="crumb" key={`heading:${i}`}>
                <ChevronRight size={12} aria-hidden="true" />
                <button type="button" title={outline.headings[i].text} onClick={() => outline.jump(i)}>{outline.headings[i].text}</button>
              </span>
            ))}
          </nav>
          {doc && !doc.readError && (
            <span className="pane-actions">
              {doc.mode !== "view" && (
                <button className="btn" disabled={!dirty} onClick={onSave} title="保存 (⌘S)">保存</button>
              )}
              <button className="icon-btn" onClick={props.onPrint} title="印刷 / PDF に書き出し" aria-label="印刷 / PDF に書き出し">
                <Printer size={15} />
              </button>
            </span>
          )}
        </header>
      )}
      {doc?.deleted && (
        <div className="file-notice" role="status">
          このファイルは削除されました。
          <small>{dirty ? "保存すると、この内容で作り直します。" : "同じ名前で作り直されると、自動で表示し直します。"}</small>
        </div>
      )}
      {doc && !doc.deleted && doc.external !== undefined && (
        <div className="file-notice" role="status">
          外部で変更されました
          <span className="spacer" />
          <button className="btn" onClick={props.onReloadExternal} title="外部の内容を読み込みます（未保存の変更は失われます）">
            再読み込み
          </button>
          <button className="btn" onClick={props.onKeepMine} title="外部の変更は読み込まず、今の編集を続けます（保存すると上書きします）">
            自分の変更を保持
          </button>
        </div>
      )}
      {doc && !doc.deleted && doc.externalReadError && (
        <div className="file-notice" role="status">
          外部で変更されましたが、読み直せませんでした。
          <small>{doc.externalReadError.message}</small>
        </div>
      )}
      {!tab ? (
        <div className="placeholder">
          左のツリーからファイルを選ぶか、ここにドラッグしてください
          <small>⌘+クリックで隣のペイン、⌥+クリックで新しいタブに開けます。タブやファイルをペインの端にドラッグすると画面を分割できます</small>
        </div>
      ) : tab.kind === "doc" && tab.readError ? (
        <div className="placeholder">
          <div role="status">開けませんでした</div>
          <ReadFailure error={tab.readError} onRetry={(force) => props.onRetryRead(tab.id, force)} />
        </div>
      ) : tab.kind === "diff" && failedSides.length ? (
        <div className="placeholder">
          <div role="status">開けませんでした</div>
          {failedSides.map(({ side, error }) => (
            <ReadFailure key={side} path={tab[side]} error={error}
              onRetry={(force) => props.onRetryRead(tab.id, force, side)} />
          ))}
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
          onOutline={onOutline}
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
                searchLocation={tab.line}
                headings={editHeadings}
                onOutline={onOutline}
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
          onOutline={onOutline}
          initialScroll={scrollOf(tab.id)}
          onScroll={(top) => onScroll(tab.id, top)}
          find={find}
          setFind={setFind}
          onSide={(side) => (splitSide.current = side)}
        />
      )}
      <DropOverlay paneId={idx} />
      </div>
    </section>
  );
}

const formatMegabytes = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });

function ReadFailure({ error, path, onRetry }: { error: FileError; path?: string; onRetry: (force: boolean) => void }) {
  const size = error.size === undefined ? undefined : formatMegabytes.format(error.size / (1024 * 1024));
  const force = error.code === "large_file";
  return (
    <>
      {path && <small><bdi>{path}</bdi></small>}
      <small role="status">{size !== undefined && `このファイルは ${size} MB あります。`}{(!force || size === undefined) && error.message}</small>
      <button type="button" className="btn" onClick={() => onRetry(force)}>{force ? "それでも開く" : "再読み込み"}</button>
    </>
  );
}

/** ドラッグ中、このペインに落としたときの位置（端なら分割、中央ならタブ）を半透明で示す */
function DropOverlay({ paneId }: { paneId: string }) {
  const { target } = useDrag();
  if (target?.type !== "pane" || target.paneId !== paneId) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <div className={`drop-preview ${target.zone}`} />
    </div>
  );
}

/** 編集＋プレビュー: 左にエディタ、右にプレビュー。スクロールを行単位で同期する。 */
function SplitEditor({
  idx,
  tab,
  editor,
  onChange,
  onOpenLink,
  onOutline,
  initialScroll,
  onScroll,
  find,
  setFind,
  onSide,
}: {
  idx: string;
  tab: DocTab;
  find: FindState;
  setFind: (f: (s: FindState) => FindState) => void;
  onSide: (side: "editor" | "preview") => void;
  editor: React.RefObject<EditorHandle | null>;
  onChange: (content: string) => void;
  onOpenLink: Props["onOpenLink"];
  onOutline: (outline: OutlineState) => void;
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
      <div className="split-col editor-body" onPointerDownCapture={() => onSide("editor")} onFocusCapture={() => onSide("editor")}>
        <Suspense fallback={null}>
          <Editor
            ref={editor}
            value={tab.content}
            searchLocation={tab.line}
            onChange={onChange}
            initialScroll={initialScroll}
            onScroll={(top) => {
              onScroll(top);
              schedule("editor");
            }}
          />
        </Suspense>
      </div>
      {/* クリックでフォーカスを移せるようにする（エディタからフォーカスを外し、⌘F をプレビュー側で受ける） */}
      <div className="split-col split-preview" tabIndex={-1} onPointerDownCapture={() => onSide("preview")} onFocusCapture={() => onSide("preview")}>
        <PreviewPane
          id={`pane-${idx}-split`}
          tab={tab}
          initialScroll={0}
          onScroll={() => schedule("preview")}
          find={find}
          setFind={setFind}
          onOutline={onOutline}
          onOpenLink={onOpenLink}
          scrollerRef={preview}
        />
      </div>
    </div>
  );
}
