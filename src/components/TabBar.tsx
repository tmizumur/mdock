import { type ReactNode, useLayoutEffect, useRef } from "react";
import { GitCompare } from "lucide-react";
import { type PaneState, isDirty, isPreview, tabTitle } from "../lib/tabs";
import { TreeIcon, fileIcon } from "../lib/fileIcons";
import { beginDrag, useDrag } from "../lib/dnd";

type Props = {
  paneId: string;
  pane: PaneState;
  actions?: ReactNode;
  onActivate: (idx: number) => void;
  onClose: (idx: number) => void;
  onPin: (tabId: string) => void;
  onContextMenu: (idx: number, x: number, y: number) => void;
};

/**
 * ペインの上のタブ。中クリックで閉じる。
 * ドラッグで並べ替え・ほかのペインへ移動・ペインの端に落として分割（移動の処理は App の setDropHandler）。
 */
export default function TabBar({ paneId, pane, actions, onActivate, onClose, onPin, onContextMenu }: Props) {
  const drag = useDrag();
  const dropAt = drag.target?.type === "tabbar" && drag.target.paneId === paneId ? drag.target.index : null;
  const draggingId = drag.item?.kind === "tab" ? drag.item.tabId : null;
  const barRef = useRef<HTMLDivElement>(null);
  const lastOrder = useRef("");
  const positions = useRef(new Map<string, number>());
  const tabOrder = pane.tabs.map((tab) => tab.id).join(",");

  // 並び順の変更後、残ったタブを移動前の位置から滑らせる。
  useLayoutEffect(() => {
    const bar = barRef.current;
    const tabs = bar?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [];
    const next = new Map<string, number>();
    const moved: HTMLElement[] = [];
    const reordered = lastOrder.current !== tabOrder;
    for (const tab of tabs) {
      const id = tab.dataset.tabId!;
      const x = tab.offsetLeft;
      const previous = positions.current.get(id);
      next.set(id, x);
      if (!reordered || previous === undefined || previous === x) continue;
      tab.style.transition = "none";
      tab.style.translate = `${previous - x}px`;
      moved.push(tab);
    }
    lastOrder.current = tabOrder;
    positions.current = next;
    if (!moved.length) return;
    // 移動前の位置を確定させてから CSS のトランジションを戻す。
    void bar?.offsetWidth;
    for (const tab of moved) {
      tab.style.removeProperty("transition");
      tab.style.removeProperty("translate");
    }
  }, [tabOrder, pane.active]);

  useLayoutEffect(() => {
    const strip = barRef.current;
    const tab = strip?.querySelector<HTMLElement>(".tab.on");
    if (!strip || !tab) return;
    const left = tab.offsetLeft - 2;
    const right = tab.offsetLeft + tab.offsetWidth + 2;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }, [tabOrder, pane.active]);

  return (
    <div className={`tabbar ${dropAt !== null ? "drop-target" : ""}`}>
      <div className="tab-strip" role="tablist" ref={barRef}>
        {pane.tabs.map((t, i) => {
          const dirty = isDirty(t);
          const preview = isPreview(t);
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={i === pane.active}
              className={`tab ${preview ? "preview" : ""} ${i === pane.active ? "on" : ""} ${draggingId === t.id ? "dragging" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === pane.tabs.length && i === pane.tabs.length - 1 ? "drop-after" : ""}`}
              title={t.kind === "doc" ? t.path : `${t.left}\n↔ ${t.right}`}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest(".tab-close")) return;
                beginDrag(e, { kind: "tab", paneId, tabId: t.id, title: tabTitle(t) });
              }}
              onMouseDown={(e) => {
                if (e.button === 0) onActivate(i);
              }}
              onDoubleClick={(e) => {
                if (preview && !(e.target as HTMLElement).closest(".tab-close")) onPin(t.id);
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
              {t.kind === "doc" ? <TreeIcon icon={fileIcon(tabTitle(t))} /> : <GitCompare size={14} className="tree-icon" />}
              <span className="tab-name">{tabTitle(t)}</span>
              {dirty && <span className="tab-dirty" aria-label="未保存の変更">●</span>}
              <button
                className="tab-close"
                aria-label="閉じる"
                title={dirty ? "未保存の変更があります（閉じる ⌘W）" : "閉じる (⌘W)"}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(i);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {actions}
    </div>
  );
}
