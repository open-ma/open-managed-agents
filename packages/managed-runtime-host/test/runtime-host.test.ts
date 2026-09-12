import { describe, expect, it, vi } from "vitest";

import * as runtimeHostModule from "../src/index";
import { MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

const directDriver = {
  type: "ama_worker" as const,
  process: {
    command: "node",
    args: ["worker.mjs"],
  },
};

const durableProfile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "durable" as const },
  runtimeCheckpoint: "optional" as const,
  driver: directDriver,
};

function exportedFunction(name: string): (...args: any[]) => any {
  const candidate = (runtimeHostModule as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeTypeOf("function");
  return candidate as (...args: any[]) => any;
}

describe("managed runtime plan", () => {
  it("selects semantic strategies without branching on a provider name", () => {
    const resolveManagedRuntimePlan = exportedFunction("resolveManagedRuntimePlan");

    expect(
      resolveManagedRuntimePlan(durableProfile, {
        sandbox: {
          hardTerminate: "supported",
          suspendResume: "unsupported",
          runtimeCheckpoints: [],
        },
        workspace: {
          strategies: ["checkpoint_restore", "ephemeral"],
        },
        outputs: {
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        },
        harness: { drivers: ["ama_worker"] },
      }),
    ).toEqual({
      workspaceStrategy: "checkpoint_restore",
      outputStrategy: "final_collect",
      runtimeCheckpoint: null,
      driver: directDriver,
    });
  });

  it("rejects an unavailable durable workspace before acquiring resources", () => {
    const resolveManagedRuntimePlan = exportedFunction("resolveManagedRuntimePlan");

    expect(() =>
      resolveManagedRuntimePlan(durableProfile, {
        sandbox: {
          hardTerminate: "supported",
          suspendResume: "supported",
          runtimeCheckpoints: ["filesystem"],
        },
        workspace: { strategies: ["retained_runtime", "ephemeral"] },
        outputs: {
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        },
        harness: { drivers: ["ama_worker"] },
      }),
    ).toThrow(/durable workspace/i);
  });

  it("covers explicit strategy preferences and every capability requirement", () => {
    const resolveManagedRuntimePlan = exportedFunction("resolveManagedRuntimePlan");
    const capabilities = {
      sandbox: {
        hardTerminate: "supported",
        suspendResume: "supported",
        runtimeCheckpoints: ["filesystem"],
      },
      workspace: { strategies: ["retained_runtime", "ephemeral"] },
      outputs: {
        strategies: [{ strategy: "final_collect", durability: "best_effort" }],
      },
      harness: { drivers: ["ama_worker"] },
    };

    expect(resolveManagedRuntimePlan({
      workspace: {
        requirement: "continuable",
        preferredStrategies: ["durable_mount", "ephemeral", "retained_runtime"],
      },
      outputs: {
        requirement: "best_effort",
        preferredStrategies: ["final_collect"],
      },
      runtimeCheckpoint: "required",
      driver: directDriver,
    }, capabilities)).toMatchObject({
      workspaceStrategy: "retained_runtime",
      outputStrategy: "final_collect",
      runtimeCheckpoint: "filesystem",
    });

    expect(resolveManagedRuntimePlan({
      workspace: { requirement: "ephemeral" },
      outputs: { requirement: "disabled" },
      runtimeCheckpoint: "disabled",
      driver: directDriver,
    }, capabilities)).toMatchObject({
      workspaceStrategy: "retained_runtime",
      outputStrategy: null,
      runtimeCheckpoint: null,
    });

    expect(() => resolveManagedRuntimePlan({
      workspace: { requirement: "continuable", preferredStrategies: ["durable_mount"] },
      outputs: { requirement: "disabled" },
      runtimeCheckpoint: "disabled",
      driver: directDriver,
    }, capabilities)).toThrow(/continuable workspace/i);
    expect(() => resolveManagedRuntimePlan({
      workspace: { requirement: "ephemeral" },
      outputs: { requirement: "durable" },
      runtimeCheckpoint: "disabled",
      driver: directDriver,
    }, capabilities)).toThrow(/durable Session outputs/i);
    expect(() => resolveManagedRuntimePlan({
      workspace: { requirement: "ephemeral" },
      outputs: { requirement: "disabled" },
      runtimeCheckpoint: "required",
      driver: directDriver,
    }, { ...capabilities, sandbox: { ...capabilities.sandbox, runtimeCheckpoints: [] } }))
      .toThrow(/runtime checkpoint/i);
    expect(() => resolveManagedRuntimePlan({
      workspace: { requirement: "ephemeral" },
      outputs: { requirement: "disabled" },
      runtimeCheckpoint: "disabled",
      driver: { ...directDriver, type: "openma_supervised" },
    }, capabilities)).toThrow(/openma_supervised harness driver/i);
  });
});

describe("managed runtime lifecycle", () => {
  it("renews the resource fence while slow resources materialize before a sandbox exists", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const fence = {
      ...scope,
      ownerId: "worker_1",
      generation: 1,
      token: "fence_1",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    let releaseMaterialize!: () => void;
    const materializeMayFinish = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    let sleeps = 0;
    const renew = vi.fn(async () => {
      releaseMaterialize();
      return { type: "renewed", fence } as const;
    });

    const host = createManagedRuntimeHost({
      ownerId: "worker_1",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: async (_ms: number, signal: AbortSignal) => {
          if (sleeps++ === 0) return;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      },
      fences: {
        acquire: vi.fn(async () => ({ type: "acquired", fence, publication: null })),
        renew,
        publish: vi.fn(async () => ({ type: "published", revision: 1 })),
        release: vi.fn(async () => {}),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported",
          suspendResume: "unsupported",
          runtimeCheckpoints: [],
        })),
        acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime_1" })),
        heartbeat: vi.fn(async () => ({ type: "alive" })),
        terminate: vi.fn(async () => {}),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
        materialize: vi.fn(async () => {
          await materializeMayFinish;
          return { mountPath: "/workspace", bindingId: "workspace-binding" };
        }),
        attach: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => ({
          id: "workspace-candidate",
          contentHash: "sha256:workspace",
          revision: 1,
        })),
        release: vi.fn(async () => {}),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
        prepare: vi.fn(),
        attach: vi.fn(),
        collect: vi.fn(),
        finalize: vi.fn(),
        release: vi.fn(),
        abort: vi.fn(),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
        run: vi.fn(async () => ({ type: "completed" })),
      },
    });

    await expect(
      host.run({
        scope,
        profile: {
          workspace: { requirement: "durable" },
          outputs: { requirement: "disabled" },
          runtimeCheckpoint: "disabled",
          driver: directDriver,
        },
      }),
    ).resolves.toEqual({ type: "completed", revision: 1 });
    expect(renew).toHaveBeenCalledTimes(1);
  }, 1_000);

  it("publishes immutable workspace and output candidates under the active fence", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const calls: string[] = [];
    const fence = {
      ...scope,
      ownerId: "worker_1",
      generation: 7,
      token: "fence_7",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const sandboxLease = { provider: "fake", runtimeId: "runtime_1" };

    const host = createManagedRuntimeHost({
      ownerId: "worker_1",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: (_ms: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      fences: {
        acquire: vi.fn(async () => {
          calls.push("fence.acquire");
          return { type: "acquired", fence };
        }),
        renew: vi.fn(),
        publish: vi.fn(async (input: any) => {
          calls.push("fence.publish");
          expect(input.fence).toEqual(fence);
          expect(input.workspaceCandidate.id).toBe("workspace-candidate-1");
          expect(input.outputCandidate.id).toBe("output-candidate-1");
          return { type: "published", revision: 11 };
        }),
        release: vi.fn(async () => calls.push("fence.release")),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported",
          suspendResume: "unsupported",
          runtimeCheckpoints: [],
        })),
        acquire: vi.fn(async (input: any) => {
          calls.push("sandbox.acquire");
          expect(input.workspace.mountPath).toBe("/workspace");
          expect(input.outputs.mountPath).toBe("/mnt/session/outputs");
          return sandboxLease;
        }),
        heartbeat: vi.fn(),
        terminate: vi.fn(async () => calls.push("sandbox.terminate")),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
        materialize: vi.fn(async () => {
          calls.push("workspace.materialize");
          return { mountPath: "/workspace", bindingId: "workspace-binding-1" };
        }),
        attach: vi.fn(async () => calls.push("workspace.attach")),
        checkpoint: vi.fn(async () => {
          calls.push("workspace.checkpoint");
          return {
            id: "workspace-candidate-1",
            contentHash: "sha256:workspace",
            revision: 10,
          };
        }),
        release: vi.fn(async () => calls.push("workspace.release")),
      },
      outputs: {
        capabilities: vi.fn(async () => ({
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        })),
        prepare: vi.fn(async () => {
          calls.push("outputs.prepare");
          return { mountPath: "/mnt/session/outputs", bindingId: "output-binding-1" };
        }),
        attach: vi.fn(async () => calls.push("outputs.attach")),
        collect: vi.fn(async () => {
          calls.push("outputs.collect");
          return [{ logicalPath: "report.md", contentHash: "sha256:report", size: 42 }];
        }),
        finalize: vi.fn(async () => {
          calls.push("outputs.finalize");
          return { id: "output-candidate-1", contentHash: "sha256:manifest", entries: 1 };
        }),
        abort: vi.fn(async () => calls.push("outputs.abort")),
        release: vi.fn(async () => calls.push("outputs.release")),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
        run: vi.fn(async (input: any) => {
          calls.push("harness.run");
          await input.checkpoint({
            checkpointId: "checkpoint_1",
            sessionId: scope.sessionId,
            turnId: "turn_1",
          });
          return { type: "completed" };
        }),
      },
    });

    await expect(host.run({ scope, profile: durableProfile })).resolves.toEqual({
      type: "completed",
      revision: 11,
    });
    expect(calls).toEqual([
      "fence.acquire",
      "workspace.materialize",
      "outputs.prepare",
      "sandbox.acquire",
      "workspace.attach",
      "outputs.attach",
      "harness.run",
      "workspace.checkpoint",
      "outputs.collect",
      "outputs.finalize",
      "fence.publish",
      "workspace.checkpoint",
      "outputs.collect",
      "outputs.finalize",
      "fence.publish",
      "sandbox.terminate",
      "outputs.release",
      "workspace.release",
      "fence.release",
    ]);
    expect(host).toBeDefined();
  });

  it("materializes the last published workspace candidate on a later generation", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const previousWorkspace = { id: "workspace-previous", contentHash: "sha256:previous" };
    const materialize = vi.fn(async () => ({
      mountPath: "/workspace",
      bindingId: "workspace-binding-2",
    }));
    const fence = {
      ...scope,
      ownerId: "worker_2",
      generation: 2,
      token: "fence_2",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const host = createManagedRuntimeHost({
      ownerId: "worker_2",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: (_ms: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      },
      fences: {
        acquire: vi.fn(async () => ({
          type: "acquired",
          fence,
          publication: {
            generation: 1,
            revision: 4,
            workspaceCandidate: previousWorkspace,
            outputCandidate: null,
          },
        })),
        renew: vi.fn(),
        publish: vi.fn(async () => ({ type: "published", revision: 5 })),
        release: vi.fn(async () => {}),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported",
          suspendResume: "unsupported",
          runtimeCheckpoints: [],
        })),
        acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime_2" })),
        heartbeat: vi.fn(),
        terminate: vi.fn(async () => {}),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
        materialize,
        attach: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => ({
          id: "workspace-next",
          contentHash: "sha256:next",
          revision: 5,
        })),
        release: vi.fn(async () => {}),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
        prepare: vi.fn(),
        attach: vi.fn(async () => {}),
        collect: vi.fn(),
        finalize: vi.fn(),
        abort: vi.fn(),
        release: vi.fn(async () => {}),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
        run: vi.fn(async () => ({ type: "completed" })),
      },
    });

    await host.run({
      scope,
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "disabled" },
        runtimeCheckpoint: "disabled",
        driver: directDriver,
      },
    });
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ activeCheckpoint: previousWorkspace }),
    );
  });

  it("aborts the hand and never publishes after the resource fence is lost", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const fence = {
      ...scope,
      ownerId: "worker_1",
      generation: 3,
      token: "fence_3",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    let sleepCount = 0;
    const publish = vi.fn();
    const checkpoint = vi.fn();
    const finalize = vi.fn();

    const host = createManagedRuntimeHost({
      ownerId: "worker_1",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: async (_ms: number, signal: AbortSignal) => {
          if (sleepCount++ === 0) return;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
      fences: {
        acquire: vi.fn(async () => ({ type: "acquired", fence })),
        renew: vi.fn(async () => ({ type: "lost" })),
        publish,
        release: vi.fn(async () => {}),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported",
          suspendResume: "unsupported",
          runtimeCheckpoints: [],
        })),
        acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime_1" })),
        heartbeat: vi.fn(async () => ({ type: "alive" })),
        terminate: vi.fn(async () => {}),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
        materialize: vi.fn(async () => ({
          mountPath: "/workspace",
          bindingId: "workspace-binding-1",
        })),
        attach: vi.fn(async () => {}),
        checkpoint,
        release: vi.fn(async () => {}),
      },
      outputs: {
        capabilities: vi.fn(async () => ({
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        })),
        prepare: vi.fn(async () => ({
          mountPath: "/mnt/session/outputs",
          bindingId: "output-binding-1",
        })),
        attach: vi.fn(async () => {}),
        collect: vi.fn(),
        finalize,
        abort: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
        run: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { type: "aborted" };
        }),
      },
    });

    await expect(host.run({ scope, profile: durableProfile })).resolves.toEqual({
      type: "lease_lost",
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("suspends and retains a runtime only after its candidate is published", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const calls: string[] = [];
    const fence = {
      ...scope,
      ownerId: "worker_1",
      generation: 1,
      token: "fence_1",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const lease = { provider: "e2b", runtimeId: "sandbox-1" };
    const runtimeCheckpoint = {
      provider: "e2b",
      checkpointId: "process-checkpoint-1",
      kind: "process" as const,
      sourceRuntimeId: "sandbox-1",
      sessionId: scope.sessionId,
      workGeneration: fence.generation,
      workspaceRevision: 1,
      harnessVersion: "ama-worker-v1",
      runtimeIdentity: "test-runtime",
    };
    const host = createManagedRuntimeHost({
      ownerId: "worker_1",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: (_ms: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      },
      fences: {
        acquire: vi.fn(async () => ({ type: "acquired", fence, publication: null })),
        renew: vi.fn(),
        publish: vi.fn(async () => {
          calls.push("fence.publish");
          return { type: "published", revision: 1 };
        }),
        release: vi.fn(async () => calls.push("fence.release")),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported",
          suspendResume: "supported",
          runtimeCheckpoints: ["process"],
        })),
        acquire: vi.fn(async () => lease),
        heartbeat: vi.fn(),
        suspend: vi.fn(async () => {
          calls.push("sandbox.suspend");
          return lease;
        }),
        terminate: vi.fn(async () => calls.push("sandbox.terminate")),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      runtimeCheckpoint: {
        create: vi.fn(async () => {
          calls.push("runtime.checkpoint");
          return runtimeCheckpoint;
        }),
        restore: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["retained_runtime"] })),
        materialize: vi.fn(async () => ({
          mountPath: "/workspace",
          bindingId: "workspace-binding",
        })),
        attach: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => {
          calls.push("workspace.checkpoint");
          return { id: "runtime-candidate", contentHash: "sha256:runtime", revision: 1 };
        }),
        release: vi.fn(async () => calls.push("workspace.release")),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
        prepare: vi.fn(),
        attach: vi.fn(),
        collect: vi.fn(),
        finalize: vi.fn(),
        release: vi.fn(),
        abort: vi.fn(),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
        run: vi.fn(async () => {
          calls.push("harness.run");
          return { type: "completed" };
        }),
      },
    });

    await expect(
      host.run({
        scope,
        profile: {
          workspace: { requirement: "continuable" },
          outputs: { requirement: "disabled" },
          runtimeCheckpoint: "optional",
          driver: directDriver,
        },
      }),
    ).resolves.toEqual({ type: "completed", revision: 1 });
    expect(calls).toEqual([
      "harness.run",
      "sandbox.suspend",
      "workspace.checkpoint",
      // Runtime checkpoints are created only after the canonical workspace
      // candidate exists, so the checkpoint records its revision.
      "runtime.checkpoint",
      "fence.publish",
      "workspace.release",
      "fence.release",
    ]);
    expect(calls).not.toContain("sandbox.terminate");
  });

  it("restores a compatible published process checkpoint before allocating a new runtime", async () => {
    const createManagedRuntimeHost = exportedFunction("createManagedRuntimeHost");
    const fence = {
      ...scope,
      ownerId: "worker_restore",
      generation: 2,
      token: "fence_restore",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const checkpoint = {
      provider: "fake",
      checkpointId: "process-checkpoint-1",
      kind: "process" as const,
      sourceRuntimeId: "runtime-previous",
      sessionId: scope.sessionId,
      workGeneration: 1,
      workspaceRevision: 1,
      harnessVersion: "ama-worker-v1",
      runtimeIdentity: JSON.stringify({
        process: { args: ["worker.mjs"], command: "node", envKeys: [] },
        type: "ama_worker",
      }),
    };
    const restoredLease = { provider: "fake", runtimeId: "runtime-restored" };
    const acquire = vi.fn(async () => restoredLease);
    const restore = vi.fn(async () => restoredLease);
    const host = createManagedRuntimeHost({
      ownerId: fence.ownerId,
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphans: new MemoryRuntimeOrphanPort(),
      scheduler: {
        sleep: (_ms: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      },
      fences: {
        acquire: vi.fn(async () => ({
          type: "acquired" as const,
          fence,
          publication: {
            generation: 1,
            revision: 1,
            workspaceCandidate: { id: "workspace-1", contentHash: "sha256:one" },
            outputCandidate: null,
            runtimeCheckpoint: checkpoint,
          },
        })),
        renew: vi.fn(),
        publish: vi.fn(async () => ({ type: "published" as const, revision: 2 })),
        release: vi.fn(async () => {}),
      },
      runtimeCheckpoint: { create: vi.fn(), restore },
      sandbox: {
        capabilities: vi.fn(async () => ({
          hardTerminate: "supported" as const,
          suspendResume: "unsupported" as const,
          runtimeCheckpoints: ["process" as const],
        })),
        acquire,
        heartbeat: vi.fn(async () => ({ type: "alive" as const })),
        terminate: vi.fn(async () => {}),
        reap: vi.fn(async () => {}),
        inspect: vi.fn(),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore" as const] })),
        materialize: vi.fn(async () => ({ mountPath: "/workspace", bindingId: "ws" })),
        attach: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => ({
          id: "workspace-next",
          contentHash: "sha256:next",
          revision: 2,
        })),
        release: vi.fn(async () => {}),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
        prepare: vi.fn(),
        attach: vi.fn(),
        collect: vi.fn(),
        finalize: vi.fn(),
        release: vi.fn(),
        abort: vi.fn(),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker" as const] })),
        run: vi.fn(async () => ({ type: "completed" as const })),
      },
    });

    await expect(host.run({
      scope,
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "disabled" },
        runtimeCheckpoint: "optional",
        driver: directDriver,
      },
    })).resolves.toEqual({ type: "completed", revision: 2 });
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ checkpoint }));
    expect(acquire).not.toHaveBeenCalled();
  });
});
