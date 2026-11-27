import { describe, expect, it } from "vitest";
import { outlineRows, visibleCurrent } from "./outline";

const h = (level: number, text: string) => ({ level, text });
// 0 概要 / 1  導入 / 2   背景 / 3  手順 / 4 付録 / 5  用語
const headings = [h(1, "概要"), h(2, "導入"), h(3, "背景 Setup"), h(2, "手順"), h(1, "付録"), h(2, "用語 setup")];

describe("アウトラインの行", () => {
  it("折りたたみがなければ全部出し、子を持つ見出しに印を付ける", () => {
    const rows = outlineRows(headings, "", new Set());
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.filter((r) => r.hasChildren).map((r) => r.index)).toEqual([0, 1, 4]);
  });

  it("折りたたんだ見出しの子孫を隠す", () => {
    expect(outlineRows(headings, "", new Set([1])).map((r) => r.index)).toEqual([0, 1, 3, 4, 5]);
    expect(outlineRows(headings, "", new Set([0])).map((r) => r.index)).toEqual([0, 4, 5]);
  });

  it("絞り込みでは一致した見出しと、その親を薄く出す（大文字小文字は区別しない、折りたたみは無視）", () => {
    const rows = outlineRows(headings, "SETUP", new Set([0]));
    expect(rows.map((r) => [r.index, r.dim])).toEqual([[0, true], [1, true], [2, false], [4, true], [5, false]]);
    expect(outlineRows(headings, "ない", new Set())).toEqual([]);
  });

  it("今いる見出しが隠れていたら、表示されている一番近い親を返す", () => {
    const rows = outlineRows(headings, "", new Set([0]));
    expect(visibleCurrent(headings, rows, 2)).toBe(0);
    expect(visibleCurrent(headings, rows, 5)).toBe(5);
    expect(visibleCurrent(headings, rows, -1)).toBe(-1);
  });
});
