import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Entry, norm, readDirs, readText, readTree, statPaths, watchFiles } from "../lib/api";
import { type FsChange, changeMatcher, dirsToReread, indexTree, irrelevantForTree, matchedAncestor, pathKey, sameEntries, spliceTree } from "../lib/liveReload";
import { type DocTab, type Tab } from "../lib/tabs";
import { allTabs, filesOf, mapTabs } from "../lib/workspace";
import { type useFolder } from "./useFolder";
import { type useWorkspace } from "./useWorkspace";

export function useLiveReload(
  ready: boolean,
  { root, rootRef, treeRef, setTree }: Pick<ReturnType<typeof useFolder>, "root" | "rootRef" | "treeRef" | "setTree">,
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
      const gens = targets.map((p) => {
        const g = (readGen.current.get(p) ?? 0) + 1;
        readGen.current.set(p, g);
        return g;
      });
      const results = await Promise.all(targets.map((p) => readText(p).catch(() => null)));
      const fresh = new Map<string, string>();
      const missing: string[] = [];
      targets.forEach((p, i) => {
        if (readGen.current.get(p) !== gens[i]) return; // もっと新しい読み込みが走っている
        const r = results[i];
        if (r === null) missing.push(p);
        else fresh.set(p, r);
      });
      // 読めなかったもの: 本当に消えたかを確かめる（権限などで読めないだけなら何もしない）
      let gone: string[] = [];
      if (missing.length) {
        const st = await statPaths(missing).catch(() => null);
        gone = st ? missing.filter((_, i) => !st[i]?.exists) : [];
      }
      // 名前の変更・移動: 同じ変更の中に、消えたファイルと同じ内容のファイルがあれば移動先とみなす
      const moved = new Map<string, string>();
      if (gone.length && !change.rescan) {
        const open = new Set(filesOf(wsRef.current).map(pathKey));
        const cands = change.paths.filter((c) => !open.has(pathKey(c))).slice(0, 20);
        for (const g of gone) {
          const tab = allTabs(wsRef.current).find((t): t is DocTab => t.kind === "doc" && t.path === g);
          const anc = tab && matchedAncestor(change.paths, g);
          if (!tab || !anc) continue;
          const rest = norm(g).slice(norm(anc).length); // フォルダごと動いたときの、その中での位置
          for (const c of cands) {
            if (pathKey(c) === pathKey(anc)) continue;
            const to = norm(c) + rest;
            if ([...moved.values()].includes(to)) continue;
            const text = await readText(to).catch(() => null);
            if (text !== null && text === tab.saved) {
              moved.set(g, to);
              break;
            }
          }
        }
      }
      if (!fresh.size && !gone.length) return;
      const goneSet = new Set(gone);
      apply((w) =>
        mapTabs(w, (t): Tab => {
          if (t.kind === "diff") {
            const l = fresh.get(t.left);
            const r = fresh.get(t.right);
            if ((l === undefined || l === t.leftText) && (r === undefined || r === t.rightText)) return t;
            return { ...t, leftText: l ?? t.leftText, rightText: r ?? t.rightText };
          }
          const to = moved.get(t.path);
          if (to) return { ...t, path: to, deleted: false };
          if (goneSet.has(t.path)) return t.deleted ? t : { ...t, deleted: true, external: undefined };
          const text = fresh.get(t.path);
          if (text === undefined) return t;
          const settled = !t.deleted && t.external === undefined;
          if (t.content === t.saved) {
            // 未保存の変更なし: そのまま差し替える（同じ内容なら何もしない＝描き直さない）
            if (text === t.saved && settled) return t;
            return { ...t, content: text, saved: text, deleted: false, external: undefined };
          }
          // 未保存の変更あり: 上書きしない
          if (text === t.content) return { ...t, saved: text, deleted: false, external: undefined }; // 外と同じ内容になった（自分の保存など）
          if (text === t.saved) return settled ? t : { ...t, deleted: false, external: undefined };
          return t.external === text && !t.deleted ? t : { ...t, external: text, deleted: false };
        }),
      );
    },
    [apply, wsRef],
  );

  /** ツリーの部分更新の順番待ち（読み直している間に届いた変更は、終わってからまとめて読む） */
  const treeQueue = useRef({ paths: new Set<string>(), all: false, running: false });
  /** ツリーを読み直す。変更のあったフォルダだけ読み、全体は必要なときだけ。展開状態・選択・スクロール位置は保たれる */
  const refreshTreeFor = useCallback(
    async (change: FsChange) => {
      const q = treeQueue.current;
      const r0 = rootRef.current;
      if (!r0) return;
      if (change.rescan) q.all = true;
      else for (const p of change.paths) if (!irrelevantForTree(r0, p)) q.paths.add(p);
      if (q.running) return;
      q.running = true;
      try {
        while (q.all || q.paths.size) {
          const root = rootRef.current;
          if (!root) break;
          const all = q.all;
          const paths = [...q.paths];
          q.all = false;
          q.paths.clear();
          let plan: string[] | "all" = "all";
          if (!all) {
            const st = await statPaths(paths).catch(() => null);
            if (st) plan = dirsToReread(root, indexTree(treeRef.current), paths, new Map(paths.map((p, i) => [pathKey(p), st[i]])));
          }
          if (rootRef.current !== root) break;
          if (plan === "all") {
            const next = await readTree(root).catch(() => [] as Entry[]); // フォルダが消えたら空にする（戻れば読み直す）
            if (rootRef.current !== root) break;
            if (!sameEntries(treeRef.current, next)) setTree(next);
          } else if (plan.length) {
            const res = await readDirs(plan).catch(() => null);
            if (rootRef.current !== root) break;
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
    [rootRef, setTree, treeRef],
  );

  // 監視からの知らせ（変更から 100ms ほどで届く）
  useEffect(() => {
    const un = listen<FsChange>("fs-change", (ev) => {
      const change = { paths: ev.payload.paths ?? [], rescan: !!ev.payload.rescan };
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
    const recheck = async () => {
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
      if (now - lastTreeCheck.current > 2000) {
        lastTreeCheck.current = now;
        refreshTreeFor({ paths: [], rescan: true });
      }
    };
    recheck(); // 今の状態を覚えておく
    const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && recheck());
    const onVis = () => document.visibilityState === "visible" && recheck();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      un.then((f) => f());
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, reloadTabs, refreshTreeFor, wsRef]);

  return { watchKey, watchedFiles };
}
