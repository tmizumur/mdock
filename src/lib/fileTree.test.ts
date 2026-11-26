import { describe, expect, it } from "vitest";
import { type Entry } from "./api";
import { markdownEntries, treeRows } from "./fileTree";
import { dirsToReread, indexTree, sameEntries, spliceTree } from "./liveReload";

const root = "/workspace";
const docs = `${root}/docs`;
const archive = `${docs}/archive`;
const empty = `${docs}/empty`;
const file: Entry = { path: `${archive}/note.md`, name: "note.md", is_dir: false, children: [] };
const dir = (path: string, children: Entry[] = [], loaded?: boolean): Entry => ({
  path, name: path.split("/").pop()!, is_dir: true, children, loaded,
});
const shallow = [dir(docs, [dir(archive, [], false), dir(empty, [], false)])];
const full = [dir(docs, [dir(archive, [file]), dir(empty)])];

describe("未読フォルダ", () => {
  it("空の結果でも読み込み済みにして、別の枝はそのまま残す", () => {
    const result = spliceTree(shallow, empty, [], true);
    expect(result?.[0].children[1].loaded).toBe(true);
    expect(result?.[0].children[0]).toBe(shallow[0].children[0]);
    expect(sameEntries(shallow, result!)).toBe(false);
  });

  it("全体の読み込み後に届いた展開結果で上書きしない", () => {
    expect(spliceTree(shallow, archive, [file], true)?.[0].children[0].children).toEqual([file]);
    expect(spliceTree(full, archive, [], true)).toBe(full);
  });

  it("未読フォルダの内部変更は読み直さず、フォルダ自体の削除は親に反映する", () => {
    const index = indexTree(shallow);
    expect(dirsToReread(root, index, [file.path], new Map())).toEqual([]);
    expect(dirsToReread(root, index, [archive], new Map())).toEqual([docs]);
  });
});

describe("ツリーの表示", () => {
  const visible = (entries: Entry[], open: Record<string, boolean>, mdOnly = false) =>
    treeRows(mdOnly ? markdownEntries(entries) : entries, root, { open, expandTop: true, creating: null })
      .flatMap((row) => row.kind === "entry" ? [row.entry.path] : []);

  it("全体を差し替えても、展開と折りたたみの指定を保持する", () => {
    const open = { [archive]: true, [empty]: false };
    const complete = [dir(docs, [dir(archive, [file]), dir(empty, [{ ...file, path: `${empty}/note.md` }])])];
    expect(visible(shallow, open)).toEqual([docs, archive, empty]);
    expect(visible(complete, open)).toEqual([docs, archive, file.path, empty]);
    expect(visible(complete, { [docs]: false })).toEqual([docs]);
  });

  it("Markdown 絞り込みでは未読の枝を表示し、読み込み後に空の枝を除外する", () => {
    const open = { [archive]: true };
    expect(visible(shallow, open, true)).toEqual([docs, archive, empty]);
    expect(visible(full, open, true)).toEqual([docs, archive, file.path]);
  });
});
