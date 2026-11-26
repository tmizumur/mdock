import { describe, expect, it } from "vitest";
import { flipOuter, leaves, presetLayout, removeLeaf, splitLeaf } from "./layout";

describe("分割レイアウト", () => {
  it.each([
    { preset: "cols2", first: "row", next: "col" },
    { preset: "rows2", first: "col", next: "row" },
  ] as const)("$preset で分割し、向きを切り替えてから単一ペインに戻す", ({ preset, first, next }) => {
    const single = presetLayout("single", ["main"]);
    const split = presetLayout(preset, ["main", "other"]);
    const flipped = flipOuter(split, next);

    expect(split).toMatchObject({ type: "split", dir: first, sizes: [50, 50] });
    expect(flipped).toMatchObject({ type: "split", dir: next, sizes: [50, 50] });
    expect(leaves(flipped)).toEqual(["main", "other"]);
    expect(presetLayout("single", [leaves(flipped)[0]])).toEqual(single);
  });

  it("向きの切り替えで同じ向きになった子の分割をまとめる", () => {
    const row = presetLayout("cols2", ["main", "other"]);
    const nested = splitLeaf(row, "other", "bottom", "new");
    const flipped = flipOuter(nested, "col");

    expect(flipped).toMatchObject({
      type: "split",
      dir: "col",
      sizes: [50, 25, 25],
      children: [
        { type: "pane", id: "main" },
        { type: "pane", id: "other" },
        { type: "pane", id: "new" },
      ],
    });
  });

  it.each([
    ["left", "row", ["main", "new", "other"], [50, 25, 25]],
    ["right", "row", ["main", "other", "new"], [50, 25, 25]],
    ["top", "col", ["main", "new", "other"], [50, 50]],
    ["bottom", "col", ["main", "other", "new"], [50, 50]],
  ] as const)("%s 側にペインを追加する", (side, dir, order, sizes) => {
    const row = presetLayout("cols2", ["main", "other"]);
    const next = splitLeaf(row, "other", side, "new");

    expect(leaves(next)).toEqual(order);
    expect(next).toMatchObject({ type: "split", dir: "row", sizes });
    if (dir === "col" && next.type === "split") {
      expect(next.children[1]).toMatchObject({ type: "split", dir, sizes: [50, 50] });
    }
  });

  it("removeLeaf は子が一つになった分割を畳む", () => {
    const row = presetLayout("cols2", ["main", "other"]);
    const nested = splitLeaf(row, "other", "bottom", "new");

    expect(removeLeaf(nested, "new")).toEqual(row);
    expect(removeLeaf(row, "other")).toEqual({ type: "pane", id: "main" });
  });
});
