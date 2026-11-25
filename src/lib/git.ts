import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { norm } from "./api";

/** M: 変更 / A: 新規（ステージ済み） / U: 未追跡 / C: 競合 / I: 無視 */
export type GitMark = "M" | "A" | "U" | "C" | "I";
type GitEntry = { path: string; mark: GitMark; dir: boolean };

type GitStatus = { branch: string; entries: GitEntry[] };
const gitStatus = (root: string, includeEntries: boolean) => invoke<GitStatus | null>("git_status", { root, includeEntries });

/** フォルダに付ける色の強さ（中に複数の状態があるときは強いほう） */
const RANK: Record<GitMark, number> = { I: 0, U: 1, A: 2, M: 3, C: 4 };

export type GitLookup = {
  /** ファイル・フォルダの状態。フォルダは「中に変更を含む」ときも返す（folder: true） */
  get: (path: string) => { mark: GitMark; folder: boolean } | undefined;
};

const EMPTY: GitLookup = { get: () => undefined };

function buildLookup(root: string, list: GitEntry[]): GitLookup {
  const base = norm(root).replace(/\/$/, "");
  const files = new Map<string, GitMark>();
  /** 未追跡・無視されたフォルダ（中身もすべて同じ） */
  const whole = new Map<string, GitMark>();
  /** 変更を含むフォルダ */
  const parents = new Map<string, GitMark>();
  for (const e of list) {
    const p = norm(e.path);
    (e.dir ? whole : files).set(p, e.mark);
    if (e.mark === "I") continue;
    for (let d = p.slice(0, p.lastIndexOf("/")); d.length > base.length; d = d.slice(0, d.lastIndexOf("/"))) {
      const cur = parents.get(d);
      if (cur && RANK[cur] >= RANK[e.mark]) break; // 上のフォルダも同じかそれより強い印が付いている
      parents.set(d, e.mark);
    }
  }
  return {
    get(path) {
      const p = norm(path);
      const own = files.get(p) ?? whole.get(p);
      if (own) return { mark: own, folder: false };
      // 未追跡・無視されたフォルダの中
      if (whole.size) {
        for (let d = p.slice(0, p.lastIndexOf("/")); d.length > base.length; d = d.slice(0, d.lastIndexOf("/"))) {
          const m = whole.get(d);
          if (m) return { mark: m, folder: false };
        }
      }
      const m = parents.get(p);
      return m ? { mark: m, folder: true } : undefined;
    },
  };
}

/**
 * 開いているフォルダの git の状態。ファイルの変更（.git の中の変更＝コミットやステージも含む）のたびに、
 * すぐ（80ms ほどまとめてから）読み直す。読み直している間に変更があれば、終わってからもう一度読む。
 */
export function useGitStatus(root: string | null, enabled: boolean) {
  const [status, setStatus] = useState<(GitStatus & { root: string }) | null>(null);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    let running = false;
    let again = false;
    let timer: number | undefined;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const status = await gitStatus(root, enabled);
        // 前と同じ結果なら置き換えない（ツリーを描き直さない）
        if (alive)
          setStatus((prev) =>
            status && prev?.root === root && prev.branch === status.branch && JSON.stringify(prev.entries) === JSON.stringify(status.entries)
              ? prev
              : status && { root, ...status },
          );
      } catch (e) {
        console.warn("git status", e);
      } finally {
        running = false;
        if (again && alive) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 80);
    };
    run();
    // ファイルの変更と同じタイミングで読み直す。ウィンドウに戻ってきたときも（取りこぼし対策）
    const uns = [listen("fs-change", schedule), getCurrentWindow().onFocusChanged(({ payload }) => payload && schedule())];
    return () => {
      alive = false;
      window.clearTimeout(timer);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [root, enabled]);

  return useMemo(() => ({
    branch: status?.root === root ? status.branch : null,
    lookup: enabled && status?.root === root ? buildLookup(status.root, status.entries) : EMPTY,
  }), [status, root, enabled]);
}
