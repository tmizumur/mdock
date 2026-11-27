// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocTab } from "../lib/tabs";
import Pane from "./Pane";

vi.mock("./PreviewPane", () => ({ default: () => null }));
vi.mock("./Editor", () => ({ default: () => null }));

const modes = [
  ["view", "表示（⌘E で編集と切り替え）"],
  ["edit", "編集（⌘E）"],
  ["split", "編集とプレビューを並べて"],
] as const;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each(modes)("%s のとき、現在の表示モードを示し、別のモードを選べる", async (mode) => {
  const onMode = vi.fn();
  const noop = () => {};
  const tab: DocTab = { id: "doc", kind: "doc", path: "/work/test.md", content: "", saved: "", mode };

  await act(async () => root.render(
    <Pane
      idx="pane"
      pane={{ tabs: [tab], active: 0 }}
      active
      rootDir={null}
      printTarget={false}
      scrollOf={() => 0}
      onOutline={noop}
      onScroll={noop}
      onPreviewScroll={noop}
      onFocus={noop}
      onActivateTab={noop}
      onCloseTab={noop}
      onTabMenu={noop}
      onChange={noop}
      onMode={onMode}
      onSave={noop}
      onRetryRead={noop}
      onReloadExternal={noop}
      onKeepMine={noop}
      onOpenLink={noop}
      onPrint={noop}
    />,
  ));

  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="表示モード"] button');
  expect(buttons).toHaveLength(3);
  modes.forEach(([buttonMode, label], i) => {
    const button = buttons[i];
    expect(button.getAttribute("aria-label")).toBe(label);
    expect(button.title).toBe(label);
    expect(button.getAttribute("aria-pressed")).toBe(String(buttonMode === mode));

    act(() => button.click());
    if (buttonMode === mode) expect(onMode).not.toHaveBeenCalled();
    else expect(onMode).toHaveBeenCalledExactlyOnceWith(buttonMode);
    onMode.mockClear();
  });
});
