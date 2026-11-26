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
