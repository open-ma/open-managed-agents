import { describe, expect, it, vi } from "vitest";

import {
  createClaimedEnvironmentWorkRunner,
  type ClaimedEnvironmentWorkLifecycleClient,
} from "../src/index";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function lifecycleClient(overrides: Partial<ClaimedEnvironmentWorkLifecycleClient> = {}) {
  return {
    ack: vi.fn(async () => ({ state: "starting" })),
    heartbeat: vi.fn(async () => ({
      last_heartbeat: "beat_1",
      lease_extended: true,
      state: "running",
      ttl_seconds: 90,
    })),
    stop: vi.fn(async () => ({})),
    ...overrides,
  } satisfies ClaimedEnvironmentWorkLifecycleClient;
}

const item = {
  environmentId: "env_01",
  sessionId: "session_01",
  workId: "work_01",
};

describe("claimed Environment Work runner", () => {
  it("ACKs, establishes the CAS lease, executes, and force-stops in protocol order", async () => {
    const operations: string[] = [];
    const client = lifecycleClient({
      ack: vi.fn(async () => { operations.push("ack"); return { state: "starting" }; }),
      heartbeat: vi.fn(async (_id, params) => {
        operations.push(`heartbeat:${params.expected_last_heartbeat}`);
        return {
          last_heartbeat: "beat_1",
          lease_extended: true,
          state: "running",
          ttl_seconds: 90,
        };
      }),
      stop: vi.fn(async () => { operations.push("stop"); return {}; }),
    });
    const runner = createClaimedEnvironmentWorkRunner({
      client,
      scheduler: { sleep: async (_milliseconds, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await expect(runner.run({
      ...item,
      execute: async (signal) => {
        expect(signal.aborted).toBe(false);
        operations.push("execute");
        return "done";
      },
    })).resolves.toBe("done");

    expect(operations).toEqual([
      "ack",
      "heartbeat:NO_HEARTBEAT",
      "execute",
      "stop",
    ]);
    expect(client.ack).toHaveBeenCalledWith(
      item.workId,
      { environment_id: item.environmentId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.stop).toHaveBeenCalledWith(
      item.workId,
      { environment_id: item.environmentId, force: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("delivers a subsequent CAS heartbeat while the ACP turn is still running", async () => {
    const releaseSleep = deferred<void>();
    const enteredTurn = deferred<void>();
    const finishTurn = deferred<void>();
    const client = lifecycleClient({
      heartbeat: vi.fn()
        .mockResolvedValueOnce({
          last_heartbeat: "beat_1",
          lease_extended: true,
          state: "running",
          ttl_seconds: 90,
        })
        .mockResolvedValueOnce({
          last_heartbeat: "beat_2",
          lease_extended: true,
          state: "running",
          ttl_seconds: 90,
        }),
    });
    let sleeps = 0;
    const runner = createClaimedEnvironmentWorkRunner({
      client,
      scheduler: { sleep: async (_milliseconds, signal) => {
        sleeps += 1;
        if (sleeps > 1) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return;
        }
        await Promise.race([
          releaseSleep.promise,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
      } },
    });
    const running = runner.run({
      ...item,
      execute: async () => {
        enteredTurn.resolve();
        await finishTurn.promise;
      },
    });
    await enteredTurn.promise;
    releaseSleep.resolve();
    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(2));
    expect(client.heartbeat).toHaveBeenLastCalledWith(
      item.workId,
      expect.objectContaining({ expected_last_heartbeat: "beat_1" }),
      expect.anything(),
    );
    finishTurn.resolve();
    await running;
  });

  it("fences the running harness on 412 and never stops work owned by its replacement", async () => {
    const releaseSleep = deferred<void>();
    const enteredTurn = deferred<void>();
    const client = lifecycleClient({
      heartbeat: vi.fn()
        .mockResolvedValueOnce({
          last_heartbeat: "beat_1",
          lease_extended: true,
          state: "running",
          ttl_seconds: 90,
        })
        .mockRejectedValueOnce(Object.assign(new Error("lost"), { status: 412 })),
    });
    const runner = createClaimedEnvironmentWorkRunner({
      client,
      scheduler: { sleep: async () => { await releaseSleep.promise; } },
    });
    const running = runner.run({
      ...item,
      execute: async (signal) => {
        enteredTurn.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
    });
    await enteredTurn.promise;
    releaseSleep.resolve();

    await expect(running).rejects.toThrow("lease");
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("aborts before ACK when the caller is already cancelled", async () => {
    const client = lifecycleClient();
    const runner = createClaimedEnvironmentWorkRunner({ client });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runner.run({
      ...item,
      signal: controller.signal,
      execute: vi.fn(),
    })).rejects.toThrow("cancelled");
    expect(client.ack).not.toHaveBeenCalled();
  });
});
