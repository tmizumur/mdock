// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TextReadResult, readTextResult, writeText } from "../lib/api";
import { activeTab } from "../lib/tabs";
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
const success = (text: string, lossy = false): TextReadResult => ({
  info: { text, encoding: "UTF-8", bom: false, lossy },
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
    view = createRoot(document.createElement("div"));
    act(() => view.render(<Harness />));
  });

  afterEach(async () => {
    await act(() => view.unmount());
    vi.unstubAllGlobals();
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
});
