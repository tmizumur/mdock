import { loadSession, readText } from "./api";
import { type PaneState, type SavedPane, type SavedTab, type Session, type Tab, defaultSession, emptyPane, migrateSession, newId } from "./tabs";

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
  try {
    const id = newId();
    scrolls.set(id, t.scroll ?? 0);
    if (t.kind === "diff") {
      const [leftText, rightText] = await Promise.all([readText(t.left), readText(t.right)]);
      return { id, kind: "diff", left: t.left, right: t.right, leftText, rightText };
    }
    const text = await readText(t.path);
    const draft = t.draft !== undefined && t.draftBase === text ? t.draft : text;
    return { id, kind: "doc", path: t.path, content: draft, saved: text, mode: t.mode ?? "view" };
  } catch {
    return null; // ファイルが消えていたら、そのタブは開かない
  }
}

export async function restorePane(p: SavedPane | undefined, scrolls: Map<string, number>): Promise<PaneState> {
  if (!p?.tabs?.length) return emptyPane();
  const results = await Promise.all(p.tabs.map((t) => restoreTab(t, scrolls)));
  // 消えたタブを除いたうえで、選んでいたタブの位置を合わせる
  const keptBefore = results.slice(0, p.active).filter(Boolean).length;
  const tabs = results.filter((t): t is Tab => !!t);
  return { tabs, active: Math.min(keptBefore, Math.max(0, tabs.length - 1)) };
}
