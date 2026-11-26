// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Entry, readDirs, readTree, statPaths, watchFiles, watchFolder } from "../lib/api";
import { type Workspace } from "../lib/workspace";
import { useFolder } from "./useFolder";
import { useLiveReload } from "./useLiveReload";

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  readDirs: vi.fn(),
  readTree: vi.fn(),
  statPaths: vi.fn(),
  watchFiles: vi.fn(),
  watchFolder: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));

const first = "/first";
const dir = "/first/docs/archive";
const note: Entry = { path: `${dir}/note.md`, name: "note.md", is_dir: false, children: [] };
const branch: Entry = { path: "/first/docs", name: "docs", is_dir: true, children: [] };
const archive: Entry = { path: dir, name: "archive", is_dir: true, children: [] };
const shallow = [{ ...branch, children: [{ ...archive, loaded: false }] }];
const full = [{ ...branch, children: [archive] }];
const ws: Workspace = { layout: { type: "pane", id: "p0" }, panes: {} };
const workspace = { ws, wsRef: { current: ws }, apply: vi.fn(), confirmDirty: vi.fn(async () => true), clearTabs: vi.fn() };
const setError = vi.fn();

function pendingTree() {
  let resolve!: (entries: Entry[]) => void;
  const promise = new Promise<Entry[]>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("フォルダツリーの読み込み", () => {
  let view: Root;
  let folder: ReturnType<typeof useFolder>;

  function Harness() {
    folder = useFolder(workspace, setError);
    useLiveReload(folder.root !== null, folder, workspace);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.resetAllMocks();
    vi.mocked(watchFiles).mockResolvedValue(undefined);
    vi.mocked(watchFolder).mockResolvedValue(undefined);
    vi.mocked(listen).mockReset().mockResolvedValue(() => {});
    view = createRoot(document.createElement("div"));
    act(() => view.render(<Harness />));
  });

  afterEach(async () => {
    await act(() => view.unmount());
    vi.unstubAllGlobals();
  });

  it("浅いツリーを先に表示し、全体の読み込み中に届いた変更をその後に反映する", async () => {
    const scan = pendingTree();
    vi.mocked(readTree).mockImplementation(async (_, depth) => depth === 2 ? shallow : scan.promise);
    vi.mocked(readDirs).mockResolvedValue([[note]]);
    vi.mocked(statPaths).mockResolvedValue([{ exists: true, is_dir: false, mtime: 1, size: 1 }]);

    await act(() => folder.openFolder(first, false, true));
    expect(folder.tree).toEqual(shallow);
    const onChange = vi.mocked(listen).mock.calls[0][1];
    await act(() => onChange({ id: 1, event: "fs-change", payload: { paths: [note.path] } }));
    expect(vi.mocked(readTree).mock.calls).toEqual([[first, 2], [first]]);
    expect(folder.tree).toEqual(shallow);

    await act(async () => scan.resolve(full));
    expect(folder.tree[0].children[0].children).toEqual([note]);
    expect(readDirs).toHaveBeenCalledWith([dir], first);
    expect(readTree).toHaveBeenCalledTimes(2);
  });

  it("未読フォルダを展開でき、切り替え前の全体結果は破棄する", async () => {
    const scan = pendingTree();
    const second = "/second";
    const next = [{ ...note, path: `${second}/note.md` }];
    vi.mocked(readTree).mockImplementation(async (root, depth) => {
      if (root === second) return next;
      return depth === 2 ? shallow : scan.promise;
    });
    vi.mocked(readDirs).mockResolvedValue([[note]]);

    await act(() => folder.openFolder(first));
    await act(() => folder.loadDirectory(dir));
    expect(folder.tree[0].children[0]).toMatchObject({ loaded: true, children: [note] });
    await act(() => folder.openFolder(second));
    await act(async () => scan.resolve(full));
    expect(folder.root).toBe(second);
    expect(folder.tree).toEqual(next);
  });
});
