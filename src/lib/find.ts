/**
 * プレビュー内のファイル内検索。
 * 一致箇所は DOM を書き換えずに CSS Custom Highlight API で色を付ける
 * （::highlight(mdock-find) / ::highlight(mdock-find-current)）。
 */

/** 検索対象にしない部分（ボタンの文字や、KaTeX の読み上げ用の重複テキストなど） */
const SKIP = "button, script, style, svg, .katex-mathml, .find-skip";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, div, figcaption";
const MAX = 5000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** root の中で query に一致する範囲をすべて返す（大文字小文字は区別しない。要素をまたいでも見つける） */
export function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const block = n.parentElement?.closest(BLOCK) ?? null;
    // 段落が変わったら区切りを入れて、段落をまたいだ一致を防ぐ
    if (block !== lastBlock) {
      text += "\n";
      lastBlock = block;
    }
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  const re = new RegExp(escapeRe(query), "giu");
  const ranges: Range[] = [];
  const locate = (pos: number): [Text, number] => {
    // pos を含むテキストノードを二分探索で探す
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], Math.min(pos - starts[lo], nodes[lo].length)];
  };
  for (let m = re.exec(text); m && ranges.length < MAX; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const [sn, so] = locate(m.index);
    const [en, eo] = locate(m.index + m[0].length - 1);
    const r = document.createRange();
    r.setStart(sn, so);
    r.setEnd(en, eo + 1);
    ranges.push(r);
  }
  return ranges;
}

export const highlightSupported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** ペインごとの一致箇所。CSS.highlights は全体で1つなので、全ペインの分をまとめて登録する。 */
const registry = new Map<string, { ranges: Range[]; current: number }>();

function apply() {
  if (!highlightSupported()) return;
  const all = new Highlight();
  const cur = new Highlight();
  for (const { ranges, current } of registry.values()) {
    ranges.forEach((r, i) => (i === current ? cur : all).add(r));
  }
  CSS.highlights.set("mdock-find", all);
  CSS.highlights.set("mdock-find-current", cur);
}

export function setFindHighlights(id: string, ranges: Range[], current: number) {
  if (ranges.length) registry.set(id, { ranges, current });
  else registry.delete(id);
  apply();
}

export function clearFindHighlights(id: string) {
  if (registry.delete(id)) apply();
}
