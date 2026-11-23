import { GitCompare } from "lucide-react";
import { type PaneState, isDirty, tabTitle } from "../lib/tabs";
import { TreeIcon, fileIcon } from "../lib/fileIcons";
import { beginDrag, useDrag } from "../lib/dnd";

type Props = {
  paneId: string;
  pane: PaneState;
  onActivate: (idx: number) => void;
  onClose: (idx: number) => void;
  onContextMenu: (idx: number, x: number, y: number) => void;
};

/**
 * ペインの上のタブ。中クリックで閉じる。
 * ドラッグで並べ替え・ほかのペインへ移動・ペインの端に落として分割（移動の処理は App の setDropHandler）。
 */
export default function TabBar({ paneId, pane, onActivate, onClose, onContextMenu }: Props) {
  const drag = useDrag();
  const dropAt = drag.target?.type === "tabbar" && drag.target.paneId === paneId ? drag.target.index : null;
  const draggingId = drag.item?.kind === "tab" ? drag.item.tabId : null;

  if (!pane.tabs.length) return null;

  return (
    <div className={`tabbar ${dropAt !== null ? "drop-target" : ""}`} role="tablist">
      {pane.tabs.map((t, i) => {
        const dirty = isDirty(t);
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={i === pane.active}
            className={`tab ${i === pane.active ? "on" : ""} ${draggingId === t.id ? "dragging" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === pane.tabs.length && i === pane.tabs.length - 1 ? "drop-after" : ""}`}
            title={t.kind === "doc" ? t.path : `${t.left}\n↔ ${t.right}`}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest(".tab-close")) return;
              beginDrag(e, { kind: "tab", paneId, tabId: t.id, title: tabTitle(t) });
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
