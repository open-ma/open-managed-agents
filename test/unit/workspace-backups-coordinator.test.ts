// @ts-nocheck
// Unit tests for the coordinateBackup PURE function.
//
// Why a separate file from workspace-backups.test.ts: this file uses no
// cloudflare:workers env, no D1, no test-worker bootstrap — just vitest
// fakes + a hand-rolled mock clock. Keeping it pure means it doesn't pay
// the cloudflare-pool startup cost and can run under the plain `node`
// test environment if we ever split test pools.
//
// What this exercises is the same logic that lives behind
// SessionDO.maybeBackupWorkspace: debounce, in-flight coalesce, force
// override, retry-on-failure semantics. The DO-side wiring (which feeds
// instance fields through getter/setter adapters) is impossible to drive
// from a unit test, so we drive the pure function directly.

import { describe, it, expect, vi } from "vitest";
import {
  coordinateBackup,
  type BackupCoordinatorState,
} from "../../apps/agent/src/runtime/workspace-backups";

/**
 * Build a fresh state object + a controllable clock + a stubbed doBackup.
 * Each test gets its own to avoid bleed.
 */
function makeRig(opts?: {
  /** What doBackup should do each call. Defaults to resolve immediately. */
  doBackupImpl?: () => Promise<void>;
  /** Initial debounce window (ms). */
  debounceMs?: number;
  /** Initial mock clock value. */
  startNow?: number;
}) {
  const state: BackupCoordinatorState = {
    lastBackupAt: 0,
    inFlight: null,
  };
  let now = opts?.startNow ?? 1_000_000;
  const doBackup = vi.fn(opts?.doBackupImpl ?? (async () => {}));
  const deps = {
    debounceMs: opts?.debounceMs ?? 60_000,
    doBackup,
    now: () => now,
  };
  return {
    state,
    deps,
    doBackup,
    advance(ms: number) { now += ms; },
    setNow(v: number) { now = v; },
    nowFn: () => now,
  };
}

describe("coordinateBackup: single call", () => {
  it("invokes doBackup and records lastBackupAt on success", async () => {
    const rig = makeRig({ startNow: 100 });
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
    expect(rig.state.lastBackupAt).toBe(100);
    expect(rig.state.inFlight).toBeNull();
  });

  it("does NOT record lastBackupAt on failure (so retry can happen sooner)", async () => {
    const rig = makeRig({
      startNow: 100,
      doBackupImpl: async () => { throw new Error("boom"); },
    });
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
    expect(rig.state.lastBackupAt).toBe(0); // unchanged
    expect(rig.state.inFlight).toBeNull(); // cleared even on failure
  });

  it("clears inFlight after the call completes", async () => {
    const rig = makeRig();
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.state.inFlight).toBeNull();
  });
});

describe("coordinateBackup: debounce", () => {
  it("non-force call within debounce window is skipped", async () => {
    const rig = makeRig({ startNow: 1000, debounceMs: 60_000 });
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);

    rig.advance(30_000); // only halfway through the window
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1); // still 1 — debounced
  });

  it("non-force call AFTER debounce window proceeds", async () => {
    const rig = makeRig({ startNow: 1000, debounceMs: 60_000 });
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);

    rig.advance(60_001); // just past the window
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(2);
  });

  it("force=true bypasses debounce", async () => {
    const rig = makeRig({ startNow: 1000, debounceMs: 60_000 });
    await coordinateBackup(rig.state, rig.deps);
    rig.advance(100); // well within window
    await coordinateBackup(rig.state, rig.deps, { force: true });
    expect(rig.doBackup).toHaveBeenCalledTimes(2);
  });

  it("force=true on the very first call works (lastBackupAt=0)", async () => {
    const rig = makeRig();
    await coordinateBackup(rig.state, rig.deps, { force: true });
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
  });

  it("failed backup keeps lastBackupAt at 0 — next call (force or not) proceeds", async () => {
    let shouldFail = true;
    const rig = makeRig({
      startNow: 1000, debounceMs: 60_000,
      doBackupImpl: async () => { if (shouldFail) throw new Error("first try"); },
    });
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.state.lastBackupAt).toBe(0);

    shouldFail = false;
    rig.advance(10); // tiny — would normally be debounced
    await coordinateBackup(rig.state, rig.deps);
    // debounce window check is `now - lastBackupAt < debounceMs`, and
    // lastBackupAt is still 0 because the first call failed — so this proceeds
    expect(rig.doBackup).toHaveBeenCalledTimes(2);
    expect(rig.state.lastBackupAt).toBe(1010);
  });
});

