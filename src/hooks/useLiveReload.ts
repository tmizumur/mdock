import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Entry, type TextInfo, norm, readDirs, readTextResult, readTree, statPaths, watchFiles } from "../lib/api";
import { type FsChange, FILES_CHANGED, changeMatcher, dirsToReread, indexTree, irrelevantForTree, isMoveMatch, matchedAncestor, pathKey, sameEntries, spliceTree } from "../lib/liveReload";
import { type DocTab, type Tab, isDirty, receiveDiffText, receiveDocText } from "../lib/tabs";
import { allTabs, filesOf, mapTabs } from "../lib/workspace";
import { type useFolder } from "./useFolder";
import { type useWorkspace } from "./useWorkspace";

export function useLiveReload(
  ready: boolean,
  { root, rootRef, treeRef, setTree, folderLoadRef }: Pick<ReturnType<typeof useFolder>, "root" | "rootRef" | "treeRef" | "setTree" | "folderLoadRef">,
  { ws, wsRef, apply }: Pick<ReturnType<typeof useWorkspace>, "ws" | "wsRef" | "apply">,
) {
  const [watchedFiles, setWatchedFiles] = useState("");

  /** パスごとの読み込みの世代（後から始めた読み込みの結果を優先し、古い結果で上書きしない） */
  const readGen = useRef(new Map<string, number>());

  /**
   * 開いているタブを読み直す（裏のタブ・ほかのペインも）。
   * 未保存の変更が無ければそのまま差し替え、あれば上書きせずに「外部で変更されました」を出す。
   * 削除されたら「削除されました」を出し、同名で作り直されたら戻す。名前の変更・移動も、同じ内容のファイルがあれば追う。
   */
  const reloadTabs = useCallback(
    async (change: FsChange) => {
      const match = changeMatcher(change);
      const targets = filesOf(wsRef.current).filter(match);
      if (!targets.length) return;
      const previousTree = treeRef.current;
      const previousRoot = rootRef.current;
      const gens = targets.map((p) => {
        const g = (readGen.current.get(p) ?? 0) + 1;
        readGen.current.set(p, g);
        return g;
      });
      const tabs = allTabs(wsRef.current);
      const before = new Map(tabs.map((t) => [t.id, t]));
      const forced = new Set<string>();
      for (const tab of tabs) {
        if (tab.kind === "doc" && tab.force) forced.add(tab.path);
        if (tab.kind === "diff") {
          if (tab.reads?.left?.force) forced.add(tab.left);
          if (tab.reads?.right?.force) forced.add(tab.right);
        }
      }
      const results = await Promise.all(targets.map((p) => readTextResult(p, forced.has(p))));
      const indexes = new Map(targets.map((p, i) => [p, i]));
      const resultFor = (path: string) => {
        const i = indexes.get(path);
        return i !== undefined && readGen.current.get(path) === gens[i] ? results[i] : undefined;
      };
      const gone = targets.filter((p) => resultFor(p)?.error?.code === "not_found");

      // 同じ変更で新しく現れたパスだけを移動先の候補にする
      const moved = new Map<string, { path: string; info: TextInfo }>();
      if (gone.length && !change.rescan) {
        const previous = indexTree(previousTree);
        const open = new Set(filesOf(wsRef.current).map(pathKey));
        if (previousRoot) open.add(pathKey(previousRoot));
        const cands = change.paths.filter((c) => {
          const key = pathKey(c);
          return !open.has(key) && !previous.has(key);
        }).slice(0, 20);
        const ancestors = new Map(gone.map((g) => [g, matchedAncestor(change.paths, g)]));
        const folders = [...new Set([...ancestors].flatMap(([g, anc]) =>
          anc && pathKey(anc) !== pathKey(g) ? [anc] : [],
        ))];
        const stats = cands.length && folders.length ? await statPaths(folders).catch(() => []) : [];
        const goneFolders = new Set(folders.filter((_, i) => stats[i]?.exists === false));
        for (const g of gone) {
          const tab = tabs.find((t): t is DocTab => t.kind === "doc" && t.path === g && !t.readError);
          const anc = ancestors.get(g);
          if (!tab?.saved.trim() || !anc || (pathKey(anc) !== pathKey(g) && !goneFolders.has(anc))) continue;
          const rest = norm(g).slice(norm(anc).length); // フォルダごと動いたときの、その中での位置
          for (const c of cands) {
            if (pathKey(c) === pathKey(anc)) continue;
            const to = norm(c) + rest;
            if ([...moved.values()].some((entry) => entry.path === to)) continue;
            const { info } = await readTextResult(to, tab.force);
            if (info && isMoveMatch(previous, to, tab.saved, info.text)) {
              moved.set(g, { path: to, info });
              break;
            }
          }
        }
      }
      apply((w) =>
        mapTabs(w, (t): Tab => {
          // 読み込み中に保存や手動の再読み込みが完了したタブは上書きしない。
          const prior = before.get(t.id);
          if (!prior) return t;
          if (t.kind === "diff") {
            if (prior.kind !== "diff") return t;
            let next = t;
            for (const side of ["left", "right"] as const) {
              const path = t[side];
              const key = side === "left" ? "leftText" : "rightText";
              const result = resultFor(path);
              const previous = t.reads?.[side];
              const force = forced.has(path) || undefined;
              if (!result || prior[side] !== path || prior[key] !== t[key] || prior.reads?.[side] !== previous) continue;
              if (result.info || previous?.error || result.error.code === "large_file" || result.error.code === "too_large") {
                next = receiveDiffText(next, side, result, result.info ? force : previous?.force);
              }
            }
            return next;
          }
          if (prior.kind !== "doc" || prior.path !== t.path || prior.saved !== t.saved ||
              prior.readError !== t.readError || prior.external !== t.external ||
              prior.externalReadError !== t.externalReadError || prior.encoding !== t.encoding ||
              prior.bom !== t.bom || prior.savedBom !== t.savedBom || prior.diskStamp !== t.diskStamp ||
              prior.lossy !== t.lossy) return t;
          const result = resultFor(t.path);
          const force = forced.has(t.path) || undefined;
          if (!result) return t;
          if (result.info) return receiveDocText(t, result.info, force);
          const to = moved.get(t.path);
          if (to && !t.readError) return { ...receiveDocText(t, to.info, force), path: to.path };
          if (result.error.code === "not_found" && !t.readError) {
            return t.deleted ? t : { ...t, deleted: true, external: undefined };
          }
          if (isDirty(t) && !t.readError) {
            return { ...t, deleted: false, external: undefined, externalReadError: result.error };
          }
          return { ...t, deleted: false, external: undefined, externalReadError: undefined, readError: result.error };
        }),
      );
    },
    [apply, rootRef, treeRef, wsRef],
  );

  /** ツリーの部分更新の順番待ち（読み直している間に届いた変更は、終わってからまとめて読む） */
  const treeQueue = useRef<{ load: typeof folderLoadRef.current; paths: Set<string>; all: boolean; running: boolean } | null>(null);
  /** ツリーを読み直す。変更のあったフォルダだけ読み、全体は必要なときだけ。展開状態・選択・スクロール位置は保たれる */
  const refreshTreeFor = useCallback(
    async (change: FsChange) => {
      const load = folderLoadRef.current;
      const root = rootRef.current;
      if (!root || !load) return;
      let q = treeQueue.current;
      if (q?.load !== load) {
        q = { load, paths: new Set<string>(), all: false, running: false };
        treeQueue.current = q;
      }
      if (change.rescan) q.all = true;
      else for (const p of change.paths) if (!irrelevantForTree(root, p)) q.paths.add(p);
      if (q.running || (!q.all && !q.paths.size)) return;
      q.running = true;
      try {
        // 全体を反映してから、その読み込み中に届いた変更を処理する
        if (load.pending) await load.pending;
        while (folderLoadRef.current === load && (q.all || q.paths.size)) {
          const all = q.all;
          const paths = [...q.paths];
          q.all = false;
          q.paths.clear();
          let plan: string[] | "all" = "all";
          if (!all) {
            const st = await statPaths(paths).catch(() => null);
            if (st) plan = dirsToReread(root, indexTree(treeRef.current), paths, new Map(paths.map((p, i) => [pathKey(p), st[i]])));
          }
          if (folderLoadRef.current !== load) break;
          if (plan === "all") {
            const next = await readTree(root).catch(() => [] as Entry[]); // フォルダが消えたら空にする（戻れば読み直す）
            if (folderLoadRef.current !== load) break;
            if (!sameEntries(treeRef.current, next)) setTree(next);
          } else if (plan.length) {
            const res = await readDirs(plan, root).catch(() => null);
            if (folderLoadRef.current !== load) break;
            if (!res) {
              q.all = true;
              continue;
            }
            let t = treeRef.current;
            plan.forEach((d, i) => {
              const kids = res[i];
              const n = kids ? spliceTree(t, d, kids) : null;
              if (n) t = n;
              else q.all = true; // 見つからない・消えていた → 全体を読み直す
            });
            if (t !== treeRef.current) setTree(t);
          }
        }
      } finally {
        q.running = false;
      }
    },
    [folderLoadRef, rootRef, setTree, treeRef],
  );

  // 監視からの知らせ（変更から 100ms ほどで届く）
  useEffect(() => {
    const un = listen<FsChange>("fs-change", (ev) => {
      const change = { paths: ev.payload.paths ?? [], rescan: !!ev.payload.rescan };
      window.dispatchEvent(new CustomEvent(FILES_CHANGED, { detail: change }));
      reloadTabs(change);
      refreshTreeFor(change);
    });
    return () => {
      un.then((f) => f());
    };
  }, [reloadTabs, refreshTreeFor]);

  // 開いているファイルを監視側に伝える（開いたフォルダの外のファイルも監視するため）
  const watchKey = filesOf(ws).sort().join("\n");
  useEffect(() => {
    if (!ready) return;
    let current = true;
    watchFiles(watchKey ? watchKey.split("\n") : []).then(
      () => { if (current) setWatchedFiles(watchKey); },
      () => { if (current) setWatchedFiles(""); },
    );
    return () => { current = false; };
  }, [watchKey, ready, root]);

  // 取りこぼし対策: ウィンドウに戻ってきたら、開いているファイル（更新時刻とサイズ）とツリーを確かめ直す
  const known = useRef(new Map<string, string>());
  const lastTreeCheck = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const recheck = async (checkTree = true) => {
      const load = folderLoadRef.current;
      const checkCurrentTree = checkTree && load && !load.pending;
      const paths = filesOf(wsRef.current);
      if (paths.length) {
        const st = await statPaths(paths).catch(() => null);
        if (st) {
          const changed = paths.filter((p, i) => {
            const sig = st[i]?.exists ? `${st[i].mtime}:${st[i].size}` : "gone";
            const k = pathKey(p);
            const old = known.current.get(k);
            known.current.set(k, sig);
            return old !== sig;
          });
          if (changed.length) reloadTabs({ paths: changed, rescan: false });
        }
      }
      const now = Date.now();
      if (checkCurrentTree && folderLoadRef.current === load && now - lastTreeCheck.current > 2000) {
        lastTreeCheck.current = now;
        refreshTreeFor({ paths: [], rescan: true });
      }
    };
    recheck(false); // 起動時のツリーはセッションの復元で読み込む
    const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && recheck());
    const onVis = () => document.visibilityState === "visible" && recheck();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      un.then((f) => f());
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, folderLoadRef, reloadTabs, refreshTreeFor, wsRef]);

  const refreshTree = () => refreshTreeFor({ paths: [], rescan: true });
  return { watchKey, watchedFiles, refreshTree };
}
