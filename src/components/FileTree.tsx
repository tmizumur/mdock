import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { beginDrag } from "../lib/dnd";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronRight, ChevronsDownUp, FilePlus, FolderPlus } from "lucide-react";
import { Entry, copyText, createEntry, dirname, isMarkdown, norm, renameEntry, trashEntry } from "../lib/api";
import { TreeIcon, fileIcon, folderIcon } from "../lib/fileIcons";
import { ContextMenu, type MenuItem } from "./Dialogs";
import type { GitLookup, GitMark } from "../lib/git";

type Props = {
  root: string;
  entries: Entry[];
  mdOnly: boolean;
  onFilter: (mdOnly: boolean) => void;
  openPaths: string[];
  onOpen: (path: string, otherPane: boolean, newTab: boolean) => void;
  /** ファイルを作った・消したなど、ツリーを読み直してほしいとき */
  onChanged: () => void;
  /** 名前を変えたとき（開いているタブのパスを直す） */
  onRenamed: (from: string, to: string) => void;
  onError: (message: string) => void;
  /** git の変更状態（リポジトリでない・設定でオフのときは何も返さない） */
  git: GitLookup;
};

/** md を含まないフォルダは「md だけ表示」のとき隠す（作ったばかりのものは keep で残す） */
function filter(entries: Entry[], mdOnly: boolean, keep: Set<string>): Entry[] {
  if (!mdOnly) return entries;
  return entries.flatMap((e) => {
    if (!e.is_dir) return isMarkdown(e.name) || keep.has(e.path) ? [e] : [];
    const children = filter(e.children, mdOnly, keep);
    return children.length || keep.has(e.path) ? [{ ...e, children }] : [];
  });
}

type Creating = { dir: string; isDir: boolean };
type Row =
  | { kind: "entry"; entry: Entry; depth: number; parent: string }
  | { kind: "create"; dir: string; isDir: boolean; depth: number };

const ROW_H = 28;

export function ExplorerControls({ mdOnly, onFilter, onCreate, onCollapse }: Pick<Props, "mdOnly" | "onFilter"> & {
  onCreate?: (isDir: boolean) => void;
  onCollapse?: () => void;
}) {
  return (
    <>
      <div className="sidebar-head">
        <span className="sidebar-label">エクスプローラー</span>
        <div className="explorer-actions">
          <button className="icon-btn" title="新規ファイル" aria-label="新規ファイル" disabled={!onCreate} onClick={() => onCreate?.(false)}>
            <FilePlus size={15} />
          </button>
          <button className="icon-btn" title="新規フォルダ" aria-label="新規フォルダ" disabled={!onCreate} onClick={() => onCreate?.(true)}>
            <FolderPlus size={15} />
          </button>
          <button className="icon-btn" title="フォルダをすべて閉じる" aria-label="フォルダをすべて閉じる" disabled={!onCollapse} onClick={onCollapse}>
            <ChevronsDownUp size={15} />
          </button>
        </div>
      </div>
      <div className="segmented tree-filter" role="group" aria-label="表示するファイル">
        <button className={mdOnly ? "on" : ""} aria-pressed={mdOnly} onClick={() => onFilter(true)}>.md のみ</button>
        <button className={!mdOnly ? "on" : ""} aria-pressed={!mdOnly} onClick={() => onFilter(false)}>すべて</button>
      </div>
    </>
  );
}

/**
 * ファイルツリー。展開している行を平らなリストにして、見えている行だけ描く（1万ファイルでも軽い）。
 * ↑↓ で移動、→← で開閉、Enter で開く。右クリックでファイル操作。
 */
