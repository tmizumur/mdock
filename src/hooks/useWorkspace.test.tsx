// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TextReadResult, readTextResult, writeText } from "../lib/api";
import { activeTab, isDirty } from "../lib/tabs";
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

  function Harness() {
    workspace = useWorkspace(askUnsaved, setError);
    const folder = useFolder(workspace, setError);
    useLiveReload(false, folder, workspace);
    return null;
  }

  function activeDoc() {
    const tab = activeTab(workspace.ws.panes[workspace.activeIdx]);
    if (tab?.kind !== "doc") throw new Error("ファイルが開かれていません");
    return tab;
  }

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
