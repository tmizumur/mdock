import { describe, expect, it } from "vitest";
import { emptyNav, goBack, goForward, recordNav } from "./navHistory";

const a = { path: "/w/a.md", scroll: 0 };
const b = { path: "/w/b.md", scroll: 120 };
const c = { path: "/w/c.md", scroll: 40 };

describe("戻る／進む", () => {
  it("戻ると直前の位置へ、進むと戻る前の位置へ", () => {
    let s = recordNav(emptyNav(), a); // a → b
    s = recordNav(s, b); // b → c
    const back = goBack(s, c)!;
    expect(back.target).toEqual(b);
    const back2 = goBack(back.state, b)!;
    expect(back2.target).toEqual(a);
    expect(goBack(back2.state, a)).toBeNull();
    const fwd = goForward(back2.state, a)!;
    expect(fwd.target).toEqual(b);
    expect(goForward(fwd.state, b)!.target).toEqual(c);
  });

  it("新しく移動すると進む履歴は消える", () => {
    const back = goBack(recordNav(emptyNav(), a), b)!;
    expect(back.state.forward).toEqual([b]);
    expect(recordNav(back.state, a).forward).toEqual([]);
  });

  it("同じ位置を続けて記録しない", () => {
    const s = recordNav(recordNav(emptyNav(), a), { ...a });
    expect(s.back).toHaveLength(1);
  });

  it("同じファイルの同じ位置でも別のタブなら履歴に残す", () => {
    const first = { ...a, tabId: "first" };
    const second = { ...a, tabId: "second" };
    const state = recordNav(recordNav(emptyNav(), first), second);
    const back = goBack(state, b)!;
    const backAgain = goBack(back.state, second)!;
    expect(back.target).toEqual(second);
    expect(backAgain.target).toEqual(first);
    expect(goForward(backAgain.state, first)?.target).toEqual(second);
  });

  it("履歴は 100 件まで（古いものから捨てる）", () => {
    let s = emptyNav();
    for (let i = 0; i < 120; i++) s = recordNav(s, { path: `/w/${i}.md`, scroll: 0 });
    expect(s.back).toHaveLength(100);
    expect(s.back[0].path).toBe("/w/20.md");
  });
});
