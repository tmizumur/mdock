import { beforeEach, describe, expect, it, vi } from "vitest";
import { type TextInfo, readTextResult } from "./api";
import { restorePane } from "./session";
import { type SavedTab, isDirty, migrateSession, receiveDocText } from "./tabs";

vi.mock("./api", () => ({ readTextResult: vi.fn() }));

const savedTab = { path: "/note.md", mode: "edit", scroll: 0 } as const;
const textInfo = (text: string, bom = false): TextInfo => ({
  text, encoding: "UTF-8", bom, lossy: false, diskStamp: { mtime: 1, size: new TextEncoder().encode(text).length + (bom ? 3 : 0) },
});

async function restoreDoc(tab: SavedTab) {
  const { tabs: [doc] } = await restorePane({ tabs: [tab], active: 0 }, new Map());
  if (doc?.kind !== "doc") throw new Error("タブを復元できませんでした");
  return doc;
}

describe("下書きの復元", () => {
  beforeEach(() => vi.resetAllMocks());

  it("旧形式の下書きと保存済み本文から BOM を取り除き、保存形式に引き継ぐ", async () => {
    const session = migrateSession({
      version: 4,
      layout: { type: "pane", id: "p0" },
      panes: { p0: { tabs: [{ ...savedTab, draft: "\uFEFF編集中", draftBase: "\uFEFF保存済み" }], active: 0 } },
    });
    vi.mocked(readTextResult).mockResolvedValue({ info: textInfo("保存済み", true) });

    const { tabs: [doc] } = await restorePane(session?.panes.p0, new Map());
    expect(doc).toMatchObject({ content: "編集中", saved: "保存済み", bom: true });
  });

  it("現在の形式では、BOM と本文に残る U+FEFF を区別する", async () => {
    vi.mocked(readTextResult).mockResolvedValue({ info: textInfo("\uFEFF保存済み", true) });
    const doc = await restoreDoc({ ...savedTab, bom: true, draft: "\uFEFF編集中", draftBase: "\uFEFF保存済み" });
    expect(doc).toMatchObject({ content: "\uFEFF編集中", saved: "\uFEFF保存済み", bom: true });
  });

  it.each([true, false])("BOM だけを変えた旧形式の下書きを未保存のまま残す（元の BOM: %s）", async (baseBom) => {
    const info = textInfo("本文", baseBom);
    vi.mocked(readTextResult).mockResolvedValue({ info });
    const doc = await restoreDoc({
      ...savedTab,
      draftBase: baseBom ? "\uFEFF本文" : "本文",
      draft: baseBom ? "本文" : "\uFEFF本文",
    });
    expect(doc).toMatchObject({ content: "本文", saved: "本文", bom: !baseBom, savedBom: baseBom, diskStamp: info.diskStamp });
    expect(isDirty(doc)).toBe(true);
    expect(isDirty(receiveDocText(doc, info))).toBe(true);

    const restored = await restoreDoc({
      ...savedTab, draftBase: doc.saved, draft: doc.content, bom: doc.bom, savedBom: doc.savedBom,
    });
    expect(isDirty(restored)).toBe(true);
    expect(restored.bom).toBe(!baseBom);
  });

  it.each(["保存済み", "外部の内容", "編集中"])("復元時に開けなかったタブの下書きを残す（ディスクの本文: %s）", async (text) => {
    vi.mocked(readTextResult).mockResolvedValue({ error: { code: "not_found", message: "ファイルが見つかりません。" } });
    const doc = await restoreDoc({ ...savedTab, draft: "編集中", draftBase: "保存済み" });
    expect(doc.readError?.code).toBe("not_found");

    const info = textInfo(text);
    const reopened = receiveDocText(doc, info);
    expect(reopened.content).toBe("編集中");
    expect(reopened.saved).toBe("保存済み");
    expect(reopened.readError).toBeUndefined();
    expect(reopened.external).toEqual(text === doc.saved ? undefined : info);
  });

  it("起動時にディスクの本文が変わっていても、下書きと比較元を残す", async () => {
    const info = textInfo("外部の内容");
    vi.mocked(readTextResult).mockResolvedValue({ info });
    const doc = await restoreDoc({ ...savedTab, draft: "編集中", draftBase: "保存済み" });
    expect(doc).toMatchObject({ content: "編集中", saved: "保存済み", external: info });
  });
});
