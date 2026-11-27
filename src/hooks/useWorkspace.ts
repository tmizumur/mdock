import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Layout } from "react-resizable-panels";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask as askDialog } from "@tauri-apps/plugin-dialog";
import { type useUnsavedDialog } from "../components/Dialogs";
import { type DiskStamp, parseFileError, readTextResult, writeText } from "../lib/api";
import { type DragItem, type DropTarget, setDropHandler, setTabCountReader } from "../lib/dnd";
import { type PresetLayout, type Side, PRESET_COUNT, leaves, newNodeId, setSizes, splitLeaf } from "../lib/layout";
import type { SearchLocation } from "../lib/folderSearch";
import { type NavLocation, type NavState, emptyNav, goBack, goForward, recordNav } from "../lib/navHistory";
import { createOpenRequests } from "../lib/openRequests";
import { type DiffSide, type DiffTab, type DocTab, type PaneState, type Tab, activeTab, emptyPane, isDirty, isPreview, newId, pinTab, receiveDiffText, receiveDocText, settlePanePreviews, tabTitle, textFormat } from "../lib/tabs";
import { type Workspace, activeAfterRemove, allTabs, cloneTab, closeTabIn, dropIfEmpty, mapPanes, mapTabs, newPaneId, resetLayoutIn, toggleSplitIn } from "../lib/workspace";

type TreeClick = { path: string; pin: boolean; tabId?: string };

