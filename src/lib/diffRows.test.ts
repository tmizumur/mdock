import { describe, expect, it } from "vitest";
import { buildRows, computeRows, foldRows, isTooLarge, type Row } from "./diffRows";

describe("buildRows", () => {
  it("変更なしの行に左右同じ行番号を付ける", () => {
    expect(buildRows("a\n\nb\n", "a\n\nb\n")).toEqual({
      rows: ["a", "", "b"].map((text, index) => ({
        left: { n: index + 1, text }, right: { n: index + 1, text }, kind: "same",
      })),
      added: 0,
      removed: 0,
    });
    expect(buildRows("", "")).toEqual({ rows: [], added: 0, removed: 0 });
  });

  it("追加行のあとも左右の行番号を別々に進める", () => {
    expect(buildRows("b\n", "a\nb\n")).toEqual({
      rows: [
        { left: null, right: { n: 1, text: "a" }, kind: "add" },
        { left: { n: 1, text: "b" }, right: { n: 2, text: "b" }, kind: "same" },
      ],
      added: 1,
      removed: 0,
    });
  });

  it("削除行のあとも左右の行番号を別々に進める", () => {
    expect(buildRows("a\nb\n", "b\n")).toEqual({
      rows: [
        { left: { n: 1, text: "a" }, right: null, kind: "del" },
        { left: { n: 2, text: "b" }, right: { n: 1, text: "b" }, kind: "same" },
      ],
      added: 0,
      removed: 1,
    });
  });

  it("削除と追加を横に並べ、余った削除は片側だけに出す", () => {
    expect(buildRows("a\nb\nc\n", "x\nc\n")).toEqual({
      rows: [
        { left: { n: 1, text: "a" }, right: { n: 1, text: "x" }, kind: "change" },
        { left: { n: 2, text: "b" }, right: null, kind: "del" },
        { left: { n: 3, text: "c" }, right: { n: 2, text: "c" }, kind: "same" },
      ],
      added: 1,
      removed: 2,
    });
  });
});

describe("isTooLarge", () => {
  it("左右の合計が 20,000 行で上限に達する", () => {
    const left = "\n".repeat(10_000);
    const right = "\n".repeat(9_999);
    expect(isTooLarge(left, right)).toBe(false);
    expect(isTooLarge(left, right + "a")).toBe(true);
  });

  it("左右の length の合計が 4,000,000 で上限に達する", () => {
    const left = "😀".repeat(1_000_000);
    const right = "a".repeat(1_999_999);
    expect(isTooLarge(left, right)).toBe(false);
    expect(isTooLarge(left, right + "a")).toBe(true);
  });
});

function sampleRows(kinds: Row["kind"][]): Row[] {
  return kinds.map((kind, index) => {
    const cell = { n: index + 1, text: String(index + 1) };
    return { kind, left: cell, right: cell };
  });
}

const same = (count: number) => Array<Row["kind"]>(count).fill("same");
const rowItems = (rows: Row[]) => rows.map((row) => ({ type: "row", row }));

describe("foldRows", () => {
  it("中間の変更なしを前後 3 行ずつ残してたたむ", () => {
    const rows = sampleRows(["change", ...same(10), "change"]);
    expect(foldRows(rows)).toEqual([
      ...rowItems(rows.slice(0, 4)),
      { type: "fold", id: 4, start: 4, end: 8, count: 4 },
      ...rowItems(rows.slice(8)),
    ]);
  });

  it("先頭と末尾では変更に接する側だけ 3 行残す", () => {
    const rows = sampleRows([...same(6), "change", ...same(7)]);
    expect(foldRows(rows)).toEqual([
      { type: "fold", id: 0, start: 0, end: 3, count: 3 },
      ...rowItems(rows.slice(3, 10)),
      { type: "fold", id: 10, start: 10, end: 14, count: 4 },
    ]);
  });

  it.each([5, 6, 7])("たためる行が 1 行以下なら全行を返す（中間 %i 行）", (count) => {
    const rows = sampleRows([...same(4), "change", ...same(count), "change", ...same(4)]);
    expect(foldRows(rows)).toEqual(rowItems(rows));
  });

  it("変更がなければ全行を返す", () => {
    const rows = sampleRows(same(20));
    expect(foldRows(rows)).toEqual(rowItems(rows));
  });

  it("指定した id だけを展開する", () => {
    const rows = sampleRows([...same(6), "change", ...same(7)]);
    expect(foldRows(rows, 3, new Set([0]))).toEqual([
      ...rowItems(rows.slice(0, 10)),
      { type: "fold", id: 10, start: 10, end: 14, count: 4 },
    ]);
  });
});

describe("computeRows", () => {
  it("通常の差分を計算する", () => {
    expect(computeRows("a\nb", "a\nc")).toEqual(buildRows("a\nb", "a\nc"));
  });

  it("上限に達する入力には行を返さない", () => {
    expect(computeRows("", "\n".repeat(20_000))).toEqual({ tooLarge: true });
  });
});
