import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeCheckpointRef,
  RuntimePublicationCandidate,
} from "@open-managed-agents/runtime-resource-contract";
import type { SandboxCheckpointHandle } from "@open-managed-agents/sandbox";

import {
  acquire,
  binding,
  composition,
  fence,
  plan,
  provider,
  runtime,
  scope,
} from "./provider-runtime-fixture";

const checkpointMetadataKey = "openma.runtime.checkpoint.v1";

function candidate(metadata: unknown): RuntimePublicationCandidate {
  return {
    id: "candidate_1",
    contentHash: "sha256:not-reached",
    metadata: { [checkpointMetadataKey]: metadata as string },
  };
}

describe("provider runtime lifecycle invariants", () => {
  it.each([
    [{ timeoutMs: 0 }, "timeoutMs"],
    [{ timeoutMs: 1.5 }, "timeoutMs"],
    [{ pollIntervalMs: 0 }, "pollIntervalMs"],
    [{ pollIntervalMs: 1.5 }, "pollIntervalMs"],
  ] as const)("rejects invalid readiness configuration %o", (readiness, field) => {
    expect(() => composition(provider(), { readiness })).toThrow(field);
  });

  it("exposes static sandbox/workspace/driver capabilities and a no-op workspace attach", async () => {
    const composed = composition();
    await expect(composed.sandbox.capabilities(scope)).resolves.toEqual({
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    });
    await expect(composed.workspace.capabilities(scope)).resolves.toEqual({
      strategies: ["retained_runtime", "checkpoint_restore", "ephemeral"],
    });
    await expect(composed.harness.driverCapabilities(scope)).resolves.toEqual({
      drivers: ["ama_worker"],
    });
    const workspace = await binding(composed);
    await expect(composed.workspace.attach({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: workspace,
      sandbox: { provider: "e2b", runtimeId: "not-needed" },
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
  });

  it("does not allocate provider compute for an already-aborted claim", async () => {
    const selected = provider();
    const composed = composition(selected);
    const workspace = await binding(composed);
    const controller = new AbortController();
    const reason = new Error("claim already fenced");
    controller.abort(reason);
    await expect(composed.sandbox.acquire({
      scope,
      fence,
      plan,
      workspace,
      outputs: null,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(selected.create).not.toHaveBeenCalled();
  });

  it("keeps the original admission error when failed-allocation cleanup also fails", async () => {
    const invalid = runtime("invalid-runtime", {
      runtimeHandle: () => ({ provider: "wrong", runtimeId: "invalid-runtime" }),
      destroy: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    });
    const composed = composition(provider(invalid));
    await expect(acquire(composed)).rejects.toThrow(/incompatible runtime/i);
    expect(invalid.destroy).toHaveBeenCalledOnce();
  });

  it("times out an unready provider allocation and destroys it", async () => {
    const pending = runtime("pending", {
      status: vi.fn(async () => "unknown" as const),
    });
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110);
    const wait = vi.fn(async () => {});
    const composed = composition(provider(pending), {
      readiness: { timeoutMs: 10, pollIntervalMs: 1, wait },
    });
    await expect(acquire(composed)).rejects.toThrow(/timed out after 10ms/i);
    expect(wait).not.toHaveBeenCalled();
    expect(pending.destroy).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("uses a custom readiness wait until provider compute becomes runnable", async () => {
    const waking = runtime("waking");
    vi.mocked(waking.status)
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("running");
    const wait = vi.fn(async () => {});
    const composed = composition(provider(waking), {
      readiness: { timeoutMs: 50, pollIntervalMs: 7, wait },
    });
    await expect(acquire(composed)).resolves.toMatchObject({ runtimeId: "waking" });
    expect(wait).toHaveBeenCalledWith(7, expect.any(AbortSignal));
  });

  it("reports heartbeat liveness, stopped compute, and provider failures", async () => {
    const live = runtime("heartbeat");
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    await expect(composed.sandbox.heartbeat({ scope, fence, lease }))
      .resolves.toEqual({ type: "alive" });
    expect(live.renewLease).toHaveBeenLastCalledWith({ ttlMs: 90_000 });

    vi.mocked(live.status).mockResolvedValueOnce("stopped");
    await expect(composed.sandbox.heartbeat({ scope, fence, lease }))
      .resolves.toEqual({ type: "lost" });
    vi.mocked(live.status).mockRejectedValueOnce(new Error("provider offline"));
    await expect(composed.sandbox.heartbeat({ scope, fence, lease }))
      .resolves.toEqual({ type: "lost" });
  });

  it("suspends a runtime and serializes provider metadata deterministically", async () => {
    const live = runtime("suspend-metadata", {
      suspend: vi.fn(async () => ({
        provider: "e2b",
        checkpointId: "suspend-metadata",
        sourceRuntimeId: "suspend-metadata",
        kind: "memory",
        scope: "runtime",
        metadata: { z: "last", a: "first" },
      } satisfies SandboxCheckpointHandle)),
    });
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    const suspended = await composed.sandbox.suspend({
      scope,
      fence,
      lease,
      signal: new AbortController().signal,
    });
    const serialized = String(suspended.metadata?.[checkpointMetadataKey]);
    expect(serialized.indexOf('"a"')).toBeLessThan(serialized.indexOf('"z"'));
    await expect(composed.sandbox.inspect(lease)).resolves.toEqual({ state: "running" });
  });

  it("fails closed when retained suspend is not configured", async () => {
    const composed = composition(provider(), {
      workspace: { strategies: ["retained_runtime"] },
    });
    const lease = await acquire(composed);
    await expect(composed.sandbox.suspend({
      scope,
      fence,
      lease,
      signal: new AbortController().signal,
    })).rejects.toThrow(/no retained-runtime suspend kind/i);
  });

  it("rejects an abort that races suspension without publishing the checkpoint", async () => {
    const controller = new AbortController();
    const reason = new Error("fence lost during suspend");
    const live = runtime("suspend-race", {
      suspend: vi.fn(async () => {
        controller.abort(reason);
        return {
          provider: "e2b",
          checkpointId: "suspend-race",
          sourceRuntimeId: "suspend-race",
          kind: "memory",
          scope: "runtime",
        } satisfies SandboxCheckpointHandle;
      }),
    });
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    await expect(composed.sandbox.suspend({
      scope,
      fence,
      lease,
      signal: controller.signal,
    })).rejects.toBe(reason);
    await expect(composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: await binding(composed),
      sandbox: lease,
      idempotencyKey: "no-racy-checkpoint",
      signal: new AbortController().signal,
    })).rejects.toThrow(/missing its checkpoint metadata/i);
  });

  it("requires destroy when hard termination is advertised", async () => {
    const live = runtime("no-destroy", { destroy: undefined });
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    await expect(composed.sandbox.terminate({
      scope,
      fence,
      lease,
      reason: "completed",
    })).rejects.toThrow(/hard termination.*no destroy/i);
  });

  it("allows detach-only termination when hard termination is unsupported", async () => {
    const live = runtime("detach-only", { destroy: undefined });
    const composed = composition(provider(live), {
      sandboxCapabilities: {
        suspendResume: "unsupported",
        hardTerminate: "best_effort",
        runtimeCheckpoints: [],
      },
    });
    const lease = await acquire(composed);
    await expect(composed.sandbox.terminate({
      scope,
      fence,
      lease,
      reason: "completed",
    })).resolves.toBeUndefined();
    await expect(composed.sandbox.inspect(lease)).resolves.toEqual({ state: "unknown" });
  });

  it("rejects incompatible or unattached sandbox leases", async () => {
    const composed = composition();
    await expect(composed.sandbox.inspect({ provider: "wrong", runtimeId: "x" }))
      .resolves.toEqual({ state: "unknown" });
    await expect(composed.sandbox.terminate({
      scope,
      fence,
      lease: { provider: "wrong", runtimeId: "x" },
      reason: "failed",
    })).rejects.toThrow(/incompatible sandbox lease provider/i);
    await expect(composed.sandbox.terminate({
      scope,
      fence,
      lease: { provider: "e2b", runtimeId: "missing" },
      reason: "failed",
    })).rejects.toThrow(/not attached/i);
  });

  it("supports provider-specific orphan reaping and rejects wrong-provider orphans", async () => {
    const reapRuntime = vi.fn(async () => {});
    const composed = composition(provider(), { reapRuntime });
    const lease = { provider: "e2b", runtimeId: "orphan" };
    await composed.sandbox.reap({ scope, lease, reason: "lease_lost" });
    expect(reapRuntime).toHaveBeenCalledWith(expect.objectContaining({ scope, lease }));
    await composed.sandbox.reap({ scope, lease, reason: "lease_lost" });
    expect(reapRuntime).toHaveBeenCalledOnce();

    await expect(composition().sandbox.reap({
      scope,
      lease: { provider: "wrong", runtimeId: "orphan" },
      reason: "failed",
    })).rejects.toThrow(/incompatible sandbox lease provider/i);
  });

  it("reaps attached runtimes and fails closed if a resumed orphan cannot be destroyed", async () => {
    const attached = runtime("attached-orphan");
    const composed = composition(provider(attached));
    const attachedLease = await acquire(composed);
    await composed.sandbox.reap({ scope, lease: attachedLease, reason: "failed" });
    expect(attached.destroy).toHaveBeenCalledOnce();

    const resumed = runtime("undestroyable-orphan", { destroy: undefined });
    const selected = provider(resumed);
    const orphaned = composition(selected);
    await expect(orphaned.sandbox.reap({
      scope,
      lease: { provider: "e2b", runtimeId: "undestroyable-orphan" },
      reason: "failed",
    })).rejects.toThrow(/reaping requires a destroy method/i);
  });
});

describe("provider workspace persistence validation", () => {
  it("rejects unsupported strategies", async () => {
    const composed = composition(provider(), {
      workspace: { strategies: ["retained_runtime"] },
    });
    await expect(composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "unsupported",
      signal: new AbortController().signal,
    })).rejects.toThrow(/does not support checkpoint_restore/i);
    await expect(composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "host_copy" as never,
      binding: { bindingId: "x", mountPath: "/workspace" },
      sandbox: { provider: "e2b", runtimeId: "x" },
      idempotencyKey: "unsupported-checkpoint",
      signal: new AbortController().signal,
    })).rejects.toThrow(/does not support host_copy/i);
  });

  it.each([
    [undefined, /missing its checkpoint metadata/i],
    ["{", /invalid JSON/i],
    ["null", /must be an object/i],
    [JSON.stringify({ provider: "wrong", checkpointId: "c", sourceRuntimeId: "r", kind: "memory", scope: "runtime" }), /incompatible shape/i],
    [JSON.stringify({ provider: "e2b", checkpointId: "", sourceRuntimeId: "r", kind: "memory", scope: "runtime" }), /incompatible shape/i],
    [JSON.stringify({ provider: "e2b", checkpointId: "c", sourceRuntimeId: "", kind: "memory", scope: "runtime" }), /incompatible shape/i],
    [JSON.stringify({ provider: "e2b", checkpointId: "c", sourceRuntimeId: "r", kind: "disk", scope: "runtime" }), /incompatible shape/i],
    [JSON.stringify({ provider: "e2b", checkpointId: "c", sourceRuntimeId: "r", kind: "memory", scope: "global" }), /incompatible shape/i],
  ])("rejects invalid serialized checkpoint metadata %#", async (metadata, message) => {
    const composed = composition();
    await expect(composed.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: candidate(metadata),
      idempotencyKey: "invalid-checkpoint",
      signal: new AbortController().signal,
    })).rejects.toThrow(message);
  });

  it("rejects checkpoint scope mismatches in both directions", async () => {
    const live = runtime("scope-mismatch");
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    const retainedLease = await composed.sandbox.suspend({
      scope,
      fence,
      lease,
      signal: new AbortController().signal,
    });
    const retained = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: await binding(composed),
      sandbox: retainedLease,
      idempotencyKey: "retained",
      signal: new AbortController().signal,
    });
    await expect(composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: retained,
      idempotencyKey: "wrong-portable",
      signal: new AbortController().signal,
    })).rejects.toThrow(/scope runtime.*checkpoint_restore/i);

    const portable = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "checkpoint_restore",
      binding: await binding(composed, "checkpoint_restore"),
      sandbox: lease,
      idempotencyKey: "portable",
      signal: new AbortController().signal,
    });
    await expect(composed.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: portable,
      idempotencyKey: "wrong-runtime",
      signal: new AbortController().signal,
    })).rejects.toThrow(/scope portable.*retained_runtime/i);
  });

  it("requires an explicit portable checkpoint kind", async () => {
    const live = runtime("no-portable-kind");
    const composed = composition(provider(live), {
      workspace: { strategies: ["checkpoint_restore"] },
    });
    const lease = await acquire(composed, { strategy: "checkpoint_restore" });
    await expect(composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "checkpoint_restore",
      binding: await binding(composed, "checkpoint_restore"),
      sandbox: lease,
      idempotencyKey: "missing-kind",
      signal: new AbortController().signal,
    })).rejects.toThrow(/no portable checkpoint kind/i);
  });

  it("can checkpoint retained state supplied only on a serialized lease", async () => {
    const composed = composition();
    const checkpoint = {
      provider: "e2b",
      checkpointId: "retained-serialized",
      sourceRuntimeId: "retained-runtime",
      kind: "memory",
      scope: "runtime",
    } satisfies SandboxCheckpointHandle;
    const result = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: await binding(composed),
      sandbox: {
        provider: "e2b",
        runtimeId: "retained-runtime",
        metadata: { [checkpointMetadataKey]: JSON.stringify(checkpoint) },
      },
      idempotencyKey: "serialized-retained",
      signal: new AbortController().signal,
    });
    expect(result.metadata?.[checkpointMetadataKey]).toBe(JSON.stringify(checkpoint));
  });

  it("release detaches both empty and acquired workspace bindings", async () => {
    const live = runtime("released-runtime");
    const composed = composition(provider(live));
    const empty = await binding(composed);
    await composed.workspace.release({ scope, fence, binding: empty });
    const attached = await binding(composed);
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan,
      workspace: attached,
      outputs: null,
      signal: new AbortController().signal,
    });
    await composed.workspace.release({ scope, fence, binding: attached });
    await expect(composed.sandbox.inspect(lease)).resolves.toEqual({ state: "unknown" });
  });
});

