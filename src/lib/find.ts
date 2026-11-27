/**
 * プレビュー内のファイル内検索。
 * 一致箇所は DOM を書き換えずに CSS Custom Highlight API で色を付ける
 * （::highlight(mdock-find) / ::highlight(mdock-find-current)）。
 */

/** 検索対象にしない部分（ボタンの文字や、KaTeX の読み上げ用の重複テキストなど）。Mermaid 図の文字は対象にする */
const SKIP = "button, script, style, svg title, svg desc, .katex-mathml, .find-skip";
/** この単位ごとに区切る（段落や、図の中のラベルをまたいだ一致を防ぐ） */
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, div, figcaption, text, foreignObject";
/** 一致の数の上限（これを超えたら打ち切る） */
export const FIND_LIMIT = 100_000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** root の中で query に一致する範囲をすべて返す（要素をまたいでも見つける） */
export function findRanges(root: HTMLElement, query: string, caseSensitive = false): Range[] {
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
  const re = new RegExp(escapeRe(query), caseSensitive ? "gu" : "giu");
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
  for (let m = re.exec(text); m && ranges.length < FIND_LIMIT; m = re.exec(text)) {
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

/**
 * 一致箇所すべて（mdock-find）と、今の一致（mdock-find-current、上に重ねて描く）。
 * 件数が多くても「次へ」が重くならないよう、一致の一覧が変わったときだけ全体を作り直す。
 */
function apply(rebuildAll: boolean) {
  if (!highlightSupported()) return;
  if (rebuildAll) {
    const all = new Highlight();
    for (const { ranges } of registry.values()) for (const r of ranges) all.add(r);
    CSS.highlights.set("mdock-find", all);
  }
  const cur = new Highlight();
  cur.priority = 1;
  for (const { ranges, current } of registry.values()) {
    const r = ranges[current];
    if (r) cur.add(r);
  }
  CSS.highlights.set("mdock-find-current", cur);
}

export function setFindHighlights(id: string, ranges: Range[], current: number) {
  const prev = registry.get(id);
  const changed = prev?.ranges !== ranges;
  if (ranges.length) registry.set(id, { ranges, current });
  else registry.delete(id);
  apply(changed || !ranges.length);
}

export function clearFindHighlights(id: string) {
  if (registry.delete(id)) apply(true);
}