export function useWorkspace(ask: ReturnType<typeof useUnsavedDialog>["ask"], setError: (error: string | null) => void, previewTabs = true) {
  const [ws, setWs] = useState<Workspace>(() => ({ panes: { p0: emptyPane() }, layout: { type: "pane", id: "p0" } }));
  const [activeIdx, setActiveIdx] = useState("p0");
  const [openRequests] = useState(createOpenRequests);
  const previewEnabled = useRef(previewTabs);
  // 2 回目のクリックは、1 回目が開くタブ（分割先も含む）を固定する。
  const treeClick = useRef<TreeClick | null>(null);
  const lineNonce = useRef(0);
  const scrollNonce = useRef(0);
  /** タブごとのスクロール位置（タブ ID → px） */
  const scrolls = useRef(new Map<string, number>());
  const previewScrolls = useRef(new Map<string, number>());
  const forgetScroll = (id: string) => {
    scrolls.current.delete(id);
    previewScrolls.current.delete(id);
  };
  /** ペインごとの「戻る／進む」の履歴 */
  const nav = useRef(new Map<string, NavState>());
  const navigating = useRef(new Set<string>());

  // イベントハンドラから最新の状態を読むための参照
  // ペインの状態は ref を正とし、変えるときは apply で ref と state を同時に更新する
  // （非同期の処理が続けて変更しても、古い状態で上書きしないように）
  const wsRef = useRef(ws);
  const apply = useCallback((fn: (w: Workspace) => Workspace) => {
    let next = fn(wsRef.current);
    for (const [id, pane] of Object.entries(next.panes)) {
      const settled = settlePanePreviews(pane, previewEnabled.current);
      if (settled !== pane) next = { ...next, panes: { ...next.panes, [id]: settled } };
    }
    if (next === wsRef.current) return;
    wsRef.current = next;
    setWs(next);
  }, []);
  useLayoutEffect(() => {
    previewEnabled.current = previewTabs;
    if (!previewTabs) apply((w) => w);
  }, [apply, previewTabs]);
  const activeRef = useRef(activeIdx);

  const order = leaves(ws.layout);

  const updatePane = (id: string, fn: (p: PaneState) => PaneState) =>
    apply((w) => (w.panes[id] ? { ...w, panes: { ...w.panes, [id]: fn(w.panes[id]) } } : w));
  const updateActiveTab = (id: string, fn: (t: Tab) => Tab) =>
    updatePane(id, (p) => ({ ...p, tabs: p.tabs.map((t, k) => (k === p.active ? fn(t) : t)) }));

  /** ペインを前面にする */
  const focusPane = useCallback((id: string) => {
    activeRef.current = id;
    setActiveIdx(id);
  }, []);
  /** 存在するペイン（消えていれば前面のペイン、それもなければ先頭） */
  const livePane = (id: string) => {
    const w = wsRef.current;
    return w.panes[id] ? id : w.panes[activeRef.current] ? activeRef.current : leaves(w.layout)[0];
  };

  /** target のペインの side 側に新しいペインを作り、tabs を入れる。新しいペインの ID を返す */
  const splitWith = (target: string, side: Side, tabs: Tab[]) => {
    const id = newPaneId();
    apply((w) => ({
      layout: splitLeaf(w.layout, w.panes[target] ? target : leaves(w.layout)[0], side, id),
      panes: { ...w.panes, [id]: { tabs, active: 0 } },
    }));
    focusPane(id);
    return id;
  };

  /** ペインの今の位置（前面のタブのファイルとスクロール） */
  const navLocation = (paneId: string): NavLocation | undefined => {
    const p = wsRef.current.panes[paneId];
    const t = p && activeTab(p);
    if (t?.kind !== "doc") return;
    const positions = t.mode === "split" ? previewScrolls : scrolls;
    return { tabId: t.id, path: t.path, scroll: positions.current.get(t.id) ?? 0 };
  };
  /** ページ内の見出しへ移る前に、今の位置を履歴に残す */
  const recordJump = (paneId: string) => {
    const from = navLocation(paneId);
    if (from) nav.current.set(paneId, recordNav(nav.current.get(paneId) ?? emptyNav(), from));
  };
  /** 戻る（-1）／進む（1） */
  const navigate = async (paneId: string, dir: -1 | 1) => {
    const id = livePane(paneId);
    const pending = navigating.current;
    if (pending.has(id)) return;
    const current = navLocation(id);
    const state = nav.current.get(id);
    if (!current || !state) return;
    const r = (dir < 0 ? goBack : goForward)(state, current);
    if (!r) return;
    pending.add(id);
    try {
      await openFile(r.target.path, id, { restore: r });
    } finally {
      pending.delete(id);
    }
  };

  /**
   * ファイルを開く。既にそのペインで開いていればそのタブへ。
   * 仮のタブで開くときは、同じペインの仮のタブを置き換える。
   * split を指定すると、そのペインの横（上下）に新しいペインを作って開く。at はタブを入れる位置。
   */
  const openFile = useCallback(
    async (path: string, paneId: string, opts: {
      newTab?: boolean; preview?: boolean; anchor?: string; line?: Omit<SearchLocation, "nonce">; split?: Side; at?: number;
      /** 戻る／進むで復元する位置 */
      restore?: { target: NavLocation; state: NavState };
    } = {}, click?: TreeClick) => {
      const anchor = opts.anchor ? { id: opts.anchor, nonce: Date.now() } : undefined;
      const line = opts.line ? { ...opts.line, nonce: ++lineNonce.current } : undefined;
      const scrollTo = opts.restore && { top: opts.restore.target.scroll, nonce: ++scrollNonce.current };
      const withScroll = (t: DocTab): DocTab => {
        if (!scrollTo) return t;
        if (t.mode === "view") scrolls.current.set(t.id, scrollTo.top);
        if (t.mode === "split") previewScrolls.current.set(t.id, scrollTo.top);
        return { ...t, scrollTo: t.mode === "edit" ? undefined : scrollTo };
      };
      const withLocation = (p: PaneState, k: number) => {
        if (click) click.tabId = p.tabs[k].id;
        return {
          ...p, active: k,
          tabs: anchor || line || scrollTo || click?.pin
            ? p.tabs.map((t, i) => {
              if (i !== k || t.kind !== "doc") return t;
              const tab = anchor || line || scrollTo ? withScroll({ ...t, anchor, line, scrollTo: undefined }) : t;
              return click?.pin ? pinTab(tab) : tab;
            })
            : p.tabs,
        };
      };
      const has = (p: PaneState) => {
        const original = opts.restore?.target.tabId;
        const k = original ? p.tabs.findIndex((t) => t.kind === "doc" && t.id === original) : -1;
        if (k >= 0) return k;
        const current = activeTab(p);
        if (opts.restore && current?.kind === "doc" && current.path === path) return p.active;
        return p.tabs.findIndex((t) => t.kind === "doc" && t.path === path);
      };
      const read = async (): Promise<DocTab> => {
        const { info, error } = await readTextResult(path);
        const text = info?.text ?? "";
        return {
          id: newId(), kind: "doc", path, content: text, saved: text, mode: "view", anchor, line,
          ...(info ? textFormat(info) : { readError: error }),
        };
      };
      const id = livePane(paneId);
      const requestStatus = openRequests.start(id);
      const insert = opts.newTab || opts.at !== undefined;
      const preview = previewEnabled.current && opts.preview && !insert && !opts.restore;
      const asPreview = () => !!preview && previewEnabled.current;
      const withPreview = (tab: DocTab): DocTab => {
        if (click) click.tabId = tab.id;
        return asPreview() && !click?.pin ? { ...tab, preview: true } : tab;
      };
      if (opts.split) {
        const tab = await read();
        if (requestStatus() !== "latest" || !wsRef.current.panes[id]) return;
        splitWith(id, opts.split, [withPreview(tab)]);
        setError(null);
        return;
      }
      const pane = wsRef.current.panes[id];
      const history = nav.current.get(id);
      const previous = activeTab(pane)?.id;
      const k = has(pane);
      const shouldRecord = !opts.restore && opts.at === undefined;
      let from = shouldRecord ? navLocation(id) : undefined;
      if (k < 0) {
        const loaded = await read();
        const status = requestStatus();
        const latest = status === "latest";
        if (status === "cleared" || (!latest && !insert) || !wsRef.current.panes[id]) return;
        if (opts.restore && nav.current.get(id) !== history) return;
        if (shouldRecord && latest) from = navLocation(id);
        updatePane(id, (p) => {
          const k = has(p);
          if (k >= 0) return latest ? withLocation(p, k) : p;
          const tab = withPreview(withScroll(loaded));
          const cur = p.tabs[p.active];
          const replace = asPreview() ? p.tabs.findIndex(isPreview)
            : !insert && cur?.kind === "doc" && cur.id === previous && !isDirty(cur) ? p.active : -1;
          if (replace >= 0) {
            forgetScroll(p.tabs[replace].id);
            return { tabs: p.tabs.map((t, i) => (i === replace ? tab : t)), active: replace };
          }
          const at = Math.max(0, Math.min(opts.at ?? (p.tabs.length ? p.active + 1 : 0), p.tabs.length));
          // 遅れて届いた新しいタブは背面に追加する
          const active = latest || !p.tabs.length ? at : p.active + (at <= p.active ? 1 : 0);
          return { tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)], active };
        });
        if (!latest) return;
      } else {
        updatePane(id, (p) => withLocation(p, k));
      }
      if (opts.restore) {
        nav.current.set(id, opts.restore.state);
      } else if (from && (from.tabId !== activeTab(wsRef.current.panes[id])?.id || anchor || line)) {
        nav.current.set(id, recordNav(nav.current.get(id) ?? emptyNav(), from));
      }
      focusPane(id);
      setError(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusPane, openRequests],
  );

  const retryRead = async (tabId: string, force: boolean, side?: DiffSide) => {
    const tab = allTabs(wsRef.current).find((t) => t.id === tabId);
    if (tab?.kind === "doc" && tab.readError) {
      const allowed = force || tab.force;
      const result = await readTextResult(tab.path, allowed);
      apply((w) => mapTabs(w, (t) => {
        if (t.kind !== "doc" || t.id !== tabId || t.path !== tab.path || !t.readError) return t;
        return result.info ? receiveDocText(t, result.info, allowed) : { ...t, readError: result.error };
      }));
    } else if (tab?.kind === "diff" && side && tab.reads?.[side]?.error) {
      const allowed = force || tab.reads[side].force;
      const result = await readTextResult(tab[side], allowed);
      apply((w) => mapTabs(w, (t) => {
        if (t.kind !== "diff" || t.id !== tabId || t[side] !== tab[side] || !t.reads?.[side]?.error) return t;
        return receiveDiffText(t, side, result, result.info ? allowed : t.reads[side].force);
      }));
    }
  };

  /** 未保存のタブがあれば確認する。true なら続けてよい */
  const confirmDirty = useCallback(
    async (tabs: Tab[]): Promise<boolean> => {
      const dirty = tabs.filter(isDirty);
      if (!dirty.length) return true;
      const c = await ask(
        dirty.length === 1 ? `「${tabTitle(dirty[0])}」の変更を保存しますか？` : `${dirty.length} 個のファイルに未保存の変更があります。保存しますか？`,
        "保存しないと、変更は失われます。",
      );
      if (c === "cancel") return false;
      if (c === "save") {
        for (const t of dirty) if (!(await saveTab(t.id))) return false;
      }
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask],
  );

  /** すべてのタブを閉じる（分割の形はそのまま） */
  const clearTabs = useCallback(() => {
    openRequests.clear();
    treeClick.current = null;
    nav.current.clear();
    navigating.current = new Set();
    apply((w) => mapPanes(w, () => emptyPane()));
    scrolls.current.clear();
    previewScrolls.current.clear();
  }, [apply, openRequests]);


  const saving = useRef(new Set<string>());
  /** タブを保存する。同じファイルを開いているほかのタブ（未編集のもの）にも反映する */
  const saveTab = useCallback(async (tabId: string): Promise<boolean> => {
    const t = allTabs(wsRef.current).find((x) => x.id === tabId);
    if (!t || t.kind !== "doc") return true;
    if (!isDirty(t)) return true;
    if (t.readError) {
      setError("保存できませんでした。最初にファイルを読み込んでください。");
      return false;
    }
    if (saving.current.has(t.path)) return false;
    saving.current.add(t.path);
    // 確認中にファイルの状態が変わったら、次の保存で確認し直す。
    const currentForSave = () => {
      const current = allTabs(wsRef.current).find((x) => x.id === tabId);
      if (current?.kind !== "doc" || current.path !== t.path || current.readError ||
          current.saved !== t.saved || current.encoding !== t.encoding || current.bom !== t.bom ||
          current.savedBom !== t.savedBom || current.diskStamp !== t.diskStamp ||
          current.lossy !== t.lossy || current.external !== t.external ||
          current.externalReadError !== t.externalReadError || current.deleted !== t.deleted) return undefined;
      return current;
    };
    const confirmOverwrite = () => askDialog("外部で変更されたファイルを上書きしますか？", {
      title: "外部で変更されました", okLabel: "上書き", cancelLabel: "キャンセル",
    });
    let expected = t.externalReadError ? undefined : t.external?.diskStamp ?? t.diskStamp;
    let text: string;
    let diskStamp: DiskStamp;
    let format = { encoding: t.encoding, bom: t.bom };
    try {
      if ((t.external || t.externalReadError) && !await confirmOverwrite()) return false;
      if ((t.lossy || t.external?.lossy) && !await askDialog("このファイルには読み取れなかったバイトがあり、保存すると元のバイトは失われます。保存しますか？", {
        title: "読み取れなかったバイト", okLabel: "保存", cancelLabel: "キャンセル",
      })) return false;
      for (;;) {
        const current = currentForSave();
        if (!current) return false;
        text = current.content;
        try {
          diskStamp = await writeText(t.path, text, format, expected);
          break;
        } catch (error) {
          const { code } = parseFileError(error);
          if (code === "changed_on_disk" && expected) {
            if (!await confirmOverwrite()) return false;
            expected = undefined;
          } else if (code === "unrepresentable" && format.encoding) {
            if (!await askDialog(`この文字は ${format.encoding} で保存できません。UTF-8 で保存しますか？`, {
              title: "文字コードを変更", okLabel: "UTF-8 で保存", cancelLabel: "キャンセル",
            })) return false;
            format = { encoding: undefined, bom: t.bom };
          } else {
            throw error;
          }
        }
      }
    } catch (e) {
      setError(`保存できませんでした。 ${parseFileError(e).message}`);
      return false;
    } finally {
      saving.current.delete(t.path);
    }
    const clear = { ...format, diskStamp, savedBom: undefined, lossy: undefined, external: undefined, externalReadError: undefined, deleted: false, readError: undefined };
    const result = { info: { text, encoding: format.encoding ?? "UTF-8", bom: format.bom ?? false, lossy: false, diskStamp } };
    apply((w) =>
      mapTabs(w, (x): Tab => {
        if (x.kind === "doc" && x.path === t.path) {
          if (x.id === tabId) return { ...x, saved: text, ...clear };
          const keepBom = x.savedBom !== undefined && !!x.bom !== !!format.bom;
          const content = x.content === x.saved ? text : x.content;
          return { ...x, content, saved: text, ...clear, ...(keepBom ? { bom: x.bom, savedBom: !!format.bom } : {}) };
        }
        if (x.kind === "diff" && (x.left === t.path || x.right === t.path)) {
          const next = x.left === t.path ? receiveDiffText(x, "left", result, x.reads?.left?.force) : x;
          return x.right === t.path ? receiveDiffText(next, "right", result, x.reads?.right?.force) : next;
        }
        return x;
      }),
    );
    return !isDirty(allTabs(wsRef.current).find((x) => x.id === tabId));
  }, [apply, setError]);

  /** ペインを消して（タブがなければ）、隣のペインを前面にする */
  const commitRemoveIfEmpty = (w: Workspace, id: string): Workspace => {
    const r = dropIfEmpty(w, id);
    if (r.neighbor && activeRef.current === id) focusPane(r.neighbor);
    return r.w;
  };

  const closeTab = async (paneId: string, tabIdx: number) => {
    const t = wsRef.current.panes[paneId]?.tabs[tabIdx];
    if (!t) return;
    if (!(await confirmDirty([t]))) return;
    forgetScroll(t.id);
    apply((w) => {
      const r = closeTabIn(w, paneId, t.id, activeRef.current);
      if (!r.w.panes[paneId]?.tabs.length) nav.current.delete(paneId);
      if (r.focus) focusPane(r.focus);
      return r.w;
    });
  };

  /** ⌘W: 今のタブを閉じる。ペインが空なら（ほかにペインがあれば）ペインを閉じ、何もなければウィンドウを閉じる */
  const closeActiveTab = () => {
    const w = wsRef.current;
    const id = livePane(activeRef.current);
    const p = w.panes[id];
    if (p?.tabs.length) closeTab(id, p.active);
    else if (leaves(w.layout).length > 1) apply((x) => commitRemoveIfEmpty(x, id));
    else getCurrentWindow().close();
  };

  const closeOthers = async (paneId: string, keepIdx: number) => {
    const p = wsRef.current.panes[paneId];
    if (!p) return;
    const others = p.tabs.filter((_, i) => i !== keepIdx);
    if (!(await confirmDirty(others))) return;
    const keep = p.tabs[keepIdx];
    others.forEach((t) => forgetScroll(t.id));
    updatePane(paneId, (q) => ({ tabs: q.tabs.filter((t) => t.id === keep.id), active: 0 }));
  };

  const pin = (tabId: string) => apply((w) => mapTabs(w, (t) => t.id === tabId ? pinTab(t) : t));

  /**
   * タブを移動する（同じペイン内の並べ替え、ほかのペインへ、または新しいペインに分割して）。
   * 元のペインが空になったら、そのペインは消える。
   */
  const moveTab = (fromPane: string, tabId: string, to: { paneId: string; index?: number; split?: Side }) => {
    let dest = to.paneId;
    apply((w) => {
      const src = w.panes[fromPane];
      const k = src?.tabs.findIndex((t) => t.id === tabId) ?? -1;
      if (k < 0 || (!to.split && !w.panes[to.paneId])) return w;
      const tab = pinTab(src.tabs[k]);
      // 同じペインで、タブが 1 つしかないなら分割しない
      if (to.split && fromPane === to.paneId && src.tabs.length <= 1) return w;
      let layout = w.layout;
      const panes = { ...w.panes };
      const rest = src.tabs.filter((t) => t.id !== tabId);
      panes[fromPane] = { tabs: rest, active: activeAfterRemove(src.active, k, rest.length) };
      if (to.split) {
        dest = newPaneId();
        layout = splitLeaf(layout, to.paneId, to.split, dest);
        panes[dest] = { tabs: [tab], active: 0 };
      } else {
        const d = panes[dest];
        let at = to.index ?? d.tabs.length;
        if (fromPane === dest && k < at) at--;
        at = Math.max(0, Math.min(at, d.tabs.length));
        const tabs = [...d.tabs];
        tabs.splice(at, 0, tab);
        panes[dest] = { tabs, active: at };
      }
      let next: Workspace = { layout, panes };
      if (fromPane !== dest) next = dropIfEmpty(next, fromPane).w;
      return next;
    });
    if (wsRef.current.panes[dest]) focusPane(dest);
  };

  /** タブを複製して、そのペインの side 側の新しいペインに開く（⌘\ ・「右に分割」） */
  const splitTab = (paneId: string, side: Side) => {
    const t = activeTab(wsRef.current.panes[paneId] ?? emptyPane());
    const copy = t ? pinTab(cloneTab(t)) : null;
    if (copy && t) scrolls.current.set(copy.id, scrolls.current.get(t.id) ?? 0);
    splitWith(paneId, side, copy ? [copy] : []);
  };

  const cycleTab = (delta: number) =>
    updatePane(activeRef.current, (p) => (p.tabs.length ? { ...p, active: (p.active + delta + p.tabs.length) % p.tabs.length } : p));

  /** 「隣のペイン」: 画面上の順で次のペイン（最後なら先頭）。1 ペインなら null */
  const otherPane = (id: string): string | null => {
    const o = leaves(wsRef.current.layout);
    if (o.length < 2) return null;
    return o[(o.indexOf(id) + 1) % o.length];
  };

  /** このタブと、隣のペインで開いているファイルの差分を新しいタブで開く */
  const compareWithOther = (paneId: string, tabIdx: number) => {
    const op = otherPane(paneId);
    const a = wsRef.current.panes[paneId]?.tabs[tabIdx];
    const b = op ? activeTab(wsRef.current.panes[op]) : undefined;
    if (a?.kind !== "doc" || a.readError || b?.kind !== "doc" || b.readError) return;
    const tab: DiffTab = {
      id: newId(), kind: "diff", left: a.path, right: b.path, leftText: a.content, rightText: b.content,
      reads: { left: { force: a.force }, right: { force: b.force } },
    };
    updatePane(paneId, (p) => ({ tabs: [...p.tabs.slice(0, tabIdx + 1), tab, ...p.tabs.slice(tabIdx + 1)], active: tabIdx + 1 }));
    focusPane(paneId);
  };

  const newPresetIds = (w: Workspace, count: number) => ({
    panes: Array.from({ length: Math.max(0, count - leaves(w.layout).length) }, newPaneId),
    split: newNodeId("s"),
  });

  const applyLayoutChange = ({ w, focus, discardedTabIds }: ReturnType<typeof resetLayoutIn>) => {
    for (const id of discardedTabIds ?? []) forgetScroll(id);
    apply(() => w);
    if (focus) focusPane(focus);
  };

  /** レイアウトのリセット（1画面 / 左右 / 上下 / 3分割） */
  const resetLayout = (kind: PresetLayout) => {
    const w = wsRef.current;
    const split = kind === "single" ? undefined : { kind, ids: newPresetIds(w, PRESET_COUNT[kind]) };
    applyLayoutChange(resetLayoutIn(w, activeRef.current, split));
  };

  const toggleSplit = (dir: "row" | "col") => {
    const w = wsRef.current;
    const ids = w.layout.type === "pane" ? newPresetIds(w, 2) : undefined;
    applyLayoutChange(toggleSplitIn(w, activeRef.current, dir, ids));
  };

  /** ツリーで名前を変えたら、そのファイル（フォルダならその中）を開いているタブのパスも直す */
  const onRenamed = (from: string, to: string) => {
    const move = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    apply((w) =>
      mapPanes(w, (p) => ({
        ...p,
        tabs: p.tabs.map((t): Tab => (t.kind === "doc" ? { ...t, path: move(t.path) } : { ...t, left: move(t.left), right: move(t.right) })),
      })),
    );
  };

  /** ツリーのクリック: ⌘ は隣のペイン（1 ペインなら右に分割）、⌥ は固定した新しいタブ */
  const onTreeOpen = (path: string, otherPaneClick: boolean, newTab: boolean, line?: Omit<SearchLocation, "nonce">, action?: "pin" | "create") => {
    if (action === "pin") {
      const click = treeClick.current;
      if (click?.path === path) {
        click.pin = true;
        if (click.tabId) pin(click.tabId);
      }
      return;
    }
    const click = { path, pin: false };
    treeClick.current = click;
    const cur = livePane(activeRef.current);
    const dest = otherPaneClick ? otherPane(cur) : cur;
    return openFile(path, dest ?? cur, {
      newTab: newTab || (action === "create" && previewEnabled.current),
      preview: action !== "create", line, split: dest === null ? "right" : undefined,
    }, click);
  };

  /** 分割の境界をドラッグして比率が変わったら、ツリーに書き戻す */
  const onSplitResized = (splitId: string, ids: string[]) => (l: Layout) => {
    const sizes = ids.map((id) => l[id]);
    if (sizes.some((x) => !(x >= 0))) return;
    apply((w) => {
      const next = setSizes(w.layout, splitId, sizes);
      const same = JSON.stringify(next) === JSON.stringify(w.layout);
      return same ? w : { ...w, layout: next };
    });
  };

  return {
    ws, wsRef, apply, activeIdx, activeRef, order, scrolls, previewScrolls, focusPane, livePane,
    updatePane, updateActiveTab, openFile, retryRead, confirmDirty, clearTabs, saveTab,
    closeTab, closeActiveTab, closeOthers, pin, moveTab, splitTab, splitWith, cycleTab, navigate, recordJump,
    otherPane, compareWithOther, resetLayout, toggleSplit, onRenamed, onTreeOpen, onSplitResized,
  };
}

export function useWorkspaceDrop(
  { wsRef, moveTab, openFile }: Pick<ReturnType<typeof useWorkspace>, "wsRef" | "moveTab" | "openFile">,
) {
  // ドラッグ＆ドロップ（タブ・ツリーのファイル）をペインに落としたとき
  const onDrop = (item: DragItem, target: DropTarget) => {
    const split = target.type === "pane" && target.zone !== "center" ? target.zone : undefined;
    if (item.kind === "tab") {
      if (target.type === "tabbar") moveTab(item.paneId, item.tabId, { paneId: target.paneId, index: target.index });
      else moveTab(item.paneId, item.tabId, { paneId: target.paneId, split });
    } else {
      if (target.type === "tabbar") openFile(item.path, target.paneId, { at: target.index });
      else openFile(item.path, target.paneId, split ? { split } : { newTab: true });
    }
  };
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    setDropHandler((item, target) => onDropRef.current(item, target));
    setTabCountReader((id) => wsRef.current.panes[id]?.tabs.length ?? 0);
  }, [wsRef]);
}
