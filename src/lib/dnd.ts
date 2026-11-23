/**
 * ペイン間のドラッグ＆ドロップ（タブ・ツリーのファイル）。
 *
 * Tauri の dragDropEnabled（外部からのファイルのドロップ）を有効にしていると、
 * webview 内の HTML5 Drag and Drop が効かないことがあるため、pointer イベントで自前に実装する。
 */
import { useSyncExternalStore } from "react";
import type { Side } from "./layout";

export type DragItem =
  | { kind: "tab"; paneId: string; tabId: string; title: string }
  | { kind: "file"; path: string; title: string };

export type DropZone = Side | "center";

export type DropTarget =
  /** ペインの本体: 端なら分割、中央ならそのペインのタブにする */
  | { type: "pane"; paneId: string; zone: DropZone }
  /** タブバー: その位置（index の前）に入れる */
  | { type: "tabbar"; paneId: string; index: number };

type State = { item: DragItem | null; target: DropTarget | null };

let state: State = { item: null, target: null };
const listeners = new Set<() => void>();
const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a === b ||
  (!!a && !!b && a.type === b.type && a.paneId === b.paneId && (a.type === "pane" ? a.zone === (b as typeof a).zone : a.index === (b as typeof a).index));
const set = (s: State) => {
  if (s.item === state.item && sameTarget(s.target, state.target)) return;
  state = s;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** ドラッグ中のもの・ドロップ先（変わったときだけ再描画される） */
export const useDrag = () => useSyncExternalStore(subscribe, () => state);

// ポインタの位置（ドラッグ中の札を動かすだけに使う。ペインを毎回描き直さないよう分けておく）
let pos = { x: 0, y: 0 };
const posListeners = new Set<() => void>();
const subscribePos = (l: () => void) => {
  posListeners.add(l);
  return () => posListeners.delete(l);
};
export const useDragPos = () => useSyncExternalStore(subscribePos, () => pos);

type DropHandler = (item: DragItem, target: DropTarget) => void;
let dropHandler: DropHandler = () => {};
/** ドロップされたときの処理（App が登録する） */
export const setDropHandler = (h: DropHandler) => {
  dropHandler = h;
};

/** ドロップ先の判定に使う、ペインごとのタブ数（同じペイン内で 1 つしかないタブは分割しない） */
let tabCount: (paneId: string) => number = () => 0;
export const setTabCountReader = (f: (paneId: string) => number) => {
  tabCount = f;
};

/** これより狭い（低い）ペインは左右（上下）に分割しない（App の Panel の minSize の 2 倍ほど） */
const MIN_SPLIT_W = 330;
const MIN_SPLIT_H = 210;

/** 端として扱う幅（ペインの幅・高さに対する割合） */
const EDGE = 0.3;

function zoneOf(rect: DOMRect, x: number, y: number): DropZone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const d: [DropZone, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][1] < EDGE ? d[0][0] : "center";
}

function hitTest(item: DragItem, x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const paneEl = el?.closest<HTMLElement>(".pane[data-pane]");
  if (!el || !paneEl) return null;
  const paneId = paneEl.dataset.pane!;
  const fromSame = item.kind === "tab" && item.paneId === paneId;

  // タブバーの上: 並べ替え・そのペインのタブとして移動
  const bar = el.closest<HTMLElement>(".tabbar");
  if (bar && paneEl.contains(bar)) {
    const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")];
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    return { type: "tabbar", paneId, index };
  }

  const body = paneEl.querySelector<HTMLElement>(".pane-drop-area") ?? paneEl;
  const rect = body.getBoundingClientRect();
  let zone = zoneOf(rect, x, y);
  // 分割すると最小サイズを下回るほど狭いペインは、それ以上分割しない
  if ((zone === "left" || zone === "right") && rect.width < MIN_SPLIT_W) zone = "center";
  if ((zone === "top" || zone === "bottom") && rect.height < MIN_SPLIT_H) zone = "center";
  if (fromSame) {
    // 同じペインの中央に落としても何も変わらない。タブが 1 つだけなら分割もしない
    if (zone === "center" || tabCount(paneId) <= 1) return null;
  }
  return { type: "pane", paneId, zone };
}

/** これだけ動いたらドラッグを始める（クリックと区別する） */
const THRESHOLD = 5;

/**
 * pointerdown で呼ぶ。少し動いたらドラッグを始め、離したところへドロップする。
 * 動かさずに離した場合は何もしない（クリックとして扱われる）。
 */
export function beginDrag(e: React.PointerEvent, item: DragItem) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
      started = true;
      document.body.classList.add("dragging-item");
      window.getSelection()?.removeAllRanges();
    }
    ev.preventDefault();
    pos = { x: ev.clientX, y: ev.clientY };
    posListeners.forEach((l) => l());
    set({ item, target: hitTest(item, ev.clientX, ev.clientY) });
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!started) return;
    document.body.classList.remove("dragging-item");
    const t = state.target;
    set({ item: null, target: null });
    // ドラッグの後のクリック（ツリーの行を開くなど）を 1 回だけ無視する
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (drop && t) dropHandler(item, t);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && started) {
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