describe("provider process checkpoint validation", () => {
  function checkpointInput(sandbox = { provider: "e2b", runtimeId: "checkpoint-runtime" }) {
    return {
      scope,
      fence,
      sandbox,
      kind: "process" as const,
      workspaceRevision: 3,
      harnessVersion: "pi@1",
      runtimeIdentity: "pi-session-1",
    };
  }

  function checkpointRef(overrides: Partial<RuntimeCheckpointRef> = {}): RuntimeCheckpointRef {
    return {
      provider: "e2b",
      checkpointId: "process-checkpoint",
      kind: "process",
      sourceRuntimeId: "checkpoint-runtime",
      sessionId: scope.sessionId,
      workGeneration: fence.generation,
      workspaceRevision: 3,
      harnessVersion: "pi@1",
      runtimeIdentity: "pi-session-1",
      ...overrides,
    };
  }

  it.each([
    [{ provider: "wrong", checkpointId: "c", sourceRuntimeId: "checkpoint-runtime" }, /incompatible runtime checkpoint/i],
    [{ provider: "e2b", checkpointId: "", sourceRuntimeId: "checkpoint-runtime" }, /incompatible runtime checkpoint/i],
    [{ provider: "e2b", checkpointId: "c", sourceRuntimeId: "" }, /incompatible runtime checkpoint/i],
    [{ provider: "e2b", checkpointId: "c", sourceRuntimeId: "other" }, /source runtime mismatch/i],
  ])("rejects malformed provider process checkpoints %#", async (partial, message) => {
    const live = runtime("checkpoint-runtime");
    const create = vi.fn(async () => ({
      kind: "memory",
      scope: "portable",
      ...partial,
    } as SandboxCheckpointHandle));
    const composed = composition(provider(live), {
      runtimeCheckpoint: {
        kind: "process",
        create,
        restore: vi.fn(async () => live),
      },
    });
    const lease = await acquire(composed);
    await expect(composed.runtimeCheckpoint!.create(checkpointInput(lease)))
      .rejects.toThrow(message);
  });

  it("rejects incompatible checkpoint refs before provider restore", async () => {
    const restore = vi.fn(async () => runtime("restored"));
    const composed = composition(provider(), {
      runtimeCheckpoint: {
        kind: "process",
        create: vi.fn(),
        restore,
      },
    });
    await expect(composed.runtimeCheckpoint!.restore({
      scope,
      fence,
      checkpoint: checkpointRef({ provider: "wrong" }),
    })).rejects.toThrow(/incompatible provider runtime checkpoint/i);
    await expect(composed.runtimeCheckpoint!.restore({
      scope,
      fence,
      checkpoint: checkpointRef({ kind: "filesystem" }),
    })).rejects.toThrow(/incompatible provider runtime checkpoint/i);
    expect(restore).not.toHaveBeenCalled();
  });

  it("destroys an incompatible restored process and preserves the admission failure", async () => {
    const invalid = runtime("restored-invalid", {
      runtimeHandle: () => ({ provider: "wrong", runtimeId: "restored-invalid" }),
      destroy: vi.fn(async () => {
        throw new Error("destroy also failed");
      }),
    });
    const composed = composition(provider(), {
      runtimeCheckpoint: {
        kind: "process",
        create: vi.fn(),
        restore: vi.fn(async () => invalid),
      },
    });
    await expect(composed.runtimeCheckpoint!.restore({
      scope,
      fence,
      checkpoint: checkpointRef(),
    })).rejects.toThrow(/incompatible runtime/i);
    expect(invalid.destroy).toHaveBeenCalledOnce();
  });

  it("treats a restored provider id as a new live generation", async () => {
    const first = runtime("checkpoint-runtime");
    const restored = runtime("checkpoint-runtime");
    const composed = composition(provider(first), {
      runtimeCheckpoint: {
        kind: "process",
        create: vi.fn(),
        restore: vi.fn(async () => restored),
      },
    });
    const lease = await acquire(composed);
    await composed.sandbox.terminate({ scope, fence, lease, reason: "completed" });
    const restoredLease = await composed.runtimeCheckpoint!.restore({
      scope,
      fence: { ...fence, generation: 2 },
      checkpoint: checkpointRef(),
    });
    await composed.sandbox.terminate({
      scope,
      fence: { ...fence, generation: 2 },
      lease: restoredLease,
      reason: "completed",
    });
    expect(restored.destroy).toHaveBeenCalledOnce();
  });
});
