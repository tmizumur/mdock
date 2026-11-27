// @vitest-environment jsdom

import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { previewSearchBlock } from "./folderSearch";
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
  it("全文検索でインデント形式のコードブロック内の行に移動できる", () => {
    const preview = document.createElement("div");
    preview.append(render("本文\n\n    最初の行\n    一致する行\n\n続き"));
    const block = preview.querySelector("pre[data-line='2']");

    expect(block?.textContent).toContain("一致する行");
    expect(previewSearchBlock(preview, 3)).toEqual({ block, blockLine: 2 });
  });

  it("最上位の数式ブロックと math フェンスに行番号を付ける", async () => {
    await loadMath();
    const html = render("本文\n\n$$\nx^2\n$$\n\n```math\ny^2\n```");

    expect(html.querySelector("p.katex-block[data-line='2']")).not.toBeNull();
    expect(html.querySelector("p.katex-block[data-line='6']")).not.toBeNull();
  });

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

  it("GitHub 形式のアンカーを付け、重複を文書ごとに数える", () => {
    const src = "# Setup: Install\n\n# 日本語の 見出し\n\n# C++ & Rust\n\n# Setup: Install\n\n# Setup: Install";
    const ids = () => Array.from(render(src).querySelectorAll("h1"), (heading) => heading.id);

    expect(ids()).toEqual(["setup-install", "日本語の-見出し", "c--rust", "setup-install-1", "setup-install-2"]);
    expect(ids()[0]).toBe("setup-install");
  });

  it("タスクリストを未チェックとチェック済みのチェックボックスに変換する", () => {
    const items = Array.from(render("- [ ] 未完了\n- [x] 完了").querySelectorAll("ul > li"));
    const boxes = items.map((item) => item.querySelector<HTMLInputElement>('input[type="checkbox"]'));

    expect(boxes.map((box) => box?.checked)).toEqual([false, true]);
    expect(boxes.map((box) => box?.disabled)).toEqual([true, true]);
    expect(items.map((item) => item.textContent?.trim())).toEqual(["未完了", "完了"]);
  });

  it("チェックボックス化をリスト項目の最初の段落に限定する", () => {
    const html = render("[x] 本文\n\n> [x] 引用\n\n1. [x] 項目\n\n   [x] 続き\n\n   - [ ] 下位項目");

    expect(html.querySelectorAll("input[type='checkbox']")).toHaveLength(2);
    expect(html.querySelector("ol > li > p > input:checked")).not.toBeNull();
    expect(html.querySelector("li > ul > li > input:not(:checked)")).not.toBeNull();
    expect(Array.from(html.querySelectorAll("p"), (p) => p.textContent)).toEqual([
      "[x] 本文", "[x] 引用", " 項目", "[x] 続き",
    ]);
  });

  it.each(["---", "..."])("フロントマターを表にし、%s 以降の行番号を保つ", (end) => {
    const src = [
      "---", "title: <em>題名</em>", "tags: [a, b]", "author:", "  name: 太郎",
      "# YAML 内のコメント", end, "", "# 見出し", "", "本文",
    ].join("\r\n");
    const html = render(src);

    expect(html.querySelector("details.front-matter[data-line='0'] > summary")?.textContent).toBe("フロントマター");
    expect(Array.from(html.querySelectorAll("details td"), (cell) => cell.textContent)).toEqual([
      "<em>題名</em>", "[a, b]", "  name: 太郎",
    ]);
    expect(html.querySelector("details em, hr")).toBeNull();
    expect(html.querySelector("h1")?.dataset.line).toBe("8");
    expect(html.querySelector("p")?.dataset.line).toBe("10");
    expect(markdownHeadings(src)).toEqual([{ level: 1, text: "見出し", line: 8 }]);
  });

  it("閉じていない区切りや途中の横線は Markdown として扱う", () => {
    expect(render("---\n\n本文").querySelector("hr")).not.toBeNull();
    expect(render("本文\n\n---\n\n---").querySelectorAll("hr")).toHaveLength(2);
  });

  it.each([
    "# はじめに\n\n本文",
    "# はじめに\ntitle: 題名\n\n本文",
    "title: 題名\n\n# はじめに\n\n本文",
    "- 先頭の項目: 値\n\n# はじめに\n\n本文",
    "  先頭の継続行\n\n# はじめに\n\n本文",
  ])("マッピングの条件を満たさなければ区切りの内側を Markdown として描画する", (body) => {
    const src = `---\n\n${body}\n\n---`;
    const html = render(src);

    expect(html.querySelector(".front-matter")).toBeNull();
    expect(html.querySelectorAll("hr")).toHaveLength(2);
    expect(html.querySelector("h1")?.textContent).toBe("はじめに");
    expect(html.querySelector("p:last-of-type")?.textContent).toBe("本文");
    expect(markdownHeadings(src)[0]?.text).toBe("はじめに");
  });

  it("引用符付きキーとブロックスカラーを表に表示し、空行と HTML エスケープを保つ", () => {
    const html = render([
      "---", "", '"foo:bar": value', "'a:''<i>': |", "  <em>1 行目</em>", "", "    3 行目  ",
      "folded: >", "", "  A", "  B", "", "tags:", "- a: b", "- c", "# コメント", "---",
    ].join("\n"));

    expect(Array.from(html.querySelectorAll(".front-matter th"), (cell) => cell.textContent)).toEqual([
      "foo:bar", "a:'<i>", "folded", "tags",
    ]);
    expect(Array.from(html.querySelectorAll(".front-matter td"), (cell) => cell.textContent)).toEqual([
      "value", "  <em>1 行目</em>\n\n    3 行目  ", "\n  A\n  B\n", "- a: b\n- c",
    ]);
    expect(html.querySelector(".front-matter em, .front-matter i")).toBeNull();
  });

  it.each([
    ["NOTE", "note", "Note"],
    ["tip", "tip", "Tip"],
    ["IMPORTANT", "important", "Important"],
    ["Warning", "warning", "Warning"],
    ["CAUTION", "caution", "Caution"],
  ])("引用の [!%s] を注記に変換する", (marker, kind, title) => {
    const html = render(`> [!${marker}]  \n> **本文**\n>\n> 続き\n\n> 通常の引用\n> [!NOTE]`);
    const alert = html.querySelector(`div.markdown-alert.markdown-alert-${kind}[data-line='0']`);

    expect(alert?.querySelector(".markdown-alert-title")?.textContent).toMatch(new RegExp(` ${title}$`));
    expect(alert?.querySelector("strong")?.textContent).toBe("本文");
    expect(alert?.lastElementChild?.textContent).toBe("続き");
    expect(alert?.textContent).not.toContain("[!");
    expect(html.querySelector("blockquote")?.textContent).toContain("[!NOTE]");
  });

  it("入れ子の引用とリスト内の引用は注記に変換しない", () => {
    const html = render([
      "> > [!NOTE]\n> > 入れ子", "- > [!TIP]\n  > リスト内",
      "> [!WARNING]\n> 最上位\n>\n> > [!CAUTION]\n> > 注記内",
    ].join("\n\n"));

    expect(html.querySelectorAll(".markdown-alert")).toHaveLength(1);
    expect(html.querySelector("blockquote blockquote")?.textContent).toContain("[!NOTE]");
    expect(html.querySelector("li blockquote")?.textContent).toContain("[!TIP]");
    expect(html.querySelector(".markdown-alert-warning blockquote")?.textContent).toContain("[!CAUTION]");
  });

  it("生 HTML を含む脚注でも、複数の参照と戻り先の ID が一致する", () => {
    const html = render("本文 <kbd>キー</kbd>[^1]、再参照[^1]。\n\n[^1]: 脚注の <em>本文</em>。\n\n    続きの段落。");
    const refs = Array.from(html.querySelectorAll(".footnote-ref a"));
    const footnote = html.querySelector(".footnotes .footnote-item");

    expect(footnote?.id).toBe("fn1");
    expect(footnote?.querySelector("em")?.textContent).toBe("本文");
    expect(footnote?.querySelectorAll("p")).toHaveLength(2);
    expect(refs.map((ref) => ref.getAttribute("href"))).toEqual(["#fn1", "#fn1"]);
    expect(refs.map((ref) => ref.id)).toEqual(["fnref1", "fnref1:1"]);
    expect(Array.from(footnote?.querySelectorAll(".footnote-backref") ?? [], (link) => link.getAttribute("href")))
      .toEqual(refs.map((ref) => `#${ref.id}`));
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

  it.each(["fixed", "ABSOLUTE !important", "sticky", "var(--pos)"])(
    "生 HTML の position: %s と重なりを制御する宣言を除去する",
    (position) => {
      const html = render(`<a style="position:${position};inset:0;z-index:9999" href="https://example.com">リンク</a>`);

      expect(html.querySelector("a")?.hasAttribute("style")).toBe(false);
    },
  );

  it("生 HTML ブロック内の KaTeX と色のスタイルを残す", async () => {
    await loadMath();
    const html = render([
      '<div id="math-block" style="position:relative;top:1px;z-index:9999;color:var(--fg);background-color:var(--bg)">',
      "",
      "$\\frac{1}{2}$",
      "",
      "</div>",
    ].map((line) => `> ${line}`).join("\n"));

    const style = html.querySelector<HTMLDivElement>("#math-block")?.style;
    expect(style?.position).toBe("relative");
    expect(style?.top).toBe("1px");
    expect(style?.zIndex).toBe("");
    expect(style?.color).toBe("var(--fg)");
    expect(style?.backgroundColor).toBe("var(--bg)");
    expect(html.querySelector("#math-block .katex-html span[style*='height:']")).not.toBeNull();
    expect(html.querySelector("#math-block .katex-html span[style*='vertical-align:']")).not.toBeNull();
    expect(html.querySelector("#math-block .katex-html span[style*='top:']")).not.toBeNull();
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
