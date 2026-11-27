import { describe, expect, it } from "vitest";
import { type Entry, type Stat } from "./api";
import { dirsToReread, indexTree, sameEntries, spliceTree } from "./liveReload";

const root = "/workspace";
const docs = "/workspace/Docs";
const archive = "/workspace/Docs/Archive";
const guide: Entry = { path: "/workspace/Docs/guide.md", name: "guide.md", is_dir: false, children: [] };
const sibling: Entry = { path: "/workspace/README.md", name: "README.md", is_dir: false, children: [] };
const tree: Entry[] = [
  {
    path: docs,
    name: "Docs",
    is_dir: true,
    children: [{ path: archive, name: "Archive", is_dir: true, children: [] }, guide],
  },
  sibling,
];

describe("変更後に読み直すフォルダ", () => {
  const index = indexTree(tree);

  it("既存ファイルの内容だけが変わったときはフォルダを読み直さない", () => {
    const stats = new Map<string, Stat>([[guide.path.toLowerCase(), { exists: true, is_dir: false, mtime: 1, size: 50 }]]);

    expect(dirsToReread(root, index, [guide.path], stats)).toEqual([]);
  });

  it("新規ファイルと削除されたファイルについて、最も近い既知の親フォルダを読み直す", () => {
    const changed = [`${archive}/New/notes.md`, guide.path];

    expect(dirsToReread(root, index, changed.slice(0, 1), new Map())).toEqual([archive]);
    expect(dirsToReread(root, index, changed, new Map())).toEqual([docs]);
    expect(dirsToReread(root, index, [`${root}/new.md`], new Map())).toBe("all");
  });
});

describe("ツリーの部分更新", () => {
  it("入れ子のフォルダだけを差し替え、他の項目は同じ参照を使う", () => {
    const added: Entry = { path: `${archive}/notes.md`, name: "notes.md", is_dir: false, children: [] };
    const next = spliceTree(tree, archive.toLowerCase(), [added]);

    expect(next?.[0].children[0].children).toEqual([added]);
    expect(next?.[0].children[1]).toBe(guide);
    expect(next?.[1]).toBe(sibling);
    expect(tree[0].children[0].children).toEqual([]);
  });

  it("同じ内容なら元のツリーを返し、フォルダが見つからなければ null を返す", () => {
    expect(spliceTree(tree, docs, structuredClone(tree[0].children))).toBe(tree);
    expect(spliceTree(tree, `${root}/Missing`, [])).toBeNull();
  });

  it("同じ構造のコピーは等しく、入れ子の変更や項目順の変更は区別する", () => {
    const copy = structuredClone(tree);
    expect(sameEntries(tree, copy)).toBe(true);

    copy[0].children[0].name = "Renamed";
    expect(sameEntries(tree, copy)).toBe(false);
    expect(sameEntries(tree, [sibling, tree[0]])).toBe(false);
  });
});
