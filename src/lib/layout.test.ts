import { describe, expect, it } from "vitest";
import { flipOuter, leaves, presetLayout, removeLeaf, splitLeaf } from "./layout";
import { type DocTab } from "./tabs";
import { type Workspace, toggleSplitIn } from "./workspace";

describe("分割レイアウト", () => {
  it.each([
    { first: "row", next: "col" },
    { first: "col", next: "row" },
  ] as const)("$first で分割して $next に切り替え、同じ向きでもう一度押すとタブを引き継いで単一ペインに戻る", ({ first, next }) => {
    const tab: DocTab = { kind: "doc", id: "notes", path: "/notes.md", mode: "view", content: "", saved: "" };
    const guide = { ...tab, id: "guide", path: "/guide.md" };
    const todo = { ...tab, id: "todo", path: "/todo.md" };
    const single: Workspace = {
      layout: { type: "pane", id: "main" },
      panes: { main: { tabs: [tab], active: 0 } },
    };
    const { w: split } = toggleSplitIn(single, "main", first, { panes: ["other"], split: "split" });
    const withTabs = { ...split, panes: { ...split.panes, other: { tabs: [guide, todo], active: 1 } } };
    const { w: flipped } = toggleSplitIn(withTabs, "other", next);

    expect(split.layout).toMatchObject({ type: "split", dir: first, sizes: [50, 50] });
    expect(flipped.layout).toMatchObject({ type: "split", dir: next, sizes: [50, 50] });
    expect(leaves(flipped.layout)).toEqual(["main", "other"]);

    const collapsed = toggleSplitIn(flipped, "other", next);
    expect(collapsed.w).toEqual({
      layout: { type: "pane", id: "other" },
      panes: { other: { tabs: [guide, todo, tab], active: 1 } },
    });
    expect(collapsed.focus).toBeUndefined();
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