export default function FileTree({ root, entries, mdOnly, onFilter, openPaths, onOpen, onChanged, onRenamed, onError, git }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [expandTop, setExpandTop] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const isOpen = (e: Entry, depth: number) => open[e.path] ?? (expandTop && depth === 0);

  const shown = useMemo(() => filter(entries, mdOnly, keep), [entries, mdOnly, keep]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (creating && norm(creating.dir) === norm(root)) out.push({ kind: "create", dir: root, isDir: creating.isDir, depth: 0 });
    const walk = (list: Entry[], depth: number, parent: string) => {
      for (const e of list) {
        out.push({ kind: "entry", entry: e, depth, parent });
        if (e.is_dir && isOpen(e, depth)) {
          if (creating && creating.dir === e.path) out.push({ kind: "create", dir: e.path, isDir: creating.isDir, depth: depth + 1 });
          walk(e.children, depth + 1, e.path);
        }
      }
    };
    walk(shown, 0, root);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, open, creating, root, expandTop]);

  const virt = useVirtualizer({
    count: rows.length,
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "create" ? `create:${row.dir}:${row.isDir}` : row.entry.path;
    },
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  useLayoutEffect(() => {
    if (!creating) return;
    const index = rows.findIndex((r) => r.kind === "create");
    if (index >= 0) virt.scrollToIndex(index, { align: "auto" });
  }, [creating, rows, virt]);

  const indexOf = (path: string | null) => (path ? rows.findIndex((r) => r.kind === "entry" && r.entry.path === path) : -1);

  const select = (path: string) => {
    setSelected(path);
    const i = indexOf(path);
    if (i >= 0) virt.scrollToIndex(i, { align: "auto" });
  };

  const toggle = (e: Entry, depth: number, value?: boolean) => setOpen((o) => ({ ...o, [e.path]: value ?? !isOpen(e, depth) }));

  // ---- ファイル操作 ----
  const startCreate = (dir: string, isDir: boolean) => {
    setOpen((o) => ({ ...o, [dir]: true }));
    setCreating({ dir, isDir });
  };
  const commitCreate = async (name: string) => {
    const c = creating;
    setCreating(null);
    if (!c || !name.trim()) return;
    try {
      const path = await createEntry(c.dir, name, c.isDir);
      setKeep((k) => new Set(k).add(path));
      setSelected(path);
      onChanged();
      if (!c.isDir) onOpen(path, false, false);
    } catch (e) {
      onError(`作成できませんでした: ${e}`);
    }
  };
  const commitRename = async (path: string, name: string) => {
    setRenaming(null);
    const old = path.split("/").pop();
    if (!name.trim() || name === old) return;
    try {
      const to = await renameEntry(path, name);
      setKeep((k) => new Set(k).add(to));
      setSelected(to);
      onRenamed(path, to);
      onChanged();
    } catch (e) {
      onError(`名前を変更できませんでした: ${e}`);
    }
  };
  const trash = async (path: string) => {
    try {
      await trashEntry(path);
      onChanged();
    } catch (e) {
      onError(`ゴミ箱に移動できませんでした: ${e}`);
    }
  };
  const relPath = (p: string) => (norm(p).startsWith(norm(root) + "/") ? norm(p).slice(norm(root).length + 1) : p);

  const openMenu = (ev: React.MouseEvent, e: Entry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (e) setSelected(e.path);
    const dir = e ? (e.is_dir ? e.path : dirname(e.path)) : root;
    const target = e?.path ?? root;
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      items: [
        { label: "新規ファイル", onClick: () => startCreate(dir, false) },
        { label: "新規フォルダ", onClick: () => startCreate(dir, true) },
        "sep",
        ...(e
          ? ([
              { label: "名前を変更", onClick: () => setRenaming(e.path) },
              { label: "ゴミ箱に入れる", onClick: () => trash(e.path) },
              "sep",
            ] as MenuItem[])
          : []),
        { label: "Finder で表示", onClick: () => revealItemInDir(target).catch((err) => onError(String(err))) },
        { label: "パスをコピー", onClick: () => copyText(target) },
        { label: "相対パスをコピー", onClick: () => copyText(e ? relPath(target) : "."), disabled: !e },
      ],
    });
  };

  // ---- キーボード操作 ----
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (renaming || creating || (ev.target as HTMLElement).tagName === "INPUT") return;
    const i = indexOf(selected);
    const row = rows[i];
    const entryRows = (from: number, step: number) => {
      for (let k = from; k >= 0 && k < rows.length; k += step) if (rows[k].kind === "entry") return rows[k];
      return undefined;
    };
    const go = (r: Row | undefined) => r?.kind === "entry" && select(r.entry.path);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      go(i < 0 ? entryRows(0, 1) : entryRows(i + 1, 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      go(i < 0 ? entryRows(0, 1) : entryRows(i - 1, -1));
    } else if (row?.kind !== "entry") {
      return;
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      if (row.entry.is_dir) {
        if (!isOpen(row.entry, row.depth)) toggle(row.entry, row.depth, true);
        else go(entryRows(i + 1, 1));
      }
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (row.entry.is_dir && isOpen(row.entry, row.depth)) toggle(row.entry, row.depth, false);
      else if (row.parent !== root) select(row.parent);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (row.entry.is_dir) toggle(row.entry, row.depth);
      else onOpen(row.entry.path, ev.metaKey || ev.ctrlKey, ev.altKey);
    } else if (ev.key === "Backspace" && ev.metaKey) {
      ev.preventDefault();
      trash(row.entry.path);
    }
  };

  // 開いているファイルが変わったら、ツリーの選択も合わせる
  const firstOpen = openPaths[0];
  useEffect(() => {
    if (firstOpen && document.activeElement !== scroller.current) setSelected(firstOpen);
  }, [firstOpen]);

  const createInSelection = (isDir: boolean) => {
    const row = rows[indexOf(selected)];
    const dir = row?.kind === "entry" ? (row.entry.is_dir ? row.entry.path : row.parent) : root;
    startCreate(dir, isDir);
  };

  return (
    <>
      <ExplorerControls mdOnly={mdOnly} onFilter={onFilter} onCreate={createInSelection} onCollapse={() => {
        setExpandTop(false);
        setOpen({});
        setCreating(null);
      }} />
      {!shown.length && !creating ? (
        <div className="tree-empty" onContextMenu={(ev) => openMenu(ev, null)}>
          {mdOnly ? "Markdown ファイルがありません" : "ファイルがありません"}
          {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </div>
      ) : (
        <div
          className="tree"
          ref={scroller}
          role="tree"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={(ev) => openMenu(ev, null)}
        >
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const r = rows[v.index];
              return (
                <div key={v.key} className="tree-item" style={{ transform: `translateY(${v.start}px)`, height: ROW_H }}>
                  {r.kind === "create" ? (
                    <NameInput
                      depth={r.depth}
                      isDir={r.isDir}
                      initial=""
                      placeholder={r.isDir ? "フォルダ名" : "ファイル名.md"}
                      onDone={commitCreate}
                      onCancel={() => setCreating(null)}
                    />
                  ) : renaming === r.entry.path ? (
                    <NameInput
                      depth={r.depth}
                      isDir={r.entry.is_dir}
                      name={r.entry.name}
                      initial={r.entry.name}
                      onDone={(n) => commitRename(r.entry.path, n)}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <Row
                      entry={r.entry}
                      gitMark={git.get(r.entry.path)?.mark}
                      gitFolder={git.get(r.entry.path)?.folder ?? false}
                      depth={r.depth}
                      expanded={r.entry.is_dir && isOpen(r.entry, r.depth)}
                      active={!r.entry.is_dir && openPaths.includes(r.entry.path)}
                      selected={selected === r.entry.path}
                      onClick={(ev) => {
                        setSelected(r.entry.path);
                        if (r.entry.is_dir) toggle(r.entry, r.depth);
                        else onOpen(r.entry.path, ev.metaKey || ev.ctrlKey, ev.altKey);
                      }}
                      onContextMenu={(ev) => openMenu(ev, r.entry)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </div>
      )}
    </>
  );
}

const GIT_TITLE: Record<GitMark, string> = { M: "変更あり", A: "追加（ステージ済み）・名前変更", U: "未追跡", C: "競合", I: "無視（.gitignore）" };

const Row = memo(function Row({
  entry,
  gitMark,
  gitFolder,
  depth,
  expanded,
  active,
  selected,
  onClick,
  onContextMenu,
}: {
  entry: Entry;
  gitMark?: GitMark;
  gitFolder: boolean;
  depth: number;
  expanded: boolean;
  active: boolean;
  selected: boolean;
  onClick: (ev: React.MouseEvent) => void;
  onContextMenu: (ev: React.MouseEvent) => void;
}) {
  const pad = 8 + depth * 14;
  const gitCls = gitMark ? `git-${gitMark}` : "";
  // 右端の印: ファイルは M / U / !、変更を含むフォルダは点（無視されたものは薄くするだけ）
  const gitEnd =
    !gitMark || gitMark === "I" ? null : gitFolder || entry.is_dir ? (
      <span className="git-dot" title={gitFolder ? "中に変更があります" : GIT_TITLE[gitMark]} />
    ) : (
      <span className="git-badge" title={GIT_TITLE[gitMark]}>
        {gitMark === "C" ? "!" : gitMark === "A" ? "U" : gitMark}
      </span>
    );
  if (entry.is_dir) {
    return (
      <div
        className={`tree-row dir ${selected ? "selected" : ""} ${gitCls}`}
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={selected}
        style={{ paddingLeft: pad }}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <ChevronRight className="chev" size={10} aria-hidden="true" />
        <TreeIcon icon={folderIcon(expanded)} />
        <span className="tree-name">{entry.name}</span>
        {gitEnd}
      </div>
    );
  }
  return (
    <div
      className={`tree-row file ${active ? "active" : ""} ${selected ? "selected" : ""} ${isMarkdown(entry.name) ? "" : "dim"} ${gitCls}`}
      role="treeitem"
      aria-selected={selected}
      style={{ paddingLeft: pad + 16 }}
      title="クリックで開く / ⌘+クリックで隣のペイン / ⌥+クリックで新しいタブ / ペインへドラッグ（端に落とすと分割）"
      onPointerDown={(e) => beginDrag(e, { kind: "file", path: entry.path, title: entry.name })}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <TreeIcon icon={fileIcon(entry.name)} />
      <span className="tree-name">{entry.name}</span>
      {gitEnd}
    </div>
  );
});

/** その場で名前を入力する欄（新規作成・名前の変更） */
function NameInput({
  depth,
  isDir,
  name,
  initial,
  placeholder,
  onDone,
  onCancel,
}: {
  depth: number;
  isDir: boolean;
  name?: string;
  initial: string;
  placeholder?: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // 拡張子の前までを選択（Finder と同じ）
    const dot = !isDir && initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length;
    el.setSelectionRange(0, dot);
  }, [initial, isDir]);
  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value ?? "";
    if (ok && v.trim()) onDone(v.trim());
    else onCancel();
  };
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 + (isDir ? 0 : 16) }}>
      {isDir && <span className="chev">▸</span>}
      <TreeIcon icon={isDir ? folderIcon(false) : fileIcon(name ?? "a.md")} />
      <input
        ref={ref}
        className="tree-input"
        defaultValue={initial}
        placeholder={placeholder}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(true);
          else if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}
