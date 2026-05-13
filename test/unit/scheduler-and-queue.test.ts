// Unit tests for the runtime-agnostic Scheduler + Queue + DLQ ports.
// Cover behaviour that's adapter-shape-independent so a regression in
// either CF or Node adapters surfaces here cheaply.

import { describe, it, expect, vi } from "vitest";
import { createCfScheduler } from "../../packages/scheduler/src/adapters/cf";
import {
  createInMemoryQueue,
  createInMemoryDlq,
} from "../../packages/queue/src/adapters/in-memory";

describe("scheduler — CF dispatch", () => {
  it("registers + dispatches handlers by exact cron match", async () => {
    const s = createCfScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.register({ name: "every-min", cron: "* * * * *", handler: a });
    s.register({ name: "hourly", cron: "0 * * * *", handler: b });

    const dispatched = await s.dispatch("* * * * *");
    expect(dispatched).toEqual(["every-min"]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("dispatches multiple handlers when expressions tie", async () => {
    const s = createCfScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.register({ name: "tick-a", cron: "* * * * *", handler: a });
    s.register({ name: "tick-b", cron: "* * * * *", handler: b });
    const dispatched = await s.dispatch("* * * * *");
    expect(dispatched.sort()).toEqual(["tick-a", "tick-b"]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("dispatch returns empty when no handler matches", async () => {
    const s = createCfScheduler();
    s.register({ name: "tick", cron: "* * * * *", handler: () => {} });
    expect(await s.dispatch("0 0 * * *")).toEqual([]);
  });

  it("does not crash when a handler throws — caller decides to swallow", async () => {
    const s = createCfScheduler();
    s.register({
      name: "fail",
      cron: "* * * * *",
      handler: () => {
        throw new Error("boom");
      },
    });
    await expect(s.dispatch("* * * * *")).rejects.toThrow("boom");
  });
});

describe("queue — in-memory", () => {
  it("dispatches enqueued messages to the subscriber", async () => {
    const seen: string[] = [];
    const q = createInMemoryQueue<string>();
    q.subscribe((msg) => {
      seen.push(msg.body);
    });
    await q.enqueue("a");
    await q.enqueue("b");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("retries on throw up to maxRetries, then DLQs", async () => {
    let attempts = 0;
    const dlq = createInMemoryDlq<string>();
    const dlqSeen: number[] = [];
    dlq.subscribe((msg) => {
      dlqSeen.push(msg.attempts);
    });
    const q = createInMemoryQueue<string>({ dlq, maxRetries: 2 });
    q.subscribe(() => {
      attempts++;
      throw new Error("nope");
    });
    await q.enqueue("retry-me");
    // wait for setImmediates + the 100ms*attempts backoff
    await new Promise((r) => setTimeout(r, 600));
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(dlqSeen.length).toBe(1);
  });
});