describe("coordinateBackup: in-flight coalesce", () => {
  it("concurrent non-force callers coalesce to a single doBackup invocation", async () => {
    let resolveBackup: () => void = () => {};
    const rig = makeRig({
      doBackupImpl: () => new Promise<void>((res) => { resolveBackup = res; }),
    });

    // Three concurrent callers — none have force.
    const p1 = coordinateBackup(rig.state, rig.deps);
    const p2 = coordinateBackup(rig.state, rig.deps);
    const p3 = coordinateBackup(rig.state, rig.deps);

    // Only the first call should have triggered doBackup; the rest are
    // deduped because state.inFlight is non-null.
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
    expect(rig.state.inFlight).not.toBeNull();

    // Releasing the in-flight promise should let p1 settle. p2/p3 returned
    // undefined synchronously (non-force skip path) so they should already
    // be resolved.
    resolveBackup();
    await Promise.all([p1, p2, p3]);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
  });

  it("force caller with in-flight backup AWAITS the in-flight (does not start a new one)", async () => {
    let resolveBackup: () => void = () => {};
    let resolved = false;
    const rig = makeRig({
      doBackupImpl: () => new Promise<void>((res) => {
        resolveBackup = () => { resolved = true; res(); };
      }),
    });

    const p1 = coordinateBackup(rig.state, rig.deps); // non-force, starts the backup
    expect(rig.doBackup).toHaveBeenCalledTimes(1);

    const p2Force = coordinateBackup(rig.state, rig.deps, { force: true });
    // force shouldn't double-trigger doBackup
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    // Now resolve and ensure both await the SAME promise.
    resolveBackup();
    await Promise.all([p1, p2Force]);
    expect(resolved).toBe(true);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
  });

  it("non-force caller with in-flight returns undefined immediately (does not block)", async () => {
    // Backup will never resolve until we release it; we want to assert
    // that the non-force second caller does NOT hang waiting for it.
    let resolveBackup: () => void = () => {};
    const rig = makeRig({
      doBackupImpl: () => new Promise<void>((res) => { resolveBackup = res; }),
    });

    const p1 = coordinateBackup(rig.state, rig.deps);
    let p2Done = false;
    const p2 = coordinateBackup(rig.state, rig.deps).then(() => { p2Done = true; });

    // Drain microtasks. p2 should resolve (because the function path returns
    // undefined synchronously, wrapped by async into a resolved promise).
    // p1's underlying promise is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Done).toBe(true);

    // Cleanup so vitest doesn't leak a pending promise.
    resolveBackup();
    await Promise.all([p1, p2]);
  });

  it("after in-flight completes, subsequent calls re-evaluate from clean state", async () => {
    let firstResolve: () => void = () => {};
    let counter = 0;
    const rig = makeRig({
      startNow: 1000, debounceMs: 60_000,
      doBackupImpl: () => new Promise<void>((res) => {
        counter++;
        if (counter === 1) firstResolve = res;
        else res(); // second+ call: resolve immediately
      }),
    });

    const p1 = coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(1);
    expect(rig.state.inFlight).not.toBeNull();

    // Let the in-flight finish.
    firstResolve();
    await p1;
    expect(rig.state.inFlight).toBeNull();
    expect(rig.state.lastBackupAt).toBe(1000);

    // Now advance past the debounce window — a second call should start
    // a fresh backup.
    rig.advance(60_001);
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(2);
    expect(rig.state.lastBackupAt).toBe(61_001);
  });

  it("an in-flight failure clears inFlight so the next call can retry", async () => {
    let shouldFail = true;
    const rig = makeRig({
      startNow: 1000, debounceMs: 60_000,
      doBackupImpl: async () => { if (shouldFail) throw new Error("boom"); },
    });

    await coordinateBackup(rig.state, rig.deps);
    expect(rig.state.inFlight).toBeNull();
    expect(rig.state.lastBackupAt).toBe(0);

    shouldFail = false;
    // Even within the debounce window, lastBackupAt was never bumped,
    // so the retry should fire.
    rig.advance(100);
    await coordinateBackup(rig.state, rig.deps);
    expect(rig.doBackup).toHaveBeenCalledTimes(2);
    expect(rig.state.lastBackupAt).toBe(1100);
  });
});

describe("coordinateBackup: clock semantics", () => {
  it("uses deps.now() at the START to gate, but at END (after success) to record", async () => {
    let resolveBackup: () => void = () => {};
    const rig = makeRig({
      startNow: 1000, debounceMs: 60_000,
      doBackupImpl: () => new Promise<void>((res) => { resolveBackup = res; }),
    });

    const p = coordinateBackup(rig.state, rig.deps);
    rig.setNow(5000); // clock moves while backup is "running"
    resolveBackup();
    await p;

    // lastBackupAt should reflect the END time, not the START time.
    expect(rig.state.lastBackupAt).toBe(5000);
  });
});
