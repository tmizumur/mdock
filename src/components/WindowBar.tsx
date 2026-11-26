import { useEffect, useRef, useState } from "react";
import { ChevronDown, Columns2, GitBranch, PanelLeft, Rows2, Settings } from "lucide-react";
import { norm } from "../lib/api";
import type { LayoutNode, PresetLayout } from "../lib/layout";
import { ContextMenu } from "./Dialogs";
import UpdateButton from "./UpdateButton";

const LAYOUTS = [
  ["row", "左右に分割", Columns2, "左右に分割（もう一度押すと元に戻す・右クリックで3分割）"],
  ["col", "上下に分割", Rows2, "上下に分割（もう一度押すと元に戻す） ⌘⌥\\"],
] as const;

const RECENT_KEY = "mdock.recentFolders";
const folderName = (path: string) => norm(path).replace(/\/+$/, "").split("/").pop() || path;

function readRecentFolders(): string[] {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
  } catch {
    return [];
  }
}

type Props = {
  root: string | null;
  branch: string | null;
  error: string | null;
  layout: LayoutNode;
  sidebarOpen: boolean;
  ready: boolean;
  onToggleSidebar: () => void;
  onPickFolder: () => void;
  onOpenFolder: (dir: string) => void;
  onLayout: (layout: PresetLayout) => void;
  onToggleSplit: (dir: "row" | "col") => void;
  onSettings: () => void;
  beforeRestart: () => Promise<unknown>;
};

export default function WindowBar({ root, branch, error, layout, sidebarOpen, ready, onToggleSidebar, onPickFolder, onOpenFolder, onLayout, onToggleSplit, onSettings, beforeRestart }: Props) {
  const [recent, setRecent] = useState<string[] | null>(null);
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number } | null>(null);
  const folderMenu = useRef<HTMLDivElement>(null);
  const folderButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!root) return;
    const paths = [root, ...readRecentFolders().filter((dir) => norm(dir) !== norm(root))].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(paths));
    } catch (e) {
      console.warn("recent folders", e);
    }
  }, [root]);

  const folderOpen = recent !== null;
  useEffect(() => {
    if (!folderOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!folderMenu.current?.contains(e.target as Node)) setRecent(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setRecent(null);
      folderButton.current?.focus();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [folderOpen]);

  const selected = layout.type === "split" ? layout.dir : null;

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="window-controls-space" data-tauri-drag-region />
      <button className="icon-btn toolbar-icon" aria-pressed={sidebarOpen} disabled={!ready}
        onClick={onToggleSidebar} title="サイドバーを切り替え" aria-label="サイドバーを切り替え">
        <PanelLeft size={16} />
      </button>
      <div className="popover-anchor folder-picker" ref={folderMenu}>
        <button className="icon-btn folder-button" ref={folderButton} aria-expanded={folderOpen}
          onClick={() => setRecent(folderOpen ? null : readRecentFolders().filter((dir) => norm(dir) !== norm(root ?? "")))}
          title={root ?? "フォルダを開く (⌘O)"}>
          <span>{root ? folderName(root) : "フォルダを開く"}</span>
          <ChevronDown size={13} />
        </button>
        {recent && (
          <div className="popover folder-popover">
            <button onClick={() => { setRecent(null); onPickFolder(); }}>フォルダを開く…</button>
            {recent.length > 0 && (
              <>
                <div className="folder-menu-label">最近のフォルダ</div>
                {recent.map((dir) => (
                  <button key={dir} title={dir} onClick={() => {
                    setRecent(null);
                    folderButton.current?.focus();
                    onOpenFolder(dir);
                  }}>
                    {dir}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {branch && <span className="branch-badge" title={branch}><GitBranch size={12} /><span>{branch}</span></span>}
      <span className="spacer" data-tauri-drag-region />
      {error && <span className="error" role="status" title={error}>{error}</span>}
      <div className="segmented icons layout-segment" role="group" aria-label="レイアウト"
        onContextMenu={(e) => {
          e.preventDefault();
          setLayoutMenu({ x: e.clientX, y: e.clientY });
        }}>
        {LAYOUTS.map(([dir, label, Icon, title]) => (
          <button key={dir} onClick={() => onToggleSplit(dir)} className={selected === dir ? "on" : ""}
            title={title} aria-label={label} aria-pressed={selected === dir}>
            <Icon size={15} />
          </button>
        ))}
      </div>
      <button className="icon-btn toolbar-icon" onClick={onSettings} title="設定 (⌘,)" aria-label="設定">
        <Settings size={16} />
      </button>
      <UpdateButton beforeRestart={beforeRestart} />
      {layoutMenu && (
        <ContextMenu {...layoutMenu} items={[{ label: "左右に3分割", onClick: () => onLayout("cols3") }]}
          onClose={() => setLayoutMenu(null)} />
      )}
    </header>
  );
}
