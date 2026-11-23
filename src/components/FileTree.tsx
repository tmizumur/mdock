import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Entry, copyText, createEntry, dirname, isMarkdown, norm, renameEntry, trashEntry } from "../lib/api";
import { TreeIcon, fileIcon, folderIcon } from "../lib/fileIcons";
import { ContextMenu, type MenuItem } from "./Dialogs";

type Props = {
  root: string;
  entries: Entry[];
  mdOnly: boolean;
  openPaths: string[];
  onOpen: (path: string, otherPane: boolean, newTab: boolean) => void;
  /** ファイルを作った・消したなど、ツリーを読み直してほしいとき */
  onChanged: () => void;
  /** 名前を変えたとき（開いているタブのパスを直す） */
  onRenamed: (from: string, to: string) => void;
  onError: (message: string) => void;
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

const ROW_H = 26;

/**
 * ファイルツリー。展開している行を平らなリストにして、見えている行だけ描く（1万ファイルでも軽い）。
 * ↑↓ で移動、→← で開閉、Enter で開く。右クリックでファイル操作。
 */
export default function FileTree({ root, entries, mdOnly, openPaths, onOpen, onChanged, onRenamed, onError }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const isOpen = (e: Entry, depth: number) => open[e.path] ?? depth < 1;

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
  }, [shown, open, creating, root]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

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

  if (!shown.length && !creating) {
    return (
      <div className="tree-empty" onContextMenu={(ev) => openMenu(ev, null)}>
        {mdOnly ? "Markdown ファイルがありません" : "ファイルがありません"}
        {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      </div>
    );
  }

  return (
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
  );
}

const Row = memo(function Row({
  entry,
  depth,
  expanded,
  active,
  selected,
  onClick,
  onContextMenu,
}: {
  entry: Entry;
  depth: number;
  expanded: boolean;
  active: boolean;
  selected: boolean;
  onClick: (ev: React.MouseEvent) => void;
  onContextMenu: (ev: React.MouseEvent) => void;
}) {
  const pad = 8 + depth * 14;
  if (entry.is_dir) {
    return (
      <div
        className={`tree-row dir ${selected ? "selected" : ""}`}
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={selected}
        style={{ paddingLeft: pad }}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <span className="chev">{expanded ? "▾" : "▸"}</span>
        <TreeIcon def={folderIcon(entry.name, expanded)} />
        <span className="tree-name">{entry.name}</span>
      </div>
    );
  }
  return (
    <div
      className={`tree-row file ${active ? "active" : ""} ${selected ? "selected" : ""} ${isMarkdown(entry.name) ? "" : "dim"}`}
      role="treeitem"
      aria-selected={selected}
      style={{ paddingLeft: pad + 16 }}
      title="クリックで開く / ⌘+クリックでもう片方のペイン / ⌥+クリックで新しいタブ"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <TreeIcon def={fileIcon(entry.name)} />
      <span className="tree-name">{entry.name}</span>
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
      <TreeIcon def={isDir ? folderIcon(name ?? "", false) : fileIcon(name ?? "a.md")} />
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
