import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { norm } from "./api";

/** M: 変更 / A: 新規（ステージ済み） / U: 未追跡 / C: 競合 / I: 無視 */
export type GitMark = "M" | "A" | "U" | "C" | "I";
type GitEntry = { path: string; mark: GitMark; dir: boolean };

const gitStatus = (root: string) => invoke<GitEntry[] | null>("git_status", { root });

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
 * 少し待ってから読み直す。読み直している間に変更があれば、終わってからもう一度読む。
 */
export function useGitStatus(root: string | null, enabled: boolean): GitLookup {
  const [list, setList] = useState<{ root: string; entries: GitEntry[] } | null>(null);

  useEffect(() => {
    setList(null);
    if (!root || !enabled) return;
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
        const entries = await gitStatus(root);
        if (alive) setList(entries ? { root, entries } : null);
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
      timer = window.setTimeout(run, 400);
    };
    run();
    const un = listen<string[]>("fs-change", schedule);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      un.then((f) => f());
    };
  }, [root, enabled]);

  return useMemo(() => (list && list.root === root ? buildLookup(list.root, list.entries) : EMPTY), [list, root]);
}
