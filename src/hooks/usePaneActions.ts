import { useState } from "react";
import { type MenuItem } from "../components/Dialogs";
import { type PaneCommand } from "../components/Pane";
import { printWindow } from "../lib/api";
import { type Side } from "../lib/layout";
import { renderAllPending } from "../lib/markdown";
import { activeTab, tabTitle } from "../lib/tabs";
import { type useWorkspace } from "./useWorkspace";

export function usePaneActions(
  { wsRef, focusPane, updatePane, updateActiveTab, otherPane, splitTab, closeTab, closeOthers, compareWithOther, moveTab }:
    Pick<ReturnType<typeof useWorkspace>, "wsRef" | "focusPane" | "updatePane" | "updateActiveTab" | "otherPane" | "splitTab" | "closeTab" | "closeOthers" | "compareWithOther" | "moveTab">,
) {
  const [commands, setCommands] = useState<Record<string, PaneCommand>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const openTabMenu = (paneId: string, tabIdx: number, x: number, y: number) => {
    const p = wsRef.current.panes[paneId];
    const t = p?.tabs[tabIdx];
    if (!t) return;
    const op = otherPane(paneId);
    const other = op ? activeTab(wsRef.current.panes[op]) : undefined;
    const canCompare = t.kind === "doc" && !t.readError && other?.kind === "doc" && !other.readError;
    const splitThis = (side: Side) => {
      updatePane(paneId, (q) => ({ ...q, active: tabIdx }));
      splitTab(paneId, side);
    };
    setMenu({
      x,
      y,
      items: [
        { label: "閉じる", onClick: () => closeTab(paneId, tabIdx) },
        { label: "ほかのタブを閉じる", onClick: () => closeOthers(paneId, tabIdx), disabled: p.tabs.length < 2 },
        "sep",
        { label: "右に分割 (⌘\\)", onClick: () => splitThis("right") },
        { label: "下に分割", onClick: () => splitThis("bottom") },
        "sep",
        {
          label: canCompare ? `隣のペインと比較（${tabTitle(other!)}）` : "隣のペインと比較",
          onClick: () => compareWithOther(paneId, tabIdx),
          disabled: !canCompare,
        },
        op
          ? { label: "隣のペインへ移動", onClick: () => moveTab(paneId, t.id, { paneId: op }), disabled: false }
          : { label: "右に新しいペインを作って移動", onClick: () => moveTab(paneId, t.id, { paneId, split: "right" }), disabled: p.tabs.length < 2 },
      ],
    });
  };

  /**
   * 印刷 / PDF に書き出し: そのペインのプレビューだけを、ライト配色で印刷する。
   * 編集中なら表示モードにし、まだ描いていないコード・図・画像を先に描いてから印刷ダイアログを出す。
   */
  const printPane = async (i: string) => {
    const p = wsRef.current.panes[i];
    const t = p && activeTab(p);
    if (t?.kind !== "doc" || t.readError) return;
    focusPane(i);
    if (t.mode === "edit") updateActiveTab(i, (x) => (x.kind === "doc" ? { ...x, mode: "view" } : x));
    await new Promise((r) => setTimeout(r, 150));
    const body = document.querySelector<HTMLElement>(`.pane[data-pane="${i}"] .markdown-body`);
    if (body) await renderAllPending(body);
    try {
      await printWindow();
    } catch {
      window.print();
    }
  };

  const toggleMode = (i: string) =>
    updateActiveTab(i, (t) => (t.kind === "doc" && !t.readError ? { ...t, mode: t.mode === "view" ? "edit" : "view" } : t));

  const findInPane = (i: string) => setCommands((cs) => ({ ...cs, [i]: { type: "find", n: (cs[i]?.n ?? 0) + 1 } }));

  return { commands, menu, setMenu, openTabMenu, printPane, toggleMode, findInPane };
}
