import { useEffect } from "react";
import { openNewWindow } from "../lib/api";
import { leaves } from "../lib/layout";
import { BEFORE_JUMP } from "../lib/navHistory";
import { DEFAULT_SETTINGS, type useSettings } from "../lib/settings";
import { activeTab, emptyPane } from "../lib/tabs";
import { type useMenuActions } from "./useMenuActions";
import { type usePaneActions } from "./usePaneActions";
import { type useWorkspace } from "./useWorkspace";

export function useShortcuts(
  { livePane, activeRef, cycleTab, wsRef, toggleSplit, splitTab, focusPane, splitWith, navigate, recordJump }:
    Pick<ReturnType<typeof useWorkspace>, "livePane" | "activeRef" | "cycleTab" | "wsRef" | "toggleSplit" | "splitTab" | "focusPane" | "splitWith" | "navigate" | "recordJump">,
  { findInPane, toggleMode }: Pick<ReturnType<typeof usePaneActions>, "findInPane" | "toggleMode">,
  { actions, run }: ReturnType<typeof useMenuActions>,
  updateSettings: ReturnType<typeof useSettings>["update"],
  setSettingsOpen: (open: boolean) => void,
  setError: (error: string | null) => void,
) {
  // メニュー（表示・編集）からも呼ぶ操作
  Object.assign(actions.current, {
    find: () => findInPane(livePane(activeRef.current)),
    "toggle-mode": () => {
      const i = livePane(activeRef.current);
      if (activeTab(wsRef.current.panes[i] ?? emptyPane())?.kind === "doc") toggleMode(i);
    },
    back: () => navigate(livePane(activeRef.current), -1),
    forward: () => navigate(livePane(activeRef.current), 1),
    "prev-tab": () => cycleTab(-1),
    "next-tab": () => cycleTab(1),
    "split-right": () => splitTab(livePane(activeRef.current), "right"),
    "toggle-split-rows": () => toggleSplit("col"),
    "zoom-in": () => updateSettings((s) => ({ fontSize: s.fontSize + 1 })),
    "zoom-out": () => updateSettings((s) => ({ fontSize: s.fontSize - 1 })),
    "zoom-reset": () => updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize }),
  } satisfies Record<string, () => void>);

  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // アプリのショートカットは ⌘ だけ（Control-E などは入力欄・エディタの操作に任せる）
      if (!e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "," && !e.shiftKey) {
        // ⌘,: 設定（メニューのショートカットが先に受け取ることが多いが、念のため）
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.shiftKey && (k === "[" || k === "{" || k === "]" || k === "}")) {
        // ⌘⇧[ / ⌘⇧] でタブを移動
        e.preventDefault();
        run(k === "[" || k === "{" ? "prev-tab" : "next-tab", "key");
      } else if (!e.shiftKey && !e.altKey && (k === "[" || k === "]")) {
        // ⌘[ / ⌘]: 戻る / 進む
        // エディタが自分で処理した（字下げ）ときは何もしない
        if (e.defaultPrevented) return;
        e.preventDefault();
        run(k === "[" ? "back" : "forward", "key");
      } else if (k === "f" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) run("search-folder", "key");
      } else if (k === "f" && !e.shiftKey) {
        // CodeMirror が自分で処理した場合（エディタにフォーカスがある）は何もしない
        if (e.defaultPrevented) return;
        e.preventDefault();
        run("find", "key");
      } else if (k === "=" || k === "+" || k === ";") {
        // ⌘+（JIS キーボードでは ⌘; の位置）で文字を大きく
        e.preventDefault();
        run("zoom-in", "key");
      } else if (k === "-") {
        e.preventDefault();
        run("zoom-out", "key");
      } else if (k === "0") {
        e.preventDefault();
        run("zoom-reset", "key");
      } else if (k === "s") {
        e.preventDefault();
        run("save", "key");
      } else if (k === "p" && !e.shiftKey) {
        e.preventDefault();
        run("print", "key");
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        openNewWindow().catch((err) => setError(String(err)));
      } else if (k === "o") {
        e.preventDefault();
        run(e.shiftKey ? "open-folder" : "open-file", "key");
      } else if (k === "w") {
        e.preventDefault();
        run("close-tab", "key");
      } else if (k === "e") {
        e.preventDefault();
        run("toggle-mode", "key");
      } else if (e.altKey && !e.shiftKey && (e.code === "Backslash" || e.code === "IntlYen" || k === "\\")) {
        // ⌘⌥\: 上下に分割／1画面に戻す
        e.preventDefault();
        run("toggle-split-rows", "key");
      } else if (k === "\\" && !e.shiftKey && !e.altKey) {
        // ⌘\: 今のペインを右に分割（今のタブを複製して開く）
        e.preventDefault();
        run("split-right", "key");
      } else if (/^[1-9]$/.test(k) && !e.shiftKey && !e.altKey) {
        // ⌘1〜⌘9: 画面上の順で n 番目のペインへ。1 つ先なら右端に新しいペインを作る（VS Code と同じ）
        e.preventDefault();
        const o = leaves(wsRef.current.layout);
        const n = Number(k) - 1;
        if (n < o.length) focusPane(o[n]);
        else if (n === o.length) splitWith(o[o.length - 1], "right", []);
      }
    };
    // マウスの戻る／進むボタン
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      run(e.button === 3 ? "back" : "forward", "key");
    };
    // ページ内リンクで移る前の位置を、そのペインの履歴に残す
    const onJump = (e: Event) => {
      const pane = (e.target as Element | null)?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
      if (pane) recordJump(pane);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener(BEFORE_JUMP, onJump);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener(BEFORE_JUMP, onJump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
