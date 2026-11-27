// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffTab } from "../lib/tabs";
import DiffView from "./DiffView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 19,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 19 })),
    measureElement: () => {},
  }),
}));

describe("差分表示", () => {
  let host: HTMLDivElement;
  let view: Root;

  function show(leftText: string, rightText: string) {
    const tab: DiffTab = { id: "diff", kind: "diff", left: "/w/left.md", right: "/w/right.md", leftText, rightText };
    act(() => view.render(<DiffView tab={tab} />));
  }

  async function finishCalculation() {
    await act(() => vi.runOnlyPendingTimersAsync());
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("Worker", undefined);
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement("div"));
    view = createRoot(host);
  });

  afterEach(() => {
    act(() => view.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("計算中もヘッダーを表示し、完了後に差分と追加・削除数を表示する", async () => {
    show("残る\n削除 1\n削除 2\n", "残る\n追加 1\n");
    expect(host.querySelector(".diff-head")?.textContent).toContain("left.md");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("差分を計算しています…");

    await finishCalculation();
    expect(host.querySelector(".diff-row .code.del")?.textContent).toBe("削除 1");
    expect(host.querySelector(".diff-row .code.add")?.textContent).toBe("追加 1");
    expect(host.querySelector(".diff-stat .add")?.textContent).toBe("+1");
    expect(host.querySelector(".diff-stat .del")?.textContent).toBe("−2");
  });

  it("変更なしの帯をクリックで展開し、入力が変わると折りたたみに戻す", async () => {
    const same = Array.from({ length: 10 }, (_, index) => `共通 ${index + 1}\n`).join("");
    show(`前の先頭\n${same}前の末尾\n`, `先頭\n${same}末尾\n`);
    await finishCalculation();

    const fold = host.querySelector<HTMLButtonElement>("button.diff-fold");
    expect(fold?.textContent).toContain("4 行の変更なし");
    expect(host.textContent).not.toContain("共通 5");
    act(() => fold?.click());
    expect(host.querySelector("button.diff-fold")).toBeNull();
    expect(host.textContent).toContain("共通 5");

    show(`前の先頭\n${same}前の末尾\n`, `次の先頭\n${same}末尾\n`);
    await finishCalculation();
    expect(host.querySelector("button.diff-fold")?.textContent).toContain("4 行の変更なし");
    expect(host.textContent).not.toContain("共通 5");
  });

  it("上限に達する入力には案内を表示する", async () => {
    show("", "\n".repeat(20_000));
    await finishCalculation();

    expect(host.querySelector('[role="status"]')?.textContent).toBe("差分が大きすぎます（合計 20000 行）");
    expect(host.querySelector(".diff-row")).toBeNull();
  });

  it("左右が同じなら差分がないことを表示する", async () => {
    show("共通\n", "共通\n");
    await finishCalculation();
    expect(host.querySelector(".diff-stat")?.textContent).toContain("差分はありません");
    expect(host.querySelectorAll(".diff-row")).toHaveLength(1);
  });

  it("計算中に入力が変わると最後の入力だけを表示する", async () => {
    show("変更前\n", "古い内容\n");
    show("変更前\n", "新しい内容\n");
    await finishCalculation();
    expect(host.querySelector(".diff-row .code.add")?.textContent).toBe("新しい内容");
    expect(host.textContent).not.toContain("古い内容");
  });
});
