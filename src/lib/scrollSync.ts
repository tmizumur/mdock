import type { EditorView } from "@codemirror/view";

/**
 * 「編集＋プレビュー」のスクロール同期。
 * プレビューの要素には markdown-it の token.map から data-line（0 始まりの行番号）が付いている。
 * エディタの見えている先頭行と、その行に対応するプレビューの位置を相互に合わせる。
 */

type Anchor = { line: number; top: number };

function anchors(scroller: HTMLElement): Anchor[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const out: Anchor[] = [];
  let last = -1;
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(el.dataset.line);
    if (!(line > last)) continue; // 入れ子などで順番が前後するものは飛ばす
    out.push({ line, top: el.getBoundingClientRect().top - base });
    last = line;
  }
  return out;
}

/** エディタで見えている先頭行（小数つき、0 始まり） */
export function editorTopLine(view: EditorView): number {
  const top = view.scrollDOM.scrollTop;
  const block = view.lineBlockAtHeight(top);
  const line = view.state.doc.lineAt(block.from).number - 1;
  return line + Math.min(1, Math.max(0, (top - block.top) / Math.max(1, block.height)));
}

/** エディタを、指定した行（小数つき、0 始まり）が先頭に来るようにスクロール */
export function scrollEditorToLine(view: EditorView, line: number) {
  const doc = view.state.doc;
  const n = Math.min(doc.lines, Math.max(1, Math.floor(line) + 1));
  const block = view.lineBlockAt(doc.line(n).from);
  view.scrollDOM.scrollTop = block.top + (line - Math.floor(line)) * block.height;
}

/** プレビューを、指定した行が先頭に来るようにスクロール */
export function scrollPreviewToLine(scroller: HTMLElement, line: number) {
  const as = anchors(scroller);
  if (!as.length) return;
  let i = 0;
  while (i + 1 < as.length && as[i + 1].line <= line) i++;
  const a = as[i];
  const b = as[i + 1];
  let top = a.top;
  if (line < a.line) top = (a.top * line) / Math.max(1, a.line);
  else if (b) top = a.top + ((b.top - a.top) * (line - a.line)) / (b.line - a.line);
  scroller.scrollTop = top - 8;
}

/** プレビューで見えている先頭の位置に対応する行（小数つき） */
export function previewTopLine(scroller: HTMLElement): number {
  const as = anchors(scroller);
  if (!as.length) return 0;
  const y = scroller.scrollTop + 8;
  let i = 0;
  while (i + 1 < as.length && as[i + 1].top <= y) i++;
  const a = as[i];
  const b = as[i + 1];
  if (y < a.top) return (a.line * y) / Math.max(1, a.top);
  if (!b) return a.line;
  return a.line + ((b.line - a.line) * (y - a.top)) / Math.max(1, b.top - a.top);
}
