import { describe, expect, it } from "vitest";
import { presetLayout } from "./layout";
import { type DocTab, emptyPane } from "./tabs";
import { type Workspace, activeAfterRemove, dropIfEmpty } from "./workspace";

const tab: DocTab = { kind: "doc", id: "notes", path: "/notes.md", mode: "view", content: "", saved: "" };

describe("タブを閉じた後のペイン", () => {
  it("最後のタブを閉じるとペインが消え、隣のペインに移る", () => {
    const main = { tabs: [tab], active: 0 };
    const other = { tabs: [{ ...tab, id: "guide", path: "/guide.md" }], active: 0 };
    const w: Workspace = {
      layout: presetLayout("cols2", ["main", "other"]),
      panes: { main, other },
    };
    expect(dropIfEmpty(w, "other").w).toBe(w);

    const { tabs, active } = w.panes.other;
    const remaining = tabs.slice(1);
    const closed = {
      ...w,
      panes: {
        ...w.panes,
        other: { tabs: remaining, active: activeAfterRemove(active, 0, remaining.length) },
      },
    };

    expect(dropIfEmpty(closed, "other")).toEqual({
      w: { layout: { type: "pane", id: "main" }, panes: { main } },
      neighbor: "main",
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
