import { Suspense, lazy, useLayoutEffect, useRef } from "react";

// エディタは編集モードにしたときだけ読み込む（起動を速くするため）
const Editor = lazy(() => import("./Editor"));
import Preview from "./Preview";

export type PaneState = {
  path: string | null;
  content: string;
  saved: string; // ディスク上の内容（未保存の判定に使う）
  mode: "view" | "edit";
};

export const emptyPane = (): PaneState => ({ path: null, content: "", saved: "", mode: "view" });

type Props = {
  pane: PaneState;
  active: boolean;
  rootDir: string | null;
  onFocus: () => void;
  onChange: (content: string) => void;
  onToggleMode: () => void;
  onSave: () => void;
  onClose: () => void;
  onOpenLink: (path: string) => void;
  /** 復元したいスクロール位置（起動直後に1回だけ使う） */
  restoreScroll?: { path: string; top: number };
  onScroll: (top: number) => void;
};

export default function Pane({ pane, active, rootDir, onFocus, onChange, onToggleMode, onSave, onClose, onOpenLink, restoreScroll, onScroll }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  // 前回のスクロール位置に戻す（復元したファイルを開いたときに1回だけ）
  useLayoutEffect(() => {
    if (restored.current || !restoreScroll || !body.current || pane.path !== restoreScroll.path) return;
    restored.current = true;
    const el = body.current;
    el.scrollTop = restoreScroll.top;
    // 図やコードの色付けで高さが変わることがあるので、少し後にもう一度合わせる
    window.setTimeout(() => (el.scrollTop = restoreScroll.top), 300);
  }, [restoreScroll, pane.path, pane.content]);

  const dirty = pane.content !== pane.saved;
  const rel = pane.path && rootDir && pane.path.startsWith(rootDir) ? pane.path.slice(rootDir.length + 1) : pane.path;

  return (
    <section className={`pane ${active ? "active" : ""}`} onMouseDown={onFocus}>
      <header className="pane-header">
        <span className="pane-title" title={pane.path ?? ""}>
          {rel ?? "ファイル未選択"}
          {dirty && <span className="dirty" title="未保存の変更があります">●</span>}
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
      <div className="pane-body" ref={body} onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
        {!pane.path ? (
          <div className="placeholder">
            左のツリーからファイルを選んでください
            <small>⌘+クリックでもう片方のペインに開けます</small>
          </div>
        ) : pane.mode === "edit" ? (
          <Suspense fallback={null}>
            <Editor key={pane.path} value={pane.content} onChange={onChange} />
          </Suspense>
        ) : (
          <Preview path={pane.path} content={pane.content} onOpenLink={onOpenLink} />
        )}
      </div>
    </section>
  );
}
