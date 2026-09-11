import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseStream } from "../src/sessions/sse-stream";

describe("session SSE heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a silent upstream stream alive and closes it on cancellation", async () => {
    vi.useFakeTimers();
    let closed = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = {
      async *[Symbol.asyncIterator]() {
        await finished;
      },
      close() {
        if (closed) return;
        closed = true;
        finish();
      },
    };

    const reader = createSseStream(handle, { heartbeatIntervalMs: 1_000 }).getReader();
    const decoder = new TextDecoder();

    expect(decoder.decode((await reader.read()).value)).toBe("retry: 1000\n\n");
    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(decoder.decode((await heartbeat).value)).toBe(": keepalive\n\n");

    await reader.cancel();
    expect(closed).toBe(true);
  });

  it("does not retain a heartbeat timer when the request is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    let closes = 0;
    const handle = {
      async *[Symbol.asyncIterator]() {},
      close() {
        closes += 1;
      },
    };

    const reader = createSseStream(handle, {
      heartbeatIntervalMs: 1_000,
      signal: controller.signal,
    }).getReader();
    await reader.read();

    expect(closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
