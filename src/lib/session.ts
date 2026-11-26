import { loadSession, readTextResult } from "./api";
import { type DiffTab, type DocTab, type PaneState, type SavedPane, type SavedTab, type Session, type Tab, defaultSession, emptyPane, migrateSession, newId, receiveDiffText, receiveDocText } from "./tabs";

/** 保存しておいた状態を読む。壊れていたら初期状態から始める。 */
export async function restoreSession(): Promise<Session> {
  try {
    const raw = await loadSession();
    const s = migrateSession(raw ? JSON.parse(raw) : null) ?? migrateSession(JSON.parse(localStorage.getItem("mdock.session") ?? "null"));
    if (s) return s;
  } catch (e) {
    console.warn("session", e);
  }
  return defaultSession();
}

async function restoreTab(t: SavedTab, scrolls: Map<string, number>): Promise<Tab | null> {
  const id = newId();
  if (t?.kind === "diff" && typeof t.left === "string" && typeof t.right === "string") {
    scrolls.set(id, t.scroll ?? 0);
    const leftForce = t.force?.left === true ? true : undefined;
    const rightForce = t.force?.right === true ? true : undefined;
    const [left, right] = await Promise.all([readTextResult(t.left, leftForce), readTextResult(t.right, rightForce)]);
    const tab: DiffTab = { id, kind: "diff", left: t.left, right: t.right, leftText: "", rightText: "" };
    return receiveDiffText(receiveDiffText(tab, "left", left, leftForce), "right", right, rightForce);
  }
  if (!t || t.kind === "diff" || typeof t.path !== "string") return null;
  scrolls.set(id, t.scroll ?? 0);
  const force = t.force === true ? true : undefined;
  const { info, error } = await readTextResult(t.path, force);
  const saved = info?.text ?? t.draftBase ?? "";
  const content = t.draft !== undefined && (!info || t.draftBase === saved) ? t.draft : saved;
  const tab: DocTab = {
    id, kind: "doc", path: t.path, content, saved, mode: t.mode ?? "view",
    encoding: t.encoding, bom: t.bom, force, readError: error,
  };
  return info ? receiveDocText(tab, info) : tab;
}

export async function restorePane(p: SavedPane | undefined, scrolls: Map<string, number>): Promise<PaneState> {
  if (!p?.tabs?.length) return emptyPane();
  const results = await Promise.all(p.tabs.map((t) => restoreTab(t, scrolls)));
  // 壊れたタブの情報を除き、選んでいたタブの位置を合わせる。
  const keptBefore = results.slice(0, p.active).filter(Boolean).length;
  const tabs = results.filter((t): t is Tab => !!t);
  return { tabs, active: Math.min(keptBefore, Math.max(0, tabs.length - 1)) };
}
