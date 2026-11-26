import { describe, expect, it } from "vitest";
import { indexTree, isMoveMatch } from "./liveReload";

const existing = "/docs/keep.md";
const added = "/docs/new/sub/file.md";
const text = "# 見出し\n";
const previous = indexTree([{ path: existing, name: "keep.md", is_dir: false, children: [] }]);

describe("移動先の推定", () => {
  it("既存のパスは同じ内容でも移動先にしない", () => {
    expect(isMoveMatch(previous, "/docs/KEEP.md", text, text)).toBe(false);
  });

  it("新しいパスで内容が一致すれば移動先にする", () => {
    expect(isMoveMatch(previous, added, text, text)).toBe(true);
    expect(isMoveMatch(previous, added, text, "別の内容")).toBe(false);
  });

  it.each(["", " \t\n"])("内容が空か空白だけなら移動先にしない（%j）", (blank) => {
    expect(isMoveMatch(previous, added, blank, blank)).toBe(false);
  });
});
