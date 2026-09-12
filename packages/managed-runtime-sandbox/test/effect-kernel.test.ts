import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPortEffect,
  tryPortPromise,
  waitForAbortableDelay,
} from "../src/effect-kernel";

afterEach(() => {
  vi.useRealTimers();
});

describe("internal Effect kernel Promise boundary", () => {
  it("returns successful Promise values", async () => {
    await expect(runPortEffect(tryPortPromise(async () => "ready")))
      .resolves.toBe("ready");
  });

  it("preserves typed failure identity instead of leaking FiberFailure", async () => {
    const failure = new RangeError("provider rejected the request");
    await expect(runPortEffect(Effect.fail(failure))).rejects.toBe(failure);
  });

  it("preserves the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("claim fenced");
    const running = runPortEffect(Effect.never, controller.signal);
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("preserves defects at the Promise boundary", async () => {
    const defect = new Error("kernel invariant failed");
    await expect(runPortEffect(Effect.die(defect))).rejects.toBe(defect);
  });

  it("detaches a delay's abort listener after a normal wake", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForAbortableDelay(250, controller.signal);
    await vi.advanceTimersByTimeAsync(250);
    await waiting;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects an already-aborted delay without attaching a listener", async () => {
    const controller = new AbortController();
    const reason = new Error("already fenced");
    controller.abort(reason);
    const add = vi.spyOn(controller.signal, "addEventListener");
    await expect(waitForAbortableDelay(250, controller.signal)).rejects.toBe(reason);
    expect(add).not.toHaveBeenCalled();
  });

  it("cancels an active delay and detaches its abort listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("lease lost while waiting");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForAbortableDelay(250, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
