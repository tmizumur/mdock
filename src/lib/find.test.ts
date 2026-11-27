// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { FIND_LIMIT, findRanges } from "./find";

function root(html: string) {
  const el = document.createElement("article");
  el.innerHTML = html;
  return el;
}

describe("プレビュー内検索", () => {
  it("描画後の Mermaid 図（SVG の text と foreignObject）の文字も対象にする", () => {
    const el = root(`
      <p>開始 の説明</p>
      <div class="mermaid-block"><svg><title>開始</title><style>.a{}</style>
        <g><text>開始</text></g>
        <foreignObject><div><span>完了</span></div></foreignObject>
      </svg></div>`);
    expect(findRanges(el, "開始").map((r) => r.startContainer.parentElement?.tagName.toLowerCase())).toEqual(["p", "text"]);
    expect(findRanges(el, "完了")).toHaveLength(1);
  });

  it("図の中のラベルをまたいで一致させない", () => {
    const el = root(`<svg><text>ab</text><text>cd</text></svg>`);
    expect(findRanges(el, "bc")).toHaveLength(0);
  });

  it("KaTeX の読み上げ用テキストとボタンは対象にしない", () => {
    const el = root(`<span class="katex-mathml">x</span><button>x</button><p>x</p>`);
    expect(findRanges(el, "x")).toHaveLength(1);
  });

  it("上限は 5,000 件より大きい", () => {
    expect(FIND_LIMIT).toBeGreaterThanOrEqual(100_000);
    const el = root(`<p>${"a ".repeat(6000)}</p>`);
    expect(findRanges(el, "a")).toHaveLength(6000);
  });
});
