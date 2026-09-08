import { describe, expect, it, vi } from "vitest";

import { ExecutionLeaseController } from "../src/index";

interface TestFence {
  generation: number;
  expiresAtMs: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ExecutionLeaseController", () => {
  it("keeps one mutable fence identity and aborts the executor after authoritative lease loss", async () => {
    const firstTick = deferred<void>();
    const secondTick = deferred<void>();
    const ticks = [firstTick, secondTick];
    const renew = vi
      .fn<() => Promise<
        | { type: "renewed"; fence: TestFence; stopRequested: false }
        | { type: "lost"; reason: Error }
      >>()
      .mockResolvedValueOnce({
        type: "renewed",
        fence: { generation: 1, expiresAtMs: 200 },
        stopRequested: false,
      })
      .mockResolvedValueOnce({
        type: "lost",
        reason: new Error("fenced by replacement"),
      });
    const originalFence: TestFence = { generation: 1, expiresAtMs: 100 };
    const controller = new ExecutionLeaseController({
      fence: originalFence,
      heartbeatIntervalMs: 10,
      renew,
      scheduler: {
        sleep: vi.fn(async () => {
          const tick = ticks.shift();
          if (tick !== undefined) await tick.promise;
        }),
      },
    });

    const running = controller.start();
    firstTick.resolve();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    expect(controller.fence).toBe(originalFence);
    expect(originalFence.expiresAtMs).toBe(200);

    secondTick.resolve();
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(controller.lost).toBe(true);
    await running;
  });

  it("distinguishes a graceful stop request from ownership loss", async () => {
    const controller = new ExecutionLeaseController({
      fence: { generation: 4, expiresAtMs: 100 },
      heartbeatIntervalMs: 10,
      renew: async () => ({
        type: "renewed" as const,
        fence: { generation: 4, expiresAtMs: 200 },
        stopRequested: true,
      }),
      scheduler: { sleep: async () => {} },
    });

    await controller.renewNow();

    expect(controller.stopRequested).toBe(true);
    expect(controller.lost).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it("allows a transient renewal failure only while the last confirmed lease remains live", async () => {
    let now = 50;
    const retries: unknown[] = [];
    const controller = new ExecutionLeaseController({
      fence: { generation: 2, expiresAtMs: 100 },
      heartbeatIntervalMs: 10,
      renew: async () => ({ type: "retry" as const, error: new Error("network") }),
      leaseExpiresAt: (fence) => fence.expiresAtMs,
      now: () => now,
      onRetry: (error) => { retries.push(error); },
      scheduler: { sleep: async () => {} },
    });

    await controller.renewNow();
    expect(controller.lost).toBe(false);
    expect(retries).toHaveLength(1);

    now = 100;
    await controller.renewNow();
    expect(controller.lost).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("treats a scheduler abort during close as normal monitor shutdown", async () => {
    const sleeping = deferred<void>();
    const controller = new ExecutionLeaseController({
      fence: { generation: 1, expiresAtMs: 100 },
      heartbeatIntervalMs: 10,
      renew: async (fence) => ({ type: "renewed" as const, fence }),
      scheduler: {
        sleep: async (_milliseconds, signal) => {
          sleeping.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      },
    });

    const monitoring = controller.start();
    await sleeping.promise;

    await expect(controller.close()).resolves.toBeUndefined();
    await expect(monitoring).resolves.toBeUndefined();
    expect(controller.lost).toBe(false);
  });

  it("fails closed when a renewal observer throws inside the monitor", async () => {
    const controller = new ExecutionLeaseController({
      fence: { generation: 1, expiresAtMs: 100 },
      heartbeatIntervalMs: 10,
      renew: async () => ({
        type: "renewed" as const,
        fence: { generation: 1, expiresAtMs: 200 },
      }),
      onFenceChanged: () => {
        throw new Error("injected observer failure");
      },
      scheduler: { sleep: async () => {} },
    });

    await expect(controller.start({ immediate: true })).resolves.toBeUndefined();
    expect(controller.lost).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
