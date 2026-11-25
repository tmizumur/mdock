import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type UnsavedChoice = "save" | "discard" | "cancel";

type Ask = { message: string; detail?: string; resolve: (c: UnsavedChoice) => void };

/**
 * 「保存 / 保存しない / キャンセル」の確認ダイアログ。
 * const { ask, dialog } = useUnsavedDialog(); const choice = await ask("…");  {dialog} を描画しておく
 */
export function useUnsavedDialog() {
  const [state, setState] = useState<Ask | null>(null);
  const ask = useCallback(
    (message: string, detail?: string) =>
      new Promise<UnsavedChoice>((resolve) => setState({ message, detail, resolve })),
    [],
  );
  const finish = (c: UnsavedChoice) => {
    state?.resolve(c);
    setState(null);
  };
  const dialog = state ? <UnsavedDialog message={state.message} detail={state.detail} onChoose={finish} /> : null;
  return { ask, dialog };
}

function UnsavedDialog({ message, detail, onChoose }: { message: string; detail?: string; onChoose: (c: UnsavedChoice) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saveBtn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    saveBtn.current?.focus();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog-surface modal"
      role="alertdialog"
      aria-modal
      aria-label={message}
      aria-describedby={detail ? "unsaved-detail" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onChoose("cancel");
      }}
    >
      <div className="modal-title">{message}</div>
      {detail && <div className="modal-detail" id="unsaved-detail">{detail}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={() => onChoose("discard")}>
          保存しない
        </button>
        <span className="spacer" />
        <button className="btn" onClick={() => onChoose("cancel")}>
          キャンセル
        </button>
        <button className="btn primary" ref={saveBtn} onClick={() => onChoose("save")}>
          保存
        </button>
      </div>
    </dialog>
  );
}

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean } | "sep";

/** 右クリックメニュー */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onClose = () => closeRef.current();
    // 画面からはみ出さないように位置を直す
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(x, window.innerWidth - r.width - 4), y: Math.min(y, window.innerHeight - r.height - 4) });
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", onClose);
    };
  }, [x, y]);
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="context-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
