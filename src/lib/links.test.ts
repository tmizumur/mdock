import { describe, expect, it } from "vitest";
import { classifyLink, localLinkAction } from "./links";

const base = "/workspace/docs/guide.md";

describe("リンクの判定", () => {
  it.each(["http://example.com", "HTTPS://example.com", "mailto:a@example.com"])("%s は直接開く", (url) => {
    expect(classifyLink(url, base)).toEqual({ kind: "external", url });
  });

  it.each(["vscode://file/path", "x-apple.systempreferences:example", "smb://server/share", "tel:123"])(
    "%s を開く前に確認する",
    (url) => expect(classifyLink(url, base)).toEqual({ kind: "confirm-url", url }),
  );

  it.each(["\u0001JaVa\tscript:alert(1)", "vbscript:alert(1)", "data:image/png;base64,AA=="])("%s は開かない", (url) => {
    expect(classifyLink(url, base)).toEqual({ kind: "blocked" });
  });

  it("アンカー、相対パス、file URL を解決する", () => {
    expect(classifyLink("#heading", base)).toEqual({ kind: "anchor", hash: "heading" });
    expect(classifyLink("../about.md?mode=preview#intro", base)).toEqual({
      kind: "local", path: "/workspace/about.md", hash: "intro",
    });
    expect(classifyLink("FILE:///workspace/My%20File.pdf", base)).toEqual({
      kind: "local", path: "/workspace/My File.pdf", hash: undefined,
    });
  });
});

describe("ローカル項目の扱い", () => {
  const file = { is_dir: false, is_executable: false };

  it.each(["app", "command", "sh", "tool", "terminal", "workflow", "pkg", "dmg", "jar", "scpt", "applescript", "action", "exe", "BAT"])(
    ".%s は Finder で表示する",
    (ext) => expect(localLinkAction(`/workspace/example.${ext}`, file)).toBe("reveal"),
  );

  it("フォルダと実行権限のあるファイルは Finder で表示する", () => {
    expect(localLinkAction("/workspace/folder.md", { is_dir: true })).toBe("reveal");
    expect(localLinkAction("/workspace/bin", { is_dir: false, is_executable: true })).toBe("reveal");
  });

  it("Markdown はプレビュー、画像と PDF は既定のアプリで開く", () => {
    expect(localLinkAction("/workspace/guide.MDX", file)).toBe("markdown");
    expect(localLinkAction("/workspace/image.png", file)).toBe("open");
    expect(localLinkAction("/workspace/file.pdf", file)).toBe("open");
  });
});
