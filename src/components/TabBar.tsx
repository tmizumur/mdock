import { useState } from "react";
import { GitCompare } from "lucide-react";
import { type PaneState, isDirty, tabTitle } from "../lib/tabs";
import { TreeIcon, fileIcon } from "../lib/fileIcons";

const DND_TYPE = "application/x-mdock-tab";

type Props = {
  paneIdx: number;
  pane: PaneState;
  onActivate: (idx: number) => void;
  onClose: (idx: number) => void;
  /** タブのドラッグ: from のペイン・位置から、このペインの toIdx の前へ */
  onMove: (fromPane: number, fromIdx: number, toIdx: number) => void;
  onContextMenu: (idx: number, x: number, y: number) => void;
};

/** ペインの上のタブ。中クリックで閉じる、ドラッグで並べ替え・ほかのペインへ移動。 */
export default function TabBar({ paneIdx, pane, onActivate, onClose, onMove, onContextMenu }: Props) {
  const [dropAt, setDropAt] = useState<number | null>(null);

  const readDrag = (e: React.DragEvent) => {
    try {
      return JSON.parse(e.dataTransfer.getData(DND_TYPE)) as { pane: number; idx: number };
    } catch {
      return null;
    }
  };
  const accept = (e: React.DragEvent) => e.dataTransfer.types.includes(DND_TYPE);

  if (!pane.tabs.length) return null;

  return (
    <div
      className="tabbar"
      role="tablist"
      onDragOver={(e) => {
        if (!accept(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (e.target === e.currentTarget) setDropAt(pane.tabs.length);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
      }}
      onDrop={(e) => {
        const d = readDrag(e);
        const to = dropAt ?? pane.tabs.length;
        setDropAt(null);
        if (!d) return;
        e.preventDefault();
        onMove(d.pane, d.idx, to);
      }}
    >
      {pane.tabs.map((t, i) => {
        const dirty = isDirty(t);
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={i === pane.active}
            className={`tab ${i === pane.active ? "on" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === pane.tabs.length && i === pane.tabs.length - 1 ? "drop-after" : ""}`}
            title={t.kind === "doc" ? t.path : `${t.left}\n↔ ${t.right}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, JSON.stringify({ pane: paneIdx, idx: i }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!accept(e)) return;
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
            }}
            onMouseDown={(e) => {
              if (e.button === 0) onActivate(i);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(i);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(i, e.clientX, e.clientY);
            }}
          >
            {t.kind === "doc" ? <TreeIcon def={fileIcon(tabTitle(t))} /> : <GitCompare size={14} className="tree-icon" />}
            <span className="tab-name">{tabTitle(t)}</span>
            <button
              className={`tab-close ${dirty ? "dirty" : ""}`}
              title={dirty ? "未保存の変更があります（閉じる ⌘W）" : "閉じる (⌘W)"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
            >
              <span className="dot">●</span>
              <span className="x">×</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
