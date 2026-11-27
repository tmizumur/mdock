// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../lib/api";
import FileTree from "./FileTree";

const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    scrollToIndex,
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 28 })),
  }),
}));

const a: Entry = { name: "a.md", path: "/w/docs/a.md", is_dir: false, children: [] };
const b: Entry = { ...a, name: "b.md", path: "/w/docs/b.md" };
const folder: Entry = { name: "docs", path: "/w/docs", is_dir: true, children: [a, b] };
const entries = [folder];
const onOpen = vi.fn();
const onLoadDirectory = vi.fn();
const noop = () => {};

describe("ファイルツリーの選択同期", () => {
  let host: HTMLDivElement;
  let view: Root;

  function show(activePath: string, tree = entries) {
    act(() => view.render(<FileTree root="/w" entries={tree} activePath={activePath} openPaths={[]}
      onOpen={onOpen} onLoadDirectory={onLoadDirectory} onChanged={noop} onRenamed={noop} onError={noop} git={{ get: () => undefined }} />));
  }

  const tree = () => host.querySelector<HTMLElement>('[role="tree"]')!;
  const selected = () => host.querySelector('[aria-selected="true"]')?.textContent;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.body.appendChild(document.createElement("div"));
    view = createRoot(host);
  });

  afterEach(() => {
    act(() => view.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("展開済みのフォルダでもファイルが切り替わると選択行へスクロールする", () => {
    show(a.path);
    scrollToIndex.mockClear();
    show(b.path);

    expect(selected()).toBe(b.name);
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, { align: "auto" });
  });

  it("選択行がまだないときはフォルダの読み込み後にスクロールする", () => {
    show(b.path, [{ ...folder, children: [], loaded: false }]);
    expect(onLoadDirectory).toHaveBeenCalledWith(folder.path);
    expect(scrollToIndex).not.toHaveBeenCalled();

    show(b.path);
    expect(selected()).toBe(b.name);
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, { align: "auto" });
  });

  it("ツリーにフォーカスがあれば選択だけを合わせ、⌘Enter だけが隣のペインに開く", () => {
    show(a.path);
    tree().focus();
    scrollToIndex.mockClear();
    show(b.path);

    expect(selected()).toBe(b.name);
    expect(scrollToIndex).not.toHaveBeenCalled();
    act(() => {
      tree().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      tree().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(onOpen.mock.calls).toEqual([[b.path, false, false], [b.path, true, false]]);
  });
});
