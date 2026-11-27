import { computeRows, type Result } from "./diffRows";

export type DiffRequest = { id: number; a: string; b: string };
export type DiffResponse = { id: number } & Result;

let nextId = 0;

function createWorker(): Worker | undefined {
  if (typeof Worker === "undefined") return;
  try {
    return new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return;
  }
}

export function computeDiff(a: string, b: string): { promise: Promise<Result>; cancel(): void } {
  const worker = createWorker();
  let finish: (result?: Result) => void;
  const promise = new Promise<Result>((resolve, reject) => {
    let settled = false;
    let dispose: () => void;
    finish = (result) => {
      if (settled) return;
      settled = true;
      dispose();
      if (result) resolve(result);
      else reject(new DOMException("差分の計算を中止しました", "AbortError"));
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Worker が無い・読み込めないときは、同じ計算をこのスレッドで行う
    const inline = () => {
      timer = setTimeout(() => finish(computeRows(a, b)), 0);
    };
    if (!worker) {
      dispose = () => clearTimeout(timer);
      inline();
      return;
    }

    const id = ++nextId;
    const stopWorker = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    dispose = () => {
      stopWorker();
      clearTimeout(timer);
    };

    worker.onmessage = (event: MessageEvent<DiffResponse>) => {
      const { id: responseId, ...result } = event.data;
      if (responseId === id) finish(result);
    };
    worker.onerror = () => {
      stopWorker();
      inline();
    };
    worker.onmessageerror = () => finish({ error: "差分の計算結果を受け取れませんでした" });
    try {
      worker.postMessage({ id, a, b } satisfies DiffRequest);
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { promise, cancel: () => finish() };
}
