// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TextReadResult, readTextResult, writeText } from "../lib/api";
import { activeTab, isDirty, isPreview } from "../lib/tabs";
import { useFolder } from "./useFolder";
import { useLiveReload } from "./useLiveReload";
import { useWorkspace } from "./useWorkspace";

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  readTextResult: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

const setError = vi.fn();
const askUnsaved = vi.fn();
const originalStamp = { mtime: 1, size: 12 };
const savedStamp = { mtime: 2, size: 9 };
const success = (text: string, lossy = false): TextReadResult => ({
  info: { text, encoding: "UTF-8", bom: false, lossy, diskStamp: originalStamp },
});
const readError = { code: "invalid_encoding", message: "文字コードを判定できません。" } as const;

describe("ワークスペースの読み込みと保存", () => {
  let view: Root;
  let workspace: ReturnType<typeof useWorkspace>;

  function Harness({ previewTabs = true }: { previewTabs?: boolean }) {
    workspace = useWorkspace(askUnsaved, setError, previewTabs);
    const folder = useFolder(workspace, setError);
    useLiveReload(false, folder, workspace);
    return null;
  }

  function activeDoc() {
    const tab = activeTab(workspace.ws.panes[workspace.activeIdx]);
    if (tab?.kind !== "doc") throw new Error("ファイルが開かれていません");
    return tab;
  }

  const treeOpen = (path: string, otherPane = false, newTab = false) =>
    act(() => workspace.onTreeOpen(path, otherPane, newTab));
  const paneTabs = (id = "p0") => workspace.ws.panes[id].tabs.map((t) => [t.kind === "doc" ? t.path : "diff", isPreview(t)]);

  async function editFile(lossy = false) {
    vi.mocked(readTextResult).mockResolvedValue(success("保存済み", lossy));
    await act(() => workspace.openFile("/note.md", "p0"));
    act(() => workspace.updateActiveTab("p0", (tab) => ({ ...tab, content: "編集中" })));
    return activeDoc().id;
  }

  async function reloadFile(result: TextReadResult) {
    vi.mocked(readTextResult).mockResolvedValue(result);
    const onChange = vi.mocked(listen).mock.calls[0][1];
    await act(() => onChange({ id: 1, event: "fs-change", payload: { paths: ["/note.md"] } }));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.resetAllMocks();
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(writeText).mockResolvedValue(savedStamp);
    view = createRoot(document.createElement("div"));
    act(() => view.render(<Harness />));
  });

  afterEach(async () => {
    await act(() => view.unmount());
    vi.unstubAllGlobals();
  });

  it("ツリーで開くと仮のタブになり、背面にあっても同じ位置で置き換える", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    expect(paneTabs()).toEqual([["/a.md", true]]);
    await treeOpen("/b.md");
    expect(paneTabs()).toEqual([["/b.md", true]]);
    await treeOpen("/c.md", false, true);
    await treeOpen("/d.md");
    expect(paneTabs()).toEqual([["/d.md", true], ["/c.md", false]]);
    expect(activeDoc().path).toBe("/d.md");
  });

  it("仮のタブがなければ前面のタブの右に追加し、既に開いているファイルは切り替えるだけ", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md", false, true);
    await treeOpen("/c.md", false, true);
    await treeOpen("/a.md");
    await treeOpen("/b.md");
    expect(paneTabs()).toEqual([["/a.md", false], ["/b.md", true], ["/c.md", false]]);
    const previewId = activeDoc().id;
    await treeOpen("/a.md");
    expect(activeDoc().path).toBe("/a.md");
    expect(activeDoc().preview).toBeUndefined();
    await treeOpen("/b.md");
    expect(activeDoc()).toMatchObject({ id: previewId, preview: true });
    expect(readTextResult).toHaveBeenCalledTimes(3);
    act(() => workspace.onTreeOpen("/b.md", false, false, undefined, "pin"));
    expect(activeDoc()).toMatchObject({ id: previewId, preview: undefined });
    expect(readTextResult).toHaveBeenCalledTimes(3);
  });

  it.each([{ mode: "edit" }, { mode: "split" }, { content: "編集中" }] as const)("編集を始めたタブを固定する（%o）", async (change) => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    act(() => workspace.updateActiveTab("p0", (t) => ({ ...t, ...change })));
    expect(activeDoc().preview).toBeUndefined();
    await treeOpen("/b.md");
    expect(paneTabs()).toEqual([["/a.md", false], ["/b.md", true]]);
  });

  it.each(["並べ替え", "別のペイン", "新しい分割"])("%sで移動した仮のタブを固定する", async (move) => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    const { id } = activeDoc();
    await treeOpen("/b.md", false, true);
    act(() => {
      const paneId = move === "別のペイン" ? workspace.splitWith("p0", "right", []) : "p0";
      workspace.moveTab("p0", id, { paneId, index: 2, split: move === "新しい分割" ? "right" : undefined });
    });
    expect(activeDoc()).toMatchObject({ id, preview: undefined });
  });

  it("⌘クリックは分割先や隣のペインで仮のタブを開く", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    await treeOpen("/b.md", true);
    const [, other] = workspace.order;
    expect(workspace.activeIdx).toBe(other);
    expect(paneTabs(other)).toEqual([["/b.md", true]]);
    await treeOpen("/c.md", true);
    expect(workspace.activeIdx).toBe("p0");
    expect(paneTabs()).toEqual([["/c.md", true]]);
    expect(paneTabs(other)).toEqual([["/b.md", true]]);
  });

  it("リンクと検索結果は仮のタブで開き、新規タブ指定や新規作成では固定する", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await act(() => workspace.openFile("/link.md", "p0", { anchor: "見出し", preview: true }));
    expect(activeDoc()).toMatchObject({ anchor: { id: "見出し" }, preview: true });
    await act(() => workspace.onTreeOpen("/search.md", false, false, { line: 2, column: 1, length: 1, query: "本", matchText: "本" }));
    expect(activeDoc()).toMatchObject({ path: "/search.md", line: { line: 2 }, preview: true });
    await act(() => workspace.openFile("/link-new.md", "p0", { newTab: true, preview: true }));
    await act(() => workspace.openFile("/finder.md", "p0", { newTab: true }));
    await act(() => workspace.onTreeOpen("/created.md", false, false, undefined, "create"));
    expect(paneTabs()).toEqual([["/search.md", true], ["/link-new.md", false], ["/finder.md", false], ["/created.md", false]]);
  });

  it("履歴で開き直すときは前面のタブを固定したタブで置き換える", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    await treeOpen("/b.md");
    await act(() => workspace.navigate("p0", -1));
    expect(paneTabs()).toEqual([["/a.md", false]]);
    await act(() => workspace.navigate("p0", 1));
    expect(paneTabs()).toEqual([["/b.md", false]]);
  });

  it("設定を切ると仮のタブを固定し、ツリーの通常クリックは前面のタブを置き換える", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await treeOpen("/a.md");
    act(() => view.render(<Harness previewTabs={false} />));
    expect(paneTabs()).toEqual([["/a.md", false]]);
    await treeOpen("/b.md");
    expect(paneTabs()).toEqual([["/b.md", false]]);
    await treeOpen("/c.md", false, true);
    expect(paneTabs()).toEqual([["/b.md", false], ["/c.md", false]]);
  });

  it.each([false, true])("読み込み中のダブルクリックは一度だけ読み、固定して開く（分割: %s）", async (otherPane) => {
    let finish!: (result: TextReadResult) => void;
    vi.mocked(readTextResult).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let opening: Promise<void> | undefined;
    act(() => {
      opening = workspace.onTreeOpen("/a.md", otherPane, false);
      workspace.onTreeOpen("/a.md", otherPane, false, undefined, "pin");
    });
    expect(readTextResult).toHaveBeenCalledExactlyOnceWith("/a.md");
    expect(paneTabs()).toEqual([]);
    await act(async () => {
      finish(success("本文"));
      await opening;
    });
    expect(paneTabs(workspace.activeIdx)).toEqual([["/a.md", false]]);
  });

  it("仮のタブの読み込みは最新の要求を優先し、遅い新規タブは背面に追加する", async () => {
    let finishPreview!: (result: TextReadResult) => void;
    let finishPinned!: (result: TextReadResult) => void;
    vi.mocked(readTextResult)
      .mockImplementationOnce(() => new Promise((resolve) => { finishPinned = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishPreview = resolve; }))
      .mockResolvedValue(success("本文"));
    let pinned!: Promise<void>;
    let preview: Promise<void> | undefined;
    act(() => {
      pinned = workspace.openFile("/pinned.md", "p0", { newTab: true });
      preview = workspace.onTreeOpen("/old.md", false, false);
    });
    await treeOpen("/new.md");
    await act(async () => {
      finishPreview(success("古い要求"));
      finishPinned(success("固定"));
      await Promise.all([pinned, preview]);
    });
    expect(paneTabs()).toEqual([["/new.md", true], ["/pinned.md", false]]);
    expect(activeDoc().path).toBe("/new.md");
  });

  it("戻り先を読み込み中は同じペインの履歴操作を受け付けない", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await act(() => workspace.openFile("/a.md", "p0"));
    await act(() => workspace.openFile("/b.md", "p0"));
    await act(() => workspace.openFile("/c.md", "p0"));
    let finish!: (result: TextReadResult) => void;
    vi.mocked(readTextResult).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    let back!: Promise<void>;
    await act(async () => {
      back = workspace.navigate("p0", -1);
      await workspace.navigate("p0", -1);
      await workspace.navigate("p0", 1);
    });
    expect(activeDoc().path).toBe("/c.md");
    expect(readTextResult).toHaveBeenCalledTimes(4);
    await act(async () => {
      finish(success("本文"));
      await back;
    });
    expect(activeDoc().path).toBe("/b.md");
    await act(() => workspace.navigate("p0", 1));
    expect(activeDoc().path).toBe("/c.md");
    await act(() => workspace.navigate("p0", 1));
    expect(readTextResult).toHaveBeenCalledTimes(5);
  });

  it("新しいタブへ移動した履歴は元のタブを選び直す", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await act(() => workspace.openFile("/a.md", "p0"));
    const first = { ...activeDoc(), id: "duplicate" };
    act(() => workspace.updatePane("p0", (p) => ({ tabs: [...p.tabs, first], active: 1 })));
    workspace.scrolls.current.set(first.id, 120);
    await act(() => workspace.openFile("/b.md", "p0", { newTab: true }));
    const second = activeDoc();

    await act(() => workspace.navigate("p0", -1));
    expect(activeDoc()).toMatchObject({ id: first.id, scrollTo: { top: 120 } });
    await act(() => workspace.navigate("p0", 1));
    expect(activeDoc().id).toBe(second.id);
    expect(readTextResult).toHaveBeenCalledTimes(2);
  });

  it("同じファイル内ではタブを保ち、戻る・進むごとにスクロール先を更新する", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await act(() => workspace.openFile("/a.md", "p0"));
    const { id } = activeDoc();
    workspace.recordJump("p0");
    workspace.scrolls.current.set(id, 180);

    await act(() => workspace.navigate("p0", -1));
    expect(activeDoc()).toMatchObject({ id, scrollTo: { top: 0 } });
    const previous = activeDoc().scrollTo?.nonce;
    await act(() => workspace.navigate("p0", 1));
    expect(activeDoc()).toMatchObject({ id, scrollTo: { top: 180 } });
    expect(activeDoc().scrollTo?.nonce).not.toBe(previous);
    expect(readTextResult).toHaveBeenCalledOnce();
  });

  it("全タブを閉じると履歴と読み込み中の履歴移動が消える", async () => {
    vi.mocked(readTextResult).mockResolvedValue(success("本文"));
    await act(() => workspace.openFile("/a.md", "p0"));
    await act(() => workspace.openFile("/b.md", "p0"));
    let finish!: (result: TextReadResult) => void;
    vi.mocked(readTextResult).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    let back!: Promise<void>;
    act(() => {
      back = workspace.navigate("p0", -1);
      workspace.clearTabs();
    });
    await act(() => workspace.openFile("/new.md", "p0"));
    await act(async () => {
      finish(success("本文"));
      await back;
      await workspace.navigate("p0", -1);
    });
    expect(activeDoc().path).toBe("/new.md");
    expect(readTextResult).toHaveBeenCalledTimes(4);
  });

  it("新しい ⌘+クリックが先に完了したとき、古い要求ではペインを増やさない", async () => {
    let finishFirst!: (result: TextReadResult) => void;
    vi.mocked(readTextResult)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(success("B"));
    await act(() => {
      workspace.onTreeOpen("/a.md", true, false);
      workspace.onTreeOpen("/b.md", true, false);
    });
    const focused = workspace.activeIdx;
    expect(workspace.order).toEqual(["p0", focused]);
    expect(activeDoc().path).toBe("/b.md");

    await act(() => finishFirst(success("A")));
    expect(workspace.order).toEqual(["p0", focused]);
    expect(workspace.activeIdx).toBe(focused);
    expect(activeDoc().path).toBe("/b.md");
  });

  it("読み直せない外部変更を記録し、確認を取り消すと保存しない", async () => {
    const id = await editFile();
    await reloadFile({ error: readError });
    expect(activeDoc()).toMatchObject({ content: "編集中", externalReadError: readError });
    vi.mocked(ask).mockResolvedValueOnce(false);
    await act(async () => { expect(await workspace.saveTab(id)).toBe(false); });
    expect(ask).toHaveBeenCalledWith("外部で変更されたファイルを上書きしますか？", expect.any(Object));
    expect(writeText).not.toHaveBeenCalled();

    await reloadFile(success("外部の内容"));
    expect(activeDoc().externalReadError).toBeUndefined();
    expect(activeDoc()).toMatchObject({ content: "編集中", external: { text: "外部の内容" } });
  });

  it("読めなかったバイトがあるときは同意を得てから保存し、警告を消す", async () => {
    const id = await editFile(true);
    expect(activeDoc().lossy).toBe(true);
    vi.mocked(ask).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => { expect(await workspace.saveTab(id)).toBe(false); });
    expect(ask).toHaveBeenCalledWith(
      "このファイルには読み取れなかったバイトがあり、保存すると元のバイトは失われます。保存しますか？",
      expect.any(Object),
    );
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => { expect(await workspace.saveTab(id)).toBe(true); });
    expect(writeText).toHaveBeenCalledOnce();
    expect(activeDoc().lossy).toBeUndefined();
    expect(activeDoc().saved).toBe("編集中");
  });

  it("監視通知より前に外部変更があれば、承認した場合だけ上書きする", async () => {
    const id = await editFile();
    const changed = { code: "changed_on_disk" };
    vi.mocked(writeText).mockRejectedValueOnce(changed).mockRejectedValueOnce(changed);
    vi.mocked(ask).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await act(async () => { expect(await workspace.saveTab(id)).toBe(false); });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenLastCalledWith("/note.md", "編集中", expect.any(Object), originalStamp);
    expect(isDirty(activeDoc())).toBe(true);

    await act(async () => { expect(await workspace.saveTab(id)).toBe(true); });
    expect(ask).toHaveBeenLastCalledWith("外部で変更されたファイルを上書きしますか？", expect.any(Object));
    expect(writeText).toHaveBeenNthCalledWith(2, "/note.md", "編集中", expect.any(Object), originalStamp);
    expect(writeText).toHaveBeenNthCalledWith(3, "/note.md", "編集中", expect.any(Object), undefined);
    expect(activeDoc()).toMatchObject({ saved: "編集中", diskStamp: savedStamp });
  });

  it("本文が同じでも、BOM を取り除く下書きを保存する", async () => {
    const id = await editFile();
    act(() => workspace.updateActiveTab("p0", (tab) =>
      tab.kind === "doc" ? { ...tab, content: tab.saved, bom: false, savedBom: true } : tab,
    ));

    await act(async () => { expect(await workspace.saveTab(id)).toBe(true); });
    expect(writeText).toHaveBeenCalledWith("/note.md", "保存済み", { encoding: undefined, bom: false }, originalStamp);
    expect(isDirty(activeDoc())).toBe(false);
  });
});
