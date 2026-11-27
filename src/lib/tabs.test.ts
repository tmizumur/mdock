import { describe, expect, it } from "vitest";
import { type Session, migrateSession } from "./tabs";

describe("セッションの移行", () => {
  it("初期形式のパスから単一ペインのタブを復元する", () => {
    const session = migrateSession({ root: "/docs", paths: ["/docs/one.md", null, "/docs/two.md"], split: false });

    expect(session).toEqual({
      version: 4,
      root: "/docs",
      panes: {
        p0: {
          tabs: [
            { path: "/docs/one.md", mode: "view", scroll: 0 },
            { path: "/docs/two.md", mode: "view", scroll: 0 },
          ],
          active: 0,
        },
      },
      layout: { type: "pane", id: "p0" },
      activePane: "p0",
    });
  });

  it("版 2 の分割比率、下書き、選択中のペインを引き継ぐ", () => {
    const draft = { path: "/docs/one.md", mode: "edit", scroll: 12, draft: "編集中", draftBase: "保存済み" };
    const session = migrateSession({
      version: 2,
      panes: [draft, { path: null }],
      split: true,
      activeIdx: 1,
      layouts: { split: { "pane-0": 30, "pane-1": 70, sidebar: 25 } },
    });

    expect(session).toMatchObject({
      version: 4,
      root: null,
      panes: { p0: { tabs: [draft], active: 0 }, p1: { tabs: [], active: 0 } },
      layout: {
        type: "split",
        dir: "row",
        children: [{ type: "pane", id: "p0" }, { type: "pane", id: "p1" }],
        sizes: [30, 70],
      },
      activePane: "p1",
      sidebar: { sidebar: 25, panes: 75 },
    });
  });

  it("版 3 の上下分割の比率を復元し、余ったタブを最後のペインに集める", () => {
    const first = { path: "/docs/one.md", mode: "view", scroll: 0 };
    const second = { path: "/docs/two.md", mode: "edit", scroll: 2 };
    const extra = { kind: "diff", left: "/docs/one.md", right: "/docs/two.md", scroll: 3 };
    const session = migrateSession({
      version: 3,
      panes: [{ tabs: [first], active: 0 }, { tabs: [second], active: 0 }, { tabs: [extra], active: 0 }],
      activeIdx: 2,
      layout: "rows2",
      layouts: { "rows2-v": { "pane-0": 40, "pane-1": 60 } },
    });

    expect(session).toMatchObject({
      version: 4,
      panes: { p0: { tabs: [first], active: 0 }, p1: { tabs: [second, extra], active: 0 } },
      layout: { type: "split", dir: "col", sizes: [40, 60] },
      activePane: "p1",
    });
  });

  it("現在のセッションを復元し、存在しない選択先は先頭ペインに戻す", () => {
    const session: Session = {
      version: 4,
      root: "/docs",
      panes: {
        main: { tabs: [{ path: "/docs/one.md", mode: "view", scroll: 24 }], active: 0 },
        other: { tabs: [{ kind: "diff", left: "/docs/one.md", right: "/docs/two.md", scroll: 0 }], active: 0 },
      },
      layout: {
        type: "split",
        id: "split",
        dir: "row",
        children: [{ type: "pane", id: "main" }, { type: "pane", id: "other" }],
        sizes: [70, 30],
      },
      activePane: "other",
      sidebar: { sidebar: 20, panes: 80 },
    };

    expect(migrateSession(session)).toEqual(session);
    expect(migrateSession({ ...session, activePane: "missing" })).toEqual({ ...session, activePane: "main" });
  });

  it.each([
    { input: null },
    { input: [] },
    { input: { version: 4, layout: "cols2" } },
    { input: { version: 4, layout: { type: "split", id: "split", dir: "row", children: [] } } },
  ])("壊れた入力 $input を null にする", ({ input }) => {
    expect(migrateSession(input)).toBeNull();
  });
});
