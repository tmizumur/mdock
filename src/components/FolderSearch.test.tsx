// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelFolderSearch, searchFolder } from "../lib/folderSearch";
import FolderSearch from "./FolderSearch";

vi.mock("../lib/folderSearch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/folderSearch")>(),
  cancelFolderSearch: vi.fn(),
  searchFolder: vi.fn(),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpen = vi.fn();
const onClose = vi.fn();
const lookup = vi.mocked(searchFolder);
const input = () => host.querySelector("input")!;
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".folder-search-match"));
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (key: string) => act(() => {
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });
const results = {
  count: 2,
  truncated: true,
  files: [{
    path: "/work/docs/a.md",
    relativePath: "docs/a.md",
    matches: [
      { line: 0, text: "😀一致", start: 2, end: 4, column: 2, length: 2 },
      { line: 4, text: "一致", start: 0, end: 2, column: 0, length: 2 },
    ],
  }],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  lookup.mockReset().mockResolvedValue(results);
  vi.mocked(cancelFolderSearch).mockReset().mockResolvedValue(undefined);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(<FolderSearch root="/work" onClose={onClose} onOpen={onOpen} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  onOpen.mockClear();
  onClose.mockClear();
});

it("入力を待って検索し、結果をキーボードで移動しながら開ける", async () => {
  expect(document.activeElement).toBe(input());
  type("一致");
  expect(lookup).not.toHaveBeenCalled();
  await flush();
  expect(lookup).toHaveBeenCalledWith("/work", "一致", false, false);
  expect(host.querySelectorAll(".folder-search-file")).toHaveLength(1);
  expect(host.textContent).toContain("最初の 5000 件を表示");
  expect(rows()[0].querySelector("mark")?.textContent).toBe("一致");

  key("ArrowDown");
  expect(document.activeElement).toBe(rows()[0]);
  key("ArrowDown");
  expect(document.activeElement).toBe(rows()[1]);
  act(() => rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
  expect(onOpen).toHaveBeenCalledWith("/work/docs/a.md", {
    line: 4, column: 0, length: 2, query: "一致", matchText: "一致",
  }, true);
  key("ArrowUp");
  key("ArrowUp");
  expect(document.activeElement).toBe(input());
  act(() => host.querySelector<HTMLButtonElement>(".folder-search-file")!.click());
  expect(rows()).toHaveLength(0);
});

it("Enter ですぐ検索し、以前の結果より最新のエラーを優先する", async () => {
  let resolveOld!: (value: typeof results) => void;
  lookup.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  type("一致");
  key("Enter");
  expect(lookup).toHaveBeenCalledTimes(1);

  lookup.mockRejectedValueOnce("正規表現が正しくありません。");
  type("[");
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="正規表現"]')!.click());
  await flush();
  expect(lookup).toHaveBeenLastCalledWith("/work", "[", false, true);
  await act(async () => { resolveOld(results); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("正規表現が正しくありません。");
  expect(rows()).toHaveLength(0);
});

it("入力を空にしたときとパネルを閉じたときに走査を取り消す", async () => {
  lookup.mockReturnValue(new Promise(() => {}));
  type("一致");
  key("Enter");
  type("");
  expect(cancelFolderSearch).toHaveBeenCalledTimes(1);
  await flush();
  expect(lookup).toHaveBeenCalledTimes(1);

  type("再検索");
  key("Enter");
  expect(lookup).toHaveBeenCalledTimes(2);
  act(() => root.render(null));
  expect(cancelFolderSearch).toHaveBeenCalledTimes(2);
});
