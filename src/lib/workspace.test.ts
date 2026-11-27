import { describe, expect, it } from "vitest";
import { presetLayout } from "./layout";
import { type DocTab, emptyPane } from "./tabs";
import { type Workspace, closeTabIn, dropIfEmpty, resetLayoutIn } from "./workspace";

const tab: DocTab = { kind: "doc", id: "notes", path: "/notes.md", mode: "view", content: "", saved: "" };

describe("タブを閉じた後のペイン", () => {
  it("前面のペインで最後のタブを閉じると、そのペインが消えて隣にフォーカスが移る", () => {
    const main = { tabs: [tab], active: 0 };
    const other = { tabs: [{ ...tab, id: "guide", path: "/guide.md" }], active: 0 };
    const w: Workspace = {
      layout: presetLayout("cols2", ["main", "other"]),
      panes: { main, other },
    };
    expect(closeTabIn(w, "other", "guide", "other")).toEqual({
      w: { layout: { type: "pane", id: "main" }, panes: { main } },
      focus: "main",
    });
  });

  it("ワークスペースに一つしかペインがなければ、空でも残す", () => {
    const w: Workspace = {
      layout: presetLayout("single", ["main"]),
      panes: { main: emptyPane() },
    };

    expect(dropIfEmpty(w, "main")).toEqual({ w });
  });
});

describe("ペインをまとめるとき", () => {
  it("同じファイルの固定のタブと仮のタブをまとめたら、残したタブを固定する", () => {
    const w: Workspace = {
      layout: presetLayout("cols2", ["left", "right"]),
      panes: { left: { tabs: [tab], active: 0 }, right: { tabs: [{ ...tab, id: "copy", preview: true }], active: 0 } },
    };
    const right = resetLayoutIn(w, "right");
    expect(right.w.panes.right.tabs).toEqual([{ ...tab, id: "copy", preview: undefined }]);
    expect(right.discardedTabIds).toEqual(["notes"]);
    const left = resetLayoutIn(w, "left");
    expect(left.w.panes.left.tabs).toEqual([tab]);
  });
});
