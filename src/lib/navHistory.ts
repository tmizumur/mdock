/** ペインごとの「戻る／進む」（リンクやツリーでの移動の履歴） */

export type NavLocation = { path: string; scroll: number; tabId?: string };
export type NavState = { back: NavLocation[]; forward: NavLocation[] };

/** ページ内リンクで移動する直前にプレビューが出すイベント（戻る／進むの履歴用） */
export const BEFORE_JUMP = "mdock:before-jump";

/** 履歴の上限（古いものから捨てる） */
const LIMIT = 100;

export const emptyNav = (): NavState => ({ back: [], forward: [] });

/** 移動する前の位置を記録する（進む履歴は消える） */
export function recordNav(state: NavState, from: NavLocation): NavState {
  const last = state.back[state.back.length - 1];
  const same = last && last.tabId === from.tabId && last.path === from.path && Math.abs(last.scroll - from.scroll) < 1;
  const back = same ? state.back : [...state.back, from].slice(-LIMIT);
  return { back, forward: [] };
}

/** 戻る。current は今いる位置（進むで戻ってこられるように積む）。戻り先がなければ null */
export function goBack(state: NavState, current: NavLocation): { state: NavState; target: NavLocation } | null {
  const target = state.back[state.back.length - 1];
  if (!target) return null;
  return { state: { back: state.back.slice(0, -1), forward: [...state.forward, current] }, target };
}

/** 進む */
export function goForward(state: NavState, current: NavLocation): { state: NavState; target: NavLocation } | null {
  const target = state.forward[state.forward.length - 1];
  if (!target) return null;
  return { state: { back: [...state.back, current], forward: state.forward.slice(0, -1) }, target };
}
