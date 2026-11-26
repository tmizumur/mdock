// @vitest-environment jsdom

import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { isRelative, loadMath, localSrc, markdownHeadings, renderMarkdown } from "./markdown";

const base = "/workspace/docs/guide.md";
const imageUrl = "asset://localhost/%2Fworkspace%2Fimages%2F%E7%8C%AB%20photo.png";

function render(src: string, basePath?: string) {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(src, basePath);
  return template.content;
}

afterEach(clearMocks);

describe("Markdown の描画", () => {
  it("見出しにアンカーを付け、アウトラインに見出しの行番号を返す", () => {
    const src = "# Hello World\n\n本文\n\n## Use `code`";
    const html = render(src);

    expect(html.querySelector("h1")?.id).toBe("hello-world");
    expect(html.querySelector("h2")?.id).toBe("use-code");
    expect(markdownHeadings(src)).toEqual([
      { level: 1, text: "Hello World", line: 0 },
      { level: 2, text: "Use code", line: 4 },
    ]);
  });

  it("相対画像を Markdown ファイルの位置から解決する", () => {
    mockConvertFileSrc("macos");
    const src = "![猫](../images/猫%20photo.png?size=2#preview)\n\n![外部](https://example.com/image.png)";
    const [local, remote] = Array.from(render(src, base).querySelectorAll("img"));

    expect(local.getAttribute("src")).toBe(imageUrl);
    expect(local.getAttribute("data-local")).toBe("1");
    expect(remote.getAttribute("src")).toBe("https://example.com/image.png");
    expect(remote.hasAttribute("data-local")).toBe(false);
    expect(render(src).querySelector("img")?.getAttribute("src")).toBe(
      "../images/%E7%8C%AB%20photo.png?size=2#preview",
    );
  });

  it("タスクリストを未チェックとチェック済みのチェックボックスに変換する", () => {
    const items = Array.from(render("- [ ] 未完了\n- [x] 完了").querySelectorAll("ul > li"));
    const boxes = items.map((item) => item.querySelector<HTMLInputElement>('input[type="checkbox"]'));

    expect(boxes.map((box) => box?.checked)).toEqual([false, true]);
    expect(boxes.map((box) => box?.disabled)).toEqual([true, true]);
    expect(items.map((item) => item.textContent?.trim())).toEqual(["未完了", "完了"]);
  });

  it("KaTeX の読み込み後にインラインとブロックの数式を描画する", async () => {
    await loadMath();
    const html = render("変数は $x$ です。\n\n$$\nx^2\n$$");

    expect(html.querySelector("p .katex .katex-html")).not.toBeNull();
    expect(html.querySelector(".katex-display .katex .katex-html")).not.toBeNull();
  });

  it("生 HTML の危険な要素、属性、URL を除去する", () => {
    const html = render([
      '<script>alert(1)</script><style>body { display: none }</style>',
      '<iframe src="https://example.com"></iframe><object></object><embed>',
      '<base href="https://example.com"><meta http-equiv="refresh"><link rel="stylesheet">',
      '<form><input type="text"><input type="checkbox"></form>',
      '<img src="./a.png" onerror="alert(1)" data-line="7">',
      '<a href="java&#9;script:alert(1)" onclick="alert(1)">JS</a>',
      '<a href="vbscript:alert(1)">VB</a><a href="data:image/png;base64,AA==">Data</a>',
      '<img src="data:text/html,unsafe"><img src="data:image/png;base64,AA==">',
      '<picture><source srcset="ok.png 1x, javascript:alert(1) 2x"><img src="./fallback.png"></picture>',
    ].join("\n\n"), base);

    expect(html.querySelector("script, style, iframe, object, embed, base, meta, link, form, input")).toBeNull();
    expect(html.querySelector("[onerror], [onclick], a[href], [srcset]")).toBeNull();
    expect(html.querySelector("img[data-line='7']")?.getAttribute("src")).toBe("./a.png");
    expect(html.querySelector("img[src^='data:']")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(html.querySelectorAll("img[src^='data:']")).toHaveLength(1);
  });

  it("Markdown リンクに画像データの URL を付けない", () => {
    const html = render("[リンク](data:image/png;base64,AA==) ![画像](data:image/png;base64,AA==)");

    expect(html.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(html.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });

  it("インライン HTML の危険な属性を除去する", () => {
    const html = render('本文 <kbd onmouseover="alert(1)">⌘</kbd> <img src="./a.png" onerror="alert(1)">');

    expect(html.querySelector("kbd")?.textContent).toBe("⌘");
    expect(html.querySelector("img")?.getAttribute("src")).toBe("./a.png");
    expect(html.querySelector("[onmouseover], [onerror]")).toBeNull();
  });

  it("段落をまたぐ生 HTML を無害化する", () => {
    const html = render('本文 <b>強調\n\n続き <img src="./a.png" onerror="alert(1)">');

    expect(html.querySelector("b > p")?.textContent).toContain("続き");
    expect(html.querySelector("[onerror]")).toBeNull();
  });

  it("本文の HTML とプレビューに必要な要素、属性を残す", async () => {
    await loadMath();
    const html = render([
      "# Hello World",
      '<details open><summary>補足</summary><kbd>⌘</kbd><sup>2</sup><sub>3</sub></details>',
      '<picture><source srcset="small.png 1x, large.png 2x"><img src="small.png"></picture>',
      '<a name="note" id="custom" title="注記" href="vscode://example">注記</a>',
      '<input type="checkbox" disabled checked>',
      "- [x] 完了",
      "$x^2$",
      "キーは <kbd>⌘</kbd>。$\\sqrt{2}$",
      "```js\nx\n```",
      "```mermaid\nflowchart LR\nA --> B\n```",
    ].join("\n\n"));

    expect(html.querySelector("h1#hello-world[data-line]")).not.toBeNull();
    expect(html.querySelector("details[open] > summary")?.textContent).toBe("補足");
    expect(html.querySelector("details > kbd + sup + sub")).not.toBeNull();
    expect(html.querySelector("picture > source")?.getAttribute("srcset")).toBe("small.png 1x, large.png 2x");
    expect(html.querySelector("a#custom[name='note'][title='注記']")?.getAttribute("href")).toBe("vscode://example");
    expect(html.querySelectorAll("input[type='checkbox'][disabled][checked]")).toHaveLength(2);
    expect(html.querySelector("math > semantics msup")).not.toBeNull();
    expect(html.querySelector("math annotation")?.textContent).toBe("x^2");
    expect(html.querySelector(".katex-html[aria-hidden='true'] span[style]")).not.toBeNull();
    expect(html.querySelector(".katex-html svg[viewBox] path[d]")).not.toBeNull();
    expect(html.querySelector("button.copy-btn + pre[data-lang='js']")).not.toBeNull();
    expect(html.querySelector(".mermaid-block[data-line] > pre.mermaid")).not.toBeNull();
  });
});

describe("画像のパス", () => {
  it("localSrc はパスをデコードし、クエリとフラグメントを除く", () => {
    mockConvertFileSrc("macos");

    expect(localSrc(base, "../images/%E7%8C%AB%20photo.png?size=2#preview")).toBe(imageUrl);
    expect(localSrc(base, "/workspace/images/猫%20photo.png")).toBe(imageUrl);
  });

  it.each([
    ["./image.png", true],
    ["../images/猫 photo.png", true],
    ["images/image.png", true],
    ["/images/image.png", false],
    ["//example.com/image.png", false],
    ["https://example.com/image.png", false],
    ["data:image/png;base64,AA==", false],
    ["#heading", false],
    ["", false],
  ])("isRelative(%j) は %s を返す", (src, expected) => {
    expect(isRelative(src)).toBe(expected);
  });
});
