import type { DiffRequest, DiffResponse } from "./diffClient";
import { computeRows } from "./diffRows";

self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const { id, a, b } = event.data;
  self.postMessage({ id, ...computeRows(a, b) } satisfies DiffResponse);
};
