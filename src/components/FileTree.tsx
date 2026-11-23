import { memo, useState } from "react";
import { Entry, isMarkdown } from "../lib/api";
import { TreeIcon, fileIcon, folderIcon } from "../lib/fileIcons";

type Props = {
  entries: Entry[];
  mdOnly: boolean;
  openPaths: string[];
  onOpen: (path: string, otherPane: boolean, newTab: boolean) => void;
};

/** md を含まないフォルダは「md だけ表示」のとき隠す */
function filter(entries: Entry[], mdOnly: boolean): Entry[] {
  if (!mdOnly) return entries;
  return entries.flatMap((e) => {
    if (!e.is_dir) return isMarkdown(e.name) ? [e] : [];
    const children = filter(e.children, mdOnly);
    return children.length ? [{ ...e, children }] : [];
  });
}

export default function FileTree({ entries, mdOnly, openPaths, onOpen }: Props) {
  const shown = filter(entries, mdOnly);
  if (!shown.length) return <div className="tree-empty">Markdown ファイルがありません</div>;
  return (
    <ul className="tree" role="tree">
      {shown.map((e) => (
        <Node key={e.path} entry={e} depth={0} openPaths={openPaths} onOpen={onOpen} />
      ))}
    </ul>
  );
}

const Node = memo(function Node({
  entry,
  depth,
  openPaths,
  onOpen,
}: {
  entry: Entry;
  depth: number;
  openPaths: string[];
  onOpen: Props["onOpen"];
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const pad = { paddingLeft: 8 + depth * 14 };

  if (entry.is_dir) {
    return (
      <li role="treeitem" aria-expanded={expanded}>
        <div className="tree-row dir" style={pad} onClick={() => setExpanded(!expanded)}>
          <span className="chev">{expanded ? "▾" : "▸"}</span>
          <TreeIcon def={folderIcon(entry.name, expanded)} />
          <span className="tree-name">{entry.name}</span>
        </div>
        {expanded && (
          <ul role="group">
            {entry.children.map((c) => (
              <Node key={c.path} entry={c} depth={depth + 1} openPaths={openPaths} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const active = openPaths.includes(entry.path);
  return (
    <li role="treeitem">
      <div
        className={`tree-row file ${active ? "active" : ""} ${isMarkdown(entry.name) ? "" : "dim"}`}
        style={{ paddingLeft: pad.paddingLeft + 16 }}
        title="クリックで開く / ⌘+クリックでもう片方のペイン / ⌥+クリックで新しいタブ"
        onClick={(ev) => onOpen(entry.path, ev.metaKey || ev.ctrlKey, ev.altKey)}
      >
        <TreeIcon def={fileIcon(entry.name)} />
        <span className="tree-name">{entry.name}</span>
      </div>
    </li>
  );
});
