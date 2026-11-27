// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPane } from "../lib/tabs";
import type { Workspace } from "../lib/workspace";
import { useMenuActions } from "./useMenuActions";
import { useShortcuts } from "./useShortcuts";

const { close, listen } = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close, listen }) }));

const activeRef = { current: "p0" };
const wsRef = { current: { panes: { p0: emptyPane() }, layout: { type: "pane", id: "p0" } } as Workspace };
let root: Root;

function renderHook<T>(useHook: () => T): T {
  let result!: T;
  function Harness() {
    result = useHook();
    return null;
  }
  act(() => root.render(<Harness />));
  return result;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useShortcuts", () => {
  it.each([
    ["⌘W", { key: "w", metaKey: true }, "close-tab"],
    ["⇧⌘W", { key: "W", metaKey: true, shiftKey: true }, "close-window"],
    ["⌘W のリピート", { key: "w", metaKey: true, repeat: true }, null],
    ["⇧⌘W のリピート", { key: "W", metaKey: true, shiftKey: true, repeat: true }, null],
    ["Ctrl+W", { key: "w", ctrlKey: true }, null],
    ["⌥⌘W", { key: "w", metaKey: true, altKey: true }, null],
  ] as const)("%s", (_, init, action) => {
    const run = vi.fn();
    renderHook(() => useShortcuts(
      {
        activeRef,
        wsRef,
        livePane: vi.fn(),
        cycleTab: vi.fn(),
        toggleSplit: vi.fn(),
        splitTab: vi.fn(),
        focusPane: vi.fn(),
        splitWith: vi.fn(),
        navigate: vi.fn(),
        recordJump: vi.fn(),
      },
      { findInPane: vi.fn(), toggleMode: vi.fn() },
      { actions: { current: {} }, run },
      vi.fn(),
      vi.fn(),
      vi.fn(),
    ));

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", init)); });

    expect(run.mock.calls).toEqual(action ? [[action, "key"]] : []);
  });
});

describe("useMenuActions", () => {
  function renderMenuActions() {
    const closeActiveTab = vi.fn();
    const { run } = renderHook(() => useMenuActions(
      { activeRef, wsRef, closeActiveTab, saveTab: vi.fn() },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    ));
    return { run, closeActiveTab };
  }

  it("400ms 以内にメニューから同じ操作が来てもウインドウを一度だけ閉じる", () => {
    const { run } = renderMenuActions();
    vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1399);

    run("close-window", "key");
    expect(close).toHaveBeenCalledTimes(1);
    run("close-window", "menu");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("close-tab はタブを閉じる操作を呼ぶ", () => {
    const { run, closeActiveTab } = renderMenuActions();

    run("close-tab", "key");

    expect(closeActiveTab).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});
