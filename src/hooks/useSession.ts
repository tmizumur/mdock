import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { type useUnsavedDialog } from "../components/Dialogs";
import { cancelQuit, saveSession } from "../lib/api";
import { leaves } from "../lib/layout";
import { restorePane, restoreSession } from "../lib/session";
import { type PaneState, type SavedTab, type Session, type Tab, emptyPane, isDirty, tabTitle } from "../lib/tabs";
import { allTabs, mapPanes } from "../lib/workspace";
import { type useFolder } from "./useFolder";
import { type useWorkspace } from "./useWorkspace";

export function useRestoreSession(
  { openFolder }: Pick<ReturnType<typeof useFolder>, "openFolder">,
  { scrolls, apply, focusPane }: Pick<ReturnType<typeof useWorkspace>, "scrolls" | "apply" | "focusPane">,
) {
  const [ready, setReady] = useState(false);
  /** サイドバーとペイン全体の幅 */
  const sidebarLayout = useRef<Session["sidebar"]>(undefined);

  // 起動時: 前回のフォルダ・タブ・表示モード・スクロール位置・未保存の編集を復元
  useEffect(() => {
    let active = true;
    (async () => {
      const s = await restoreSession();
      if (!active) return;
      sidebarLayout.current = s.sidebar;
      const ids = leaves(s.layout);
      const [, restored] = await Promise.all([
        s.root && openFolder(s.root, false, true),
        Promise.all(ids.map((id) => restorePane(s.panes[id], scrolls.current))),
      ]);
      if (!active) return;
      const panes: Record<string, PaneState> = {};
      ids.forEach((id, i) => (panes[id] = restored[i]));
      apply(() => ({ layout: s.layout, panes }));
      focusPane(ids.includes(s.activePane) ? s.activePane : ids[0]);
      setReady(true);
    })();
    return () => { active = false; };
  }, [apply, focusPane, openFolder, scrolls]);

  return { ready, sidebarLayout };
}

export function usePersist(
  { ready, sidebarLayout }: ReturnType<typeof useRestoreSession>,
  { root, rootRef }: Pick<ReturnType<typeof useFolder>, "root" | "rootRef">,
  { activeIdx, activeRef, apply, saveTab, scrolls, ws, wsRef }:
    Pick<ReturnType<typeof useWorkspace>, "activeIdx" | "activeRef" | "apply" | "saveTab" | "scrolls" | "ws" | "wsRef">,
  ask: ReturnType<typeof useUnsavedDialog>["ask"],
) {
  // 状態をファイルに保存（変更から少し待ってまとめて書く）
  const saveTimer = useRef<number | undefined>(undefined);
  const persist = useCallback(() => {
    const saveTabState = (t: Tab): SavedTab => {
      const scroll = scrolls.current.get(t.id) ?? 0;
      if (t.kind === "diff") {
        const left = t.reads?.left?.force;
        const right = t.reads?.right?.force;
        return { kind: "diff", left: t.left, right: t.right, scroll, force: left || right ? { left, right } : undefined };
      }
      return {
        path: t.path,
        mode: t.mode,
        scroll,
        encoding: t.encoding,
        bom: t.bom ?? false,
        force: t.force,
        ...(t.content !== t.saved ? { draft: t.content, draftBase: t.saved } : {}),
      };
    };
    const w = wsRef.current;
    const panes: Session["panes"] = {};
    for (const id of leaves(w.layout)) {
      const p = w.panes[id] ?? emptyPane();
      panes[id] = { tabs: p.tabs.map(saveTabState), active: p.active };
    }
    const s: Session = {
      version: 4,
      root: rootRef.current,
      panes,
      layout: w.layout,
      activePane: activeRef.current,
      ...(sidebarLayout.current ? { sidebar: sidebarLayout.current } : {}),
    };
    return saveSession(JSON.stringify(s)).catch((e) => console.warn("save session", e));
  }, [activeRef, rootRef, scrolls, sidebarLayout, wsRef]);
  const schedulePersist = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(persist, 400);
  }, [persist]);

  useEffect(() => {
    if (ready) schedulePersist();
  }, [ready, root, ws, activeIdx, schedulePersist]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    await persist();
    await saveWindowState(StateFlags.ALL).catch(() => {});
  }, [persist]);

  // 閉じるとき（⌘Q を含む）: 未保存の変更があれば「保存 / 保存しない / キャンセル」を確認してから閉じる
  const onCloseRef = useRef<(ev: { preventDefault: () => void }) => Promise<void>>(async () => {});
  onCloseRef.current = async (ev) => {
    const dirty = allTabs(wsRef.current).filter(isDirty);
    if (!dirty.length) {
      await flush();
      return;
    }
    ev.preventDefault();
    const c = await ask(
      dirty.length === 1 ? `「${tabTitle(dirty[0])}」の変更を保存しますか？` : `${dirty.length} 個のファイルに未保存の変更があります。保存しますか？`,
      "保存しないと、変更は失われます。",
    );
    if (c === "cancel") {
      cancelQuit().catch(() => {}); // ⌘Q の終了も取りやめる
      return;
    }
    if (c === "save") {
      for (const t of dirty)
        if (!(await saveTab(t.id))) {
          cancelQuit().catch(() => {});
          return;
        }
    } else {
      // 保存しない: 編集内容を捨ててから状態を書き出す（次に開いたとき復元しない）
      apply((w) => mapPanes(w, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.kind === "doc" ? { ...t, content: t.saved } : t)) })));
    }
    await flush();
    await getCurrentWindow().destroy();
  };

  // ウィンドウを動かしたとき・閉じるときにも保存する
  useEffect(() => {
    const win = getCurrentWindow();
    let t: number | undefined;
    const saveWin = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => saveWindowState(StateFlags.ALL).catch(() => {}), 500);
    };
    const uns = [win.onMoved(saveWin), win.onResized(saveWin), win.onCloseRequested((ev) => onCloseRef.current(ev))];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);

  return { schedulePersist, flush };
}
