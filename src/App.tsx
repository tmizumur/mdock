import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import FileTree, { ExplorerControls } from "./components/FileTree";
import FolderSearch from "./components/FolderSearch";
import Pane, { type PaneOutline } from "./components/Pane";
import Outline from "./components/Outline";
import StatusBar from "./components/StatusBar";
import WindowBar from "./components/WindowBar";
import SettingsDialog from "./components/SettingsDialog";
import { useGitStatus } from "./lib/git";
import { ContextMenu, useUnsavedDialog } from "./components/Dialogs";
import { useSettings } from "./lib/settings";
import { useFolder } from "./hooks/useFolder";
import { useLiveReload } from "./hooks/useLiveReload";
import { useMenuActions } from "./hooks/useMenuActions";
import { usePaneActions } from "./hooks/usePaneActions";
import { usePersist, useRestoreSession } from "./hooks/useSession";
import { useShortcuts } from "./hooks/useShortcuts";
import { useFileOpen, useWindowTitle } from "./hooks/useWindowEvents";
import { useWorkspace, useWorkspaceDrop } from "./hooks/useWorkspace";
import { useDragPos, useDrag } from "./lib/dnd";
import { type LayoutNode } from "./lib/layout";
import { type ViewMode, activeTab, emptyPane, textFormat } from "./lib/tabs";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const [outline, setOutline] = useState<PaneOutline>();
  const { ask, dialog } = useUnsavedDialog();
  const sidebarPanel = useRef<PanelImperativeHandle>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  const workspace = useWorkspace(ask, setError, settings.previewTabs);
  const {
    ws, wsRef, activeIdx, activeRef, order, scrolls, previewScrolls, focusPane, updatePane, updateActiveTab,
    openFile, retryRead, saveTab, closeTab, resetLayout, toggleSplit, onRenamed, onTreeOpen, onSplitResized,
  } = workspace;
  const folder = useFolder(workspace, setError);
  const { root, tree, watchedRoot, pickFolder, openFolder, loadDirectory } = folder;

  // リスナーはこの順に登録する
  const git = useGitStatus(root, settings.gitStatus, settings.statusBar);
  useWorkspaceDrop(workspace);
  const session = useRestoreSession(folder, workspace);
  const { ready, sidebarLayout } = session;
  const { schedulePersist, flush } = usePersist(session, folder, workspace, ask);
  useWindowTitle(root);
  const { watchKey, watchedFiles, refreshTree } = useLiveReload(ready, folder, workspace);
  const pickFiles = useFileOpen(ready, folder, workspace, setError);

  const paneActions = usePaneActions(workspace);
  const { commands, menu, setMenu, openTabMenu, printPane } = paneActions;
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const toggleSearch = () => setSearchOpen((open) => !open);
  const actions = useMenuActions(workspace, pickFiles, pickFolder, printPane, setSettingsOpen, toggleSearch);
  useShortcuts(workspace, paneActions, actions, updateSettings, setSettingsOpen, setError);

  useEffect(() => {
    if (!searchOpen) return;
    sidebarPanel.current?.expand();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && !document.querySelector("dialog[open]")) closeSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, ready, closeSearch]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const renderPane = (i: string) => (
    <Pane
      key={i}
      idx={i}
      pane={ws.panes[i] ?? emptyPane()}
      active={activeIdx === i}
      onOutline={setOutline}
      rootDir={root}
      command={commands[i]}
      scrollOf={(id) => scrolls.current.get(id) ?? 0}
      onScroll={(id, top) => {
        scrolls.current.set(id, top);
        schedulePersist();
      }}
      onPreviewScroll={(id, top) => previewScrolls.current.set(id, top)}
      onFocus={() => activeRef.current !== i && focusPane(i)}
      onActivateTab={(k) => updatePane(i, (p) => ({ ...p, active: k }))}
      onCloseTab={(k) => closeTab(i, k)}
      onPinTab={workspace.pin}
      onTabMenu={(k, x, y) => openTabMenu(i, k, x, y)}
      onChange={(content) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, content } : t))}
      onMode={(mode: ViewMode) => updateActiveTab(i, (t) => (t.kind === "doc" ? { ...t, mode } : t))}
      onRetryRead={retryRead}
      onSave={() => {
        const p = wsRef.current.panes[i];
        const t = p && activeTab(p);
        if (t) saveTab(t.id);
      }}
      onReloadExternal={() =>
        updateActiveTab(i, (t) =>
          t.kind === "doc" && t.external ? { ...t, ...textFormat(t.external), content: t.external.text, saved: t.external.text, savedBom: undefined, external: undefined } : t,
        )
      }
      onKeepMine={() => updateActiveTab(i, (t) => {
        if (t.kind !== "doc" || !t.external) return t;
        const format = textFormat(t.external);
        return {
          ...t, ...format, saved: t.external.text, external: undefined,
          ...(t.savedBom !== undefined ? { bom: t.bom, savedBom: t.external.bom === !!t.bom ? undefined : t.external.bom } : {}),
        };
      })}
      onOpenLink={(p, anchor, newTab) => openFile(p, i, { anchor, newTab, preview: true })}
      onPrint={() => printPane(i)}
      printTarget={activeIdx === i}
    />
  );

  const currentTab = ws.panes[activeIdx] ? activeTab(ws.panes[activeIdx]) : undefined;
  const activeOutline = currentTab?.kind === "doc" && !currentTab.readError && outline?.paneId === activeIdx &&
    outline.tabId === currentTab.id && outline.mode === currentTab.mode ? outline.outline : undefined;

  const visiblePaths = order
    .map((id) => ws.panes[id] && activeTab(ws.panes[id]))
    .flatMap((t) => (t?.kind === "doc" ? [t.path] : []));

  /** 分割ツリーを、入れ子の react-resizable-panels で描く */
  const renderNode = (n: LayoutNode): ReactNode => {
    if (n.type === "pane") return renderPane(n.id);
    const ids = n.children.map((c) => c.id);
    const horiz = n.dir === "row";
    return (
      <Group
        key={`${n.id}:${ids.join(",")}`}
        orientation={horiz ? "horizontal" : "vertical"}
        className="split-group"
        defaultLayout={Object.fromEntries(ids.map((id, i) => [id, n.sizes[i]]))}
        onLayoutChanged={onSplitResized(n.id, ids)}
      >
        {n.children.map((c, i) => [
          i > 0 && <Separator key={`sep-${c.id}`} className={horiz ? "sep" : "sep sep-h"} />,
          <Panel key={c.id} id={c.id} minSize={horiz ? 160 : 100}>
            {renderNode(c)}
          </Panel>,
        ])}
      </Group>
    );
  };

  return (
    <div className="app" style={{ "--doc-font-size": `${settings.fontSize}px` } as React.CSSProperties}>
      <WindowBar
        root={root}
        branch={git.branch}
        error={error}
        layout={ws.layout}
        sidebarOpen={sidebarOpen}
        ready={ready}
        onToggleSidebar={() => {
          const panel = sidebarPanel.current;
          if (panel?.isCollapsed()) panel.expand();
          else panel?.collapse();
        }}
        onPickFolder={pickFolder}
        onOpenFolder={(dir) => openFolder(dir, true)}
        onLayout={resetLayout}
        onToggleSplit={toggleSplit}
        onSettings={() => setSettingsOpen(true)}
        beforeRestart={flush}
      />

      {ready && (
        <Group
          orientation="horizontal"
          className="main"
          defaultLayout={sidebarLayout.current}
          onLayoutChanged={(l) => {
            sidebarLayout.current = l;
            schedulePersist();
          }}
        >
          <Panel id="sidebar" defaultSize={264} minSize={248} maxSize={280} groupResizeBehavior="preserve-pixel-size" collapsible panelRef={sidebarPanel}
            onResize={(size) => setSidebarOpen(size.asPercentage > 0)}>
            <aside className="sidebar">
              <div className="sidebar-explorer" inert={searchOpen}>
                {root ? (
                  <FileTree
                    key={root}
                    root={root}
                    entries={tree}
                    openPaths={visiblePaths}
                  activePath={currentTab?.kind === "doc" ? currentTab.path : undefined}
                    onOpen={(path, otherPane, newTab, action) => onTreeOpen(path, otherPane, newTab, undefined, action)}
                    onLoadDirectory={loadDirectory}
                    onChanged={refreshTree}
                    onRenamed={onRenamed}
                    onError={setError}
                    git={git.lookup}
                  />
                ) : (
                  <>
                    <ExplorerControls />
                    <div className="tree-empty">
                      <button className="btn" onClick={pickFolder}>フォルダを開く</button>
                      <small>ここにフォルダをドロップしても開けます</small>
                    </div>
                  </>
                )}
                <Outline outline={activeOutline} tabKey={currentTab?.id} />
              </div>
              {searchOpen && (
                <FolderSearch key={root ?? ""} root={root} onClose={closeSearch}
                  onOpen={(path, line, otherPane) => onTreeOpen(path, otherPane, false, line)}
                />
              )}
            </aside>
          </Panel>
          <Separator className="sep" />
          <Panel id="panes" minSize={240}>
            {renderNode(ws.layout)}
          </Panel>
        </Group>
      )}
      {settings.statusBar && (
        <StatusBar
          live={root ? watchedRoot === root : !!watchKey && watchedFiles === watchKey}
          branch={git.branch}
          modified={git.modified}
          added={git.added}
          tab={currentTab}
          fontSize={settings.fontSize}
        />
      )}
      <DragGhost />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog}
      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
    </div>
  );
}

/** ドラッグ中、ポインタの横に出す札（何を動かしているか） */
function DragGhost() {
  const { item } = useDrag();
  const pos = useDragPos();
  if (!item) return null;
  return (
    <div className="drag-ghost" style={{ left: pos.x + 14, top: pos.y + 12 }}>
      {item.title}
    </div>
  );
}
