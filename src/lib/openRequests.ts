/** ペインごとに最後のファイル読み込みを記録する */
export function createOpenRequests() {
  let latest = new Map<string, number>();

  return {
    start(pane: string) {
      const requests = latest;
      const number = (requests.get(pane) ?? 0) + 1;
      requests.set(pane, number);
      return () => {
        if (requests !== latest) return "cleared";
        return number === requests.get(pane) ? "latest" : "superseded";
      };
    },
    clear() {
      latest = new Map();
    },
  };
}
