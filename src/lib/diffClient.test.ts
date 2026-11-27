import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_LIMIT_MS, computeDiff, type DiffResponse } from "./diffClient";
import { buildRows } from "./diffRows";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: { data: DiffResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    TestWorker.instances.push(this);
  }
}

afterEach(() => {
  TestWorker.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("computeDiff", () => {
  it("リクエストごとに Worker を作り、対応する結果を受け取って終了する", async () => {
    vi.stubGlobal("Worker", TestWorker);
    const first = computeDiff("a", "b");
    const second = computeDiff("x", "y");
    const [firstWorker, secondWorker] = TestWorker.instances;
    const [{ id: firstId }] = firstWorker.postMessage.mock.calls[0];
    const [{ id: secondId }] = secondWorker.postMessage.mock.calls[0];
    expect(secondWorker.postMessage).toHaveBeenCalledExactlyOnceWith({ id: secondId, a: "x", b: "y" });

    secondWorker.onmessage?.({ data: { id: firstId, tooLarge: true } });
    expect(secondWorker.terminate).not.toHaveBeenCalled();

    const result = buildRows("x", "y");
    secondWorker.onmessage?.({ data: { id: secondId, ...result } });
    await expect(second.promise).resolves.toEqual(result);
    expect(secondWorker.terminate).toHaveBeenCalledTimes(1);

    firstWorker.onmessage?.({ data: { id: firstId, tooLarge: true } });
    await expect(first.promise).resolves.toEqual({ tooLarge: true });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("キャンセルすると Worker を終了して遅れて届いた結果を捨てる", async () => {
    vi.stubGlobal("Worker", TestWorker);
    const request = computeDiff("a", "b");
    const [worker] = TestWorker.instances;
    const [{ id }] = worker.postMessage.mock.calls[0];
    const receive = worker.onmessage;
    const cancelled = expect(request.promise).rejects.toMatchObject({ name: "AbortError" });

    request.cancel();
    receive?.({ data: { id, ...buildRows("a", "b") } });
    request.cancel();

    await cancelled;
    expect(worker.onmessage).toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("Worker を作れなければタイマーのあとに同じ差分を計算する", async () => {
    vi.stubGlobal("Worker", class {
      constructor() {
        throw new Error("Worker を作れませんでした");
      }
    });
    vi.useFakeTimers();

    const request = computeDiff("a", "b");
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    await expect(request.promise).resolves.toEqual(buildRows("a", "b"));
  });

  it("Worker の読み込みに失敗したらこのスレッドで計算する", async () => {
    vi.stubGlobal("Worker", TestWorker);
    vi.useFakeTimers();

    const request = computeDiff("a", "b");
    const [worker] = TestWorker.instances;
    worker.onerror?.();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await vi.runOnlyPendingTimersAsync();
    await expect(request.promise).resolves.toEqual(buildRows("a", "b"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("Worker が応答しなければ打ち切って大きすぎる扱いにする", async () => {
    vi.stubGlobal("Worker", TestWorker);
    vi.useFakeTimers();

    const request = computeDiff("a", "b");
    const [worker] = TestWorker.instances;
    await vi.advanceTimersByTimeAsync(WORKER_LIMIT_MS);
    await expect(request.promise).resolves.toEqual({ tooLarge: true });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

