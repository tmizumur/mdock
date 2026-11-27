import { loadSession, readTextResult } from "./api";
import { type DiffTab, type DocTab, type PaneState, type SavedPane, type SavedTab, type Session, type Tab, defaultSession, emptyPane, isDirty, migrateSession, newId, receiveDiffText, receiveDocText, settlePanePreviews } from "./tabs";

export function saveTabState(t: Tab, scroll: number): SavedTab {
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
    ...(t.preview ? { preview: true } : {}),
    ...(isDirty(t) ? { draft: t.content, draftBase: t.saved, savedBom: t.savedBom } : {}),
  };
}

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
  let draftBase = typeof t.draftBase === "string" ? t.draftBase : undefined;
  let draft = typeof t.draft === "string" ? t.draft : undefined;
  let bom = t.bom;
  let savedBom = typeof t.savedBom === "boolean" && t.savedBom !== !!bom ? t.savedBom : undefined;
  // 旧形式では BOM がディスクの本文と下書きの先頭に含まれていた。
  if (bom === undefined && t.encoding === undefined && draftBase !== undefined) {
    const baseBom = draftBase.startsWith("\uFEFF");
    const draftBom = draft?.startsWith("\uFEFF") ?? baseBom;
    draftBase = draftBase.replace(/^\uFEFF/, "");
    draft = draft?.replace(/^\uFEFF/, "");
    bom = draftBom || (baseBom ? false : undefined);
    if (baseBom !== draftBom) savedBom = baseBom;
  }
  const saved = draftBase ?? info?.text ?? "";
  const tab: DocTab = {
    id, kind: "doc", path: t.path, content: draft ?? saved, saved, mode: t.mode ?? "view",
    encoding: t.encoding, bom, savedBom, force, readError: error,
    ...(t.preview === true ? { preview: true } : {}),
  };
  return info ? receiveDocText(tab, info) : tab;
}

export async function restorePane(p: SavedPane | undefined, scrolls: Map<string, number>): Promise<PaneState> {
  if (!p?.tabs?.length) return emptyPane();
  const results = await Promise.all(p.tabs.map((t) => restoreTab(t, scrolls)));
  // 壊れたタブの情報を除き、選んでいたタブの位置を合わせる。
  const keptBefore = results.slice(0, p.active).filter(Boolean).length;
  const tabs = results.filter((t): t is Tab => !!t);
  return settlePanePreviews({ tabs, active: Math.min(keptBefore, Math.max(0, tabs.length - 1)) });
}
