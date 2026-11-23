import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import Preview, { type FindResult } from "./Preview";
import FindBar from "./FindBar";
import OverviewRuler, { useOutline } from "./OverviewRuler";
import type { EditorHandle } from "./Editor";

// エディタは編集モードにしたときだけ読み込む（起動を速くするため）
const Editor = lazy(() => import("./Editor"));

export type PaneState = {
  path: string | null;
  content: string;
  saved: string; // ディスク上の内容（未保存の判定に使う）
  mode: "view" | "edit";
  /** 開いたら移動したい見出し（別ファイルの #見出し へのリンクから開いたとき） */
  anchor?: { id: string; nonce: number };
};

export const emptyPane = (): PaneState => ({ path: null, content: "", saved: "", mode: "view" });

/** App からペインへの指示（⌘F など）。n は押すたびに増える。 */
export type PaneCommand = { type: "find"; n: number };

type Props = {
  id: string;
  pane: PaneState;
  active: boolean;
  rootDir: string | null;
  command?: PaneCommand;
  onFocus: () => void;
  onChange: (content: string) => void;
  onToggleMode: () => void;
  onSave: () => void;
  onClose: () => void;
  onOpenLink: (path: string, anchor?: string) => void;
  /** 復元したいスクロール位置（起動直後に1回だけ使う） */
  restoreScroll?: { path: string; top: number };
  onScroll: (top: number) => void;
};

export default function Pane({ id, pane, active, rootDir, command, onFocus, onChange, onToggleMode, onSave, onClose, onOpenLink, restoreScroll, onScroll }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle>(null);
  const restored = useRef(false);
  const [find, setFind] = useState<{ open: boolean; query: string; index: number; focus: number }>({ open: false, query: "", index: 0, focus: 0 });
  const [findResult, setFindResult] = useState<FindResult>({ count: 0, tops: [] });
  const [version, setVersion] = useState(0);
  const viewing = !!pane.path && pane.mode === "view";
  const { headings, metrics, trail } = useOutline(body, version, viewing);

  // 前回のスクロール位置に戻す（復元したファイルを開いたときに1回だけ）
  useLayoutEffect(() => {
    if (restored.current || !restoreScroll || !body.current || pane.path !== restoreScroll.path) return;
    restored.current = true;
    const el = body.current;
    el.scrollTop = restoreScroll.top;
    // 図やコードの色付けで高さが変わることがあるので、少し後にもう一度合わせる
    window.setTimeout(() => (el.scrollTop = restoreScroll.top), 300);
  }, [restoreScroll, pane.path, pane.content]);

  // ⌘F: 表示中はプレビュー内検索、編集中は CodeMirror の検索
  useEffect(() => {
    if (!command || command.type !== "find" || !pane.path) return;
    if (pane.mode === "edit") editor.current?.openSearch();
    else setFind((f) => ({ ...f, open: true, focus: f.focus + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.n]);

  const dirty = pane.content !== pane.saved;
  const rel = pane.path && rootDir && pane.path.startsWith(rootDir) ? pane.path.slice(rootDir.length + 1) : pane.path;
  const showFind = viewing && find.open;

  return (
    <section className={`pane ${active ? "active" : ""}`} onMouseDown={onFocus}>
      <header className="pane-header">
        <span className="pane-title" title={pane.path ?? ""}>
          <span className="pane-file">{rel ?? "ファイル未選択"}</span>
          {dirty && <span className="dirty" title="未保存の変更があります">●</span>}
          {viewing && trail.length > 0 && (
            <span className="crumbs" title={trail.map((h) => h.text).join(" › ")}>
              {trail.map((h, i) => (
                <span key={i} className="crumb" onClick={() => body.current && (body.current.scrollTop = h.top - 8)}>
                  {h.text}
                </span>
              ))}
            </span>
          )}
        </span>
        {pane.path && (
          <span className="pane-actions">
            <div className="segmented" role="group" aria-label="表示モード">
              <button className={pane.mode === "view" ? "on" : ""} onClick={() => pane.mode !== "view" && onToggleMode()}>
                表示
              </button>
              <button className={pane.mode === "edit" ? "on" : ""} onClick={() => pane.mode !== "edit" && onToggleMode()}>
                編集
              </button>
            </div>
            {pane.mode === "edit" && (
              <button className="btn" disabled={!dirty} onClick={onSave} title="保存 (⌘S)">
                保存
              </button>
            )}
            <button className="icon-btn" onClick={onClose} title="閉じる">
              ×
            </button>
          </span>
        )}
      </header>
      <div className="pane-main">
        {showFind && (
          <FindBar
            query={find.query}
            index={find.index}
            count={findResult.count}
            focusSignal={find.focus}
            onChange={(query) => setFind((f) => ({ ...f, query, index: 0 }))}
            onStep={(d) => setFind((f) => ({ ...f, index: f.index + d }))}
            onClose={() => setFind((f) => ({ ...f, open: false }))}
          />
        )}
        <div className="pane-body" ref={body} onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
          {!pane.path ? (
            <div className="placeholder">
              左のツリーからファイルを選んでください
              <small>⌘+クリックでもう片方のペインに開けます</small>
            </div>
          ) : pane.mode === "edit" ? (
            <Suspense fallback={null}>
              <Editor key={pane.path} ref={editor} value={pane.content} onChange={onChange} />
            </Suspense>
          ) : (
            <Preview
              id={id}
              path={pane.path}
              content={pane.content}
              scroller={body}
              onOpenLink={onOpenLink}
              anchor={pane.anchor}
              find={showFind ? { query: find.query, index: find.index } : undefined}
              onFindResult={setFindResult}
              onRendered={() => setVersion((v) => v + 1)}
            />
          )}
        </div>
        {viewing && (
          <OverviewRuler
            headings={headings}
            metrics={metrics}
            marks={showFind ? findResult.tops : undefined}
            onScrollTo={(top) => body.current && (body.current.scrollTop = top)}
          />
        )}
      </div>
    </section>
  );
}
