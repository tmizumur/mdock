import { describe, expect, it } from "vitest";
import { previewMatchIndex, sourceMatch, splitMatch, type SearchLocation } from "./folderSearch";

describe("フォルダ検索の一致位置", () => {
  const location: SearchLocation = { line: 2, nonce: 1, column: 5, length: 2, query: "一致", matchText: "一致" };

  it("UTF-16 の位置で、日本語と絵文字を含む抜粋を分割する", () => {
    expect(splitMatch({ text: "…日😀一致の後…", start: 4, end: 6 }))
      .toEqual({ before: "…日😀", match: "一致", after: "の後…" });
    expect(splitMatch({ text: "😀日", start: 2, end: 2 }))
      .toEqual({ before: "😀", match: "", after: "日" });
  });

  it("元の行から完全な一致を取り出し、編集でずれた範囲は強調しない", () => {
    expect(sourceMatch("日😀abc続き", { ...location, column: 3, length: 3, matchText: "ab" })).toBe("abc");
    expect(sourceMatch("😀一致の後", location)).toBe("");
  });

  it("プレビューの同じブロックに複数ある一致を順番で選ぶ", () => {
    const lines = ["別の一致", "段落に一致", "日😀一致一致"];
    expect(previewMatchIndex(lines, 1, location, "一致")).toBe(2);
  });
});
