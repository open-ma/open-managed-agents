import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
} from "../src/index";
import { MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_fault",
  environmentId: "environment_fault",
  sessionId: "session_fault",
  workId: "work_fault",
};
const fence = {
  ...scope,
  ownerId: "fault-owner",
  generation: 1,
  token: "fault-secret",
  expiresAt: "2026-09-03T12:00:00.000Z",
};
const profile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "durable" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: {
    type: "ama_worker" as const,
    process: { command: "community-worker" },
  },
};

function blockedScheduler() {
  return {
    sleep: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  };
}

function fixture(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const base: any = {
    ownerId: "fault-owner",
    leaseTtlMs: 90_000,
    heartbeatIntervalMs: 30_000,
    scheduler: blockedScheduler(),
    orphans: new MemoryRuntimeOrphanPort(),
    fences: {
      acquire: vi.fn(async () => ({ type: "acquired", fence, publication: null })),
      renew: vi.fn(async () => ({ type: "renewed", fence })),
      publish: vi.fn(async () => ({ type: "published", revision: 1 })),
      release: vi.fn(async ({ reason }: { reason: string }) => calls.push(`release:${reason}`)),
    },
    sandbox: {
      capabilities: vi.fn(async () => ({
        suspendResume: "unsupported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      })),
      acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime-fault" })),
      heartbeat: vi.fn(async () => ({ type: "alive" })),
      suspend: vi.fn(),
      terminate: vi.fn(async ({ reason }: { reason: string }) =>
        calls.push(`terminate:${reason}`)
      ),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
      materialize: vi.fn(async () => ({
        bindingId: "workspace-fault",
        mountPath: "/workspace",
      })),
      attach: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({
        id: "workspace-candidate",
        contentHash: "sha256:workspace",
        revision: 1,
      })),
      release: vi.fn(async () => calls.push("workspace.release")),
    },
    outputs: {
      capabilities: vi.fn(async () => ({
        strategies: [{ strategy: "final_collect", durability: "durable" }],
      })),
      prepare: vi.fn(async () => ({
        bindingId: "outputs-fault",
        mountPath: "/mnt/session/outputs",
      })),
      attach: vi.fn(async () => {}),
      collect: vi.fn(async () => []),
      finalize: vi.fn(async () => ({
        id: "outputs-candidate",
        contentHash: "sha256:outputs",
        entries: 0,
      })),
      release: vi.fn(async () => calls.push("outputs.release")),
      abort: vi.fn(async ({ reason }: { reason: string }) => calls.push(`outputs.abort:${reason}`)),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
      run: vi.fn(async () => ({ type: "completed" })),
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = typeof value === "object" && value !== null
      ? { ...base[key], ...value }
      : value;
  }
  return { dependencies: base, calls };
}

describe("Managed Runtime Host fault matrix", () => {
  it("fences and aborts outputs when a live turn checkpoint loses ownership", async () => {
    const { dependencies } = fixture({
      fences: {
        publish: vi.fn(async () => ({ type: "lost" })),
      },
      harnessDriver: {
        run: vi.fn(async (input: any) => {
          await input.checkpoint({
            checkpointId: "checkpoint_turn_1",
            sessionId: scope.sessionId,
            turnId: "turn_1",
          });
          return { type: "completed" };
        }),
      },
    });

    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.workspace.checkpoint).toHaveBeenCalledOnce();
    expect(dependencies.outputs.finalize).toHaveBeenCalledOnce();
    expect(dependencies.outputs.abort).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "lease_lost" }),
    );
    expect(dependencies.sandbox.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "lease_lost" }),
    );
  });

  it.each([
    ["empty id", [{ checkpointId: "", sessionId: scope.sessionId }]],
    ["cross-session", [{ checkpointId: "checkpoint_wrong_session", sessionId: "session_intruder" }]],
    ["duplicate", [
      { checkpointId: "checkpoint_duplicate", sessionId: scope.sessionId },
      { checkpointId: "checkpoint_duplicate", sessionId: scope.sessionId },
    ]],
  ] as const)("rejects an invalid live checkpoint: %s", async (_name, checkpoints) => {
    const { dependencies } = fixture({
      harnessDriver: {
        run: vi.fn(async (input: any) => {
          for (const checkpoint of checkpoints) await input.checkpoint(checkpoint);
          return { type: "completed" };
        }),
      },
    });

    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toMatchObject({
        type: "failed",
        error: expect.objectContaining({
          message: "Harness requested an invalid or duplicate live checkpoint",
        }),
      });
  });

  it("checkpoints a live turn when Session output persistence is disabled", async () => {
    const { dependencies } = fixture({
      harnessDriver: {
        run: vi.fn(async (input: any) => {
          await input.checkpoint({
            checkpointId: "checkpoint_without_outputs",
            sessionId: scope.sessionId,
          });
          return { type: "completed" };
        }),
      },
    });

    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: { ...profile, outputs: { requirement: "disabled" } },
    })).resolves.toEqual({ type: "completed", revision: 1 });
    expect(dependencies.outputs.prepare).not.toHaveBeenCalled();
    expect(dependencies.outputs.collect).not.toHaveBeenCalled();
    expect(dependencies.outputs.finalize).not.toHaveBeenCalled();
    expect(dependencies.fences.publish).toHaveBeenCalledTimes(2);
  });

  it("accepts an empty Session resource set without a materializer", async () => {
    const { dependencies } = fixture();
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [],
      },
    })).resolves.toEqual({ type: "completed", revision: 1 });
  });

  it("rejects an advertised runtime-checkpoint strategy when its Port is absent", async () => {
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: ["process"],
        })),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: { ...profile, runtimeCheckpoint: "optional" },
    })).rejects.toThrow(/does not provide RuntimeCheckpointPort/u);
    expect(dependencies.fences.acquire).not.toHaveBeenCalled();
  });

  it("fails the fenced transaction when required credential egress cannot be prepared", async () => {
    const { dependencies } = fixture({
      credentialEgress: {
        capabilities: vi.fn(async () => ({ enforcement: "enforced" })),
        prepare: vi.fn(async () => null),
        attach: vi.fn(),
        revoke: vi.fn(),
        release: vi.fn(),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: {
        ...profile,
        credentialEgress: { requirement: "required" },
      },
    })).resolves.toMatchObject({
      type: "failed",
      error: expect.objectContaining({
        message: "Required credential egress could not be prepared for this Session",
      }),
    });
    expect(dependencies.sandbox.acquire).not.toHaveBeenCalled();
  });

  it("fences an execution that was cancelled before resource materialization", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const { dependencies } = fixture();
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile,
      signal: controller.signal,
    })).resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.harnessDriver.run).not.toHaveBeenCalled();
    expect(dependencies.fences.release).toHaveBeenCalledWith(expect.objectContaining({
      reason: "lease_lost",
    }));
  });

  it("handles cancellation that races a completed scheduler sleep", async () => {
    const controller = new AbortController();
    const { dependencies } = fixture({
      scheduler: {
        sleep: vi.fn(async () => { controller.abort(new Error("cancelled while asleep")); }),
      },
      workspace: {
        materialize: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { bindingId: "workspace-fault", mountPath: "/workspace" };
        }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile,
      signal: controller.signal,
    })).resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.fences.renew).not.toHaveBeenCalled();
  });

  it("aborts the active harness when the provider reports its sandbox lease lost", async () => {
    let sandboxReady!: () => void;
    const ready = new Promise<void>((resolve) => { sandboxReady = resolve; });
    let wakeHeartbeat!: () => void;
    const mayHeartbeat = new Promise<void>((resolve) => { wakeHeartbeat = resolve; });
    const { dependencies } = fixture({
      scheduler: {
        sleep: vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
          await Promise.race([
            mayHeartbeat,
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
          ]);
        }),
      },
      sandbox: {
        acquire: vi.fn(async () => {
          sandboxReady();
          return { provider: "fake", runtimeId: "runtime-fault" };
        }),
        heartbeat: vi.fn(async () => ({ type: "lost" })),
      },
      harnessDriver: {
        run: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
          await ready;
          wakeHeartbeat();
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { type: "aborted" };
        }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.sandbox.heartbeat).toHaveBeenCalledOnce();
  });

  it.each(["scheduler", "fence"])("turns a %s heartbeat failure into lease loss", async (failureAt) => {
    const failure = new Error(`${failureAt} heartbeat failed`);
    const { dependencies } = fixture({
      scheduler: {
        sleep: vi.fn(async () => {
          if (failureAt === "scheduler") throw failure;
        }),
      },
      fences: {
        renew: vi.fn(async () => {
          if (failureAt === "fence") throw failure;
          return { type: "renewed", fence };
        }),
      },
      workspace: {
        materialize: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { bindingId: "workspace-fault", mountPath: "/workspace" };
        }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toEqual({ type: "lease_lost" });
  });

  it("passes an omitted Session content accessor through the materializer boundary", async () => {
    const materialize = vi.fn(async () => undefined);
    const { dependencies } = fixture({
      sessionInputs: { materialize },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          id: "resource_file",
          type: "file",
          file_id: "file_01",
          mount_path: "/workspace/input.txt",
        }],
      },
    })).resolves.toEqual({ type: "completed", revision: 1 });
    expect(materialize).toHaveBeenCalledWith(expect.not.objectContaining({ access: expect.anything() }));
  });

  it("passes a provided Session content accessor through unchanged", async () => {
    const access = { downloadFile: vi.fn() };
    const materialize = vi.fn(async () => undefined);
    const { dependencies } = fixture({ sessionInputs: { materialize } });
    await createManagedRuntimeHost(dependencies).run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [],
      },
      sessionInputAccess: access,
    });
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ access }));
  });

  it("uses the default heartbeat scheduler for both timer wake and cleanup cancellation", async () => {
    vi.useFakeTimers();
    try {
      let harnessStarted!: () => void;
      const started = new Promise<void>((resolve) => { harnessStarted = resolve; });
      let fenceRenewed!: () => void;
      const renewed = new Promise<void>((resolve) => { fenceRenewed = resolve; });
      const { dependencies } = fixture({
        fences: {
          renew: vi.fn(async () => {
            fenceRenewed();
            return { type: "renewed", fence };
          }),
        },
        sandbox: {
          heartbeat: vi.fn(async () => ({ type: "alive" })),
        },
        harnessDriver: {
          run: vi.fn(async () => {
            harnessStarted();
            await renewed;
            return { type: "completed" };
          }),
        },
      });
      dependencies.scheduler = undefined;
      dependencies.heartbeatIntervalMs = 10;
      const running = createManagedRuntimeHost(dependencies).run({ scope, profile });
      await started;
      const expectation = expect(running).resolves.toEqual({ type: "completed", revision: 1 });
      await vi.advanceTimersByTimeAsync(10);
      await expectation;
      expect(dependencies.fences.renew).toHaveBeenCalledOnce();
      expect(dependencies.sandbox.heartbeat).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a compatible runtime checkpoint with the process identity", async () => {
    const create = vi.fn(async (input: any) => ({
      provider: input.sandbox.provider,
      checkpointId: "checkpoint_1",
      kind: input.kind,
      sourceRuntimeId: input.sandbox.runtimeId,
      sessionId: input.scope.sessionId,
      workGeneration: input.fence.generation,
      workspaceRevision: input.workspaceRevision,
      harnessVersion: input.harnessVersion,
      runtimeIdentity: input.runtimeIdentity,
    }));
    const publish = vi.fn(async () => ({ type: "published", revision: 1 }));
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: ["process"],
        })),
      },
      runtimeCheckpoint: { create, restore: vi.fn() },
      fences: { publish },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: {
        ...profile,
        runtimeCheckpoint: "required",
        driver: {
          ...profile.driver,
          process: {
            command: "community-worker",
            cwd: "/workspace/project",
            env: { TOKEN: "must-not-be-persisted" },
          },
        },
      },
    })).resolves.toEqual({ type: "completed", revision: 1 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      harnessVersion: "ama-worker-v1",
      runtimeIdentity: expect.stringContaining("/workspace/project"),
    }));
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("must-not-be-persisted");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      runtimeCheckpoint: expect.objectContaining({ checkpointId: "checkpoint_1" }),
    }));
  });

  it("falls back to a fresh sandbox when a compatible checkpoint cannot be restored", async () => {
    const restoreFailure = new Error("provider restore failed");
    const restore = vi.fn(async () => { throw restoreFailure; });
    const acquire = vi.fn(async () => ({ provider: "fake", runtimeId: "runtime-fresh" }));
    const { dependencies } = fixture({
      fences: {
        acquire: vi.fn(async () => ({
          type: "acquired",
          fence,
          publication: {
            generation: 0,
            revision: 1,
            workspaceCandidate: { id: "workspace-old", contentHash: "sha256:old" },
            outputCandidate: null,
            runtimeCheckpoint: {
              provider: "fake",
              checkpointId: "checkpoint-old",
              kind: "process",
              sourceRuntimeId: "runtime-old",
              sessionId: scope.sessionId,
              workGeneration: 0,
              workspaceRevision: 1,
              harnessVersion: "ama-worker-v1",
              runtimeIdentity: JSON.stringify({
                process: { command: "community-worker", envKeys: [] },
                type: "ama_worker",
              }),
            },
          },
        })),
      },
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: ["process"],
        })),
        acquire,
      },
      runtimeCheckpoint: {
        restore,
        create: vi.fn(async () => { throw new Error("fresh snapshot unavailable"); }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: { ...profile, runtimeCheckpoint: "optional" },
    })).resolves.toEqual({ type: "completed", revision: 1 });
    expect(restore).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
  });

  it.each([
    ["optional", "completed"],
    ["required", "failed"],
  ] as const)("handles a mismatched runtime-checkpoint workspace revision in %s mode", async (mode, outcome) => {
    const publish = vi.fn(async () => ({ type: "published", revision: 1 }));
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: ["process"],
        })),
      },
      runtimeCheckpoint: {
        create: vi.fn(async (input: any) => ({
          provider: input.sandbox.provider,
          checkpointId: "checkpoint_bad",
          kind: input.kind,
          sourceRuntimeId: input.sandbox.runtimeId,
          sessionId: input.scope.sessionId,
          workGeneration: input.fence.generation,
          workspaceRevision: input.workspaceRevision + 1,
          harnessVersion: input.harnessVersion,
          runtimeIdentity: input.runtimeIdentity,
        })),
        restore: vi.fn(),
      },
      fences: { publish },
    });
    const result = await createManagedRuntimeHost(dependencies).run({
      scope,
      profile: { ...profile, runtimeCheckpoint: mode },
    });
    expect(result.type).toBe(outcome);
    if (mode === "optional") {
      expect(publish).toHaveBeenCalledWith(expect.not.objectContaining({
        runtimeCheckpoint: expect.anything(),
      }));
    } else {
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it("fails a required runtime checkpoint when the provider cannot create it", async () => {
    const failure = new Error("snapshot backend unavailable");
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: ["process"],
        })),
      },
      runtimeCheckpoint: {
        create: vi.fn(async () => { throw failure; }),
        restore: vi.fn(),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: { ...profile, runtimeCheckpoint: "required" },
    })).resolves.toEqual({ type: "failed", error: failure });
  });

  it("records a non-Error provider termination failure as an orphan", async () => {
    const enqueue = vi.fn(async () => undefined);
    const { dependencies } = fixture({
      sandbox: { terminate: vi.fn(async () => { throw "provider disconnected"; }) },
      orphans: { enqueue, list: vi.fn(), resolved: vi.fn(), failed: vi.fn() },
    });
    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toEqual({ type: "completed", revision: 1 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      error: "provider disconnected",
    }));
  });

  it("surfaces failure to persist an orphan after completing all remaining cleanup", async () => {
    const persistenceFailure = new Error("orphan store unavailable");
    const { dependencies, calls } = fixture({
      sandbox: { terminate: vi.fn(async () => { throw new Error("terminate failed"); }) },
      orphans: {
        enqueue: vi.fn(async () => { throw persistenceFailure; }),
        list: vi.fn(),
        resolved: vi.fn(),
        failed: vi.fn(),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .rejects.toBe(persistenceFailure);
    expect(calls).toEqual([
      "outputs.release",
      "workspace.release",
      "release:completed",
    ]);
  });

  it("treats ordinary release failures as bounded best-effort cleanup", async () => {
    const { dependencies } = fixture({
      outputs: {
        release: vi.fn(async () => { throw new Error("output release failed"); }),
      },
      workspace: {
        release: vi.fn(async () => { throw new Error("workspace release failed"); }),
      },
      fences: {
        release: vi.fn(async () => { throw new Error("fence release failed"); }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({ scope, profile }))
      .resolves.toEqual({ type: "completed", revision: 1 });

    const failed = fixture({
      harnessDriver: { run: vi.fn(async () => { throw new Error("execution failed"); }) },
      outputs: { abort: vi.fn(async () => { throw new Error("output abort failed"); }) },
      workspace: { release: vi.fn(async () => { throw new Error("workspace release failed"); }) },
      fences: { release: vi.fn(async () => { throw new Error("fence release failed"); }) },
    });
    await expect(createManagedRuntimeHost(failed.dependencies).run({ scope, profile }))
      .resolves.toMatchObject({ type: "failed" });
  });

  it.each(["revoke", "release"])("surfaces a credential egress %s persistence failure", async (phase) => {
    const failure = new Error(`credential ${phase} failed`);
    const { dependencies } = fixture({
      credentialEgress: {
        capabilities: vi.fn(async () => ({ enforcement: "enforced" })),
        prepare: vi.fn(async () => ({
          bindingId: "egress_1",
          mode: "http_proxy",
          proxyUrl: "https://proxy.example",
        })),
        attach: vi.fn(async () => undefined),
        revoke: vi.fn(async () => {
          if (phase === "revoke") throw failure;
        }),
        release: vi.fn(async () => {
          if (phase === "release") throw failure;
        }),
      },
    });
    await expect(createManagedRuntimeHost(dependencies).run({
      scope,
      profile: {
        ...profile,
        credentialEgress: { requirement: "required" },
      },
    })).rejects.toBe(failure);
    expect(dependencies.workspace.release).toHaveBeenCalledOnce();
    expect(dependencies.fences.release).toHaveBeenCalledOnce();
  });
  it("rejects unsupported driver/output/checkpoint profiles before fence acquisition", async () => {
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({
          strategies: [{ strategy: "final_collect", durability: "best_effort" }],
        })),
      },
    });
    const host = createManagedRuntimeHost(dependencies);
    await expect(host.run({ scope, profile })).rejects.toThrow(/durable.*outputs/i);
    expect(dependencies.fences.acquire).not.toHaveBeenCalled();

    const missingDriver = fixture({
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["openma_supervised"] })),
      },
    });
    await expect(
      createManagedRuntimeHost(missingDriver.dependencies).run({ scope, profile }),
    ).rejects.toThrow(/ama_worker/i);
    expect(missingDriver.dependencies.fences.acquire).not.toHaveBeenCalled();

    const missingCheckpoint = fixture();
    await expect(
      createManagedRuntimeHost(missingCheckpoint.dependencies).run({
        scope,
        profile: { ...profile, runtimeCheckpoint: "required" },
      }),
    ).rejects.toThrow(/runtime checkpoint/i);
    expect(missingCheckpoint.dependencies.fences.acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["harness", { harnessDriver: { run: vi.fn(async () => { throw new Error("harness failed"); }) } }],
    ["workspace checkpoint", { workspace: { checkpoint: vi.fn(async () => { throw new Error("checkpoint failed"); }) } }],
    ["output finalization", { outputs: { finalize: vi.fn(async () => { throw new Error("finalize failed"); }) } }],
  ])("cleans every allocated resource when %s fails", async (_phase, overrides) => {
    const { dependencies, calls } = fixture(overrides as Record<string, any>);
    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toMatchObject({ type: "failed" });
    expect(dependencies.fences.publish).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "terminate:failed",
      "outputs.abort:failed",
      "workspace.release",
      "release:failed",
    ]);
  });

  it("treats a rejected atomic publication as lease loss and never releases outputs", async () => {
    const { dependencies, calls } = fixture({
      fences: { publish: vi.fn(async () => ({ type: "lost" })) },
    });
    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toEqual({ type: "lease_lost" });
    expect(calls).toEqual([
      "terminate:lease_lost",
      "outputs.abort:lease_lost",
      "workspace.release",
      "release:lease_lost",
    ]);
    expect(dependencies.outputs.release).not.toHaveBeenCalled();
  });

  it("persists failed hard termination without the fence secret and reaps it later", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    const terminate = vi.fn(async () => {
      throw new Error("provider control plane unavailable");
    });
    const reap = vi.fn(async () => {});
    const { dependencies } = fixture({
      sandbox: { terminate, reap },
    });
    dependencies.orphans = orphans;

    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toEqual({ type: "completed", revision: 1 });
    const pending = await orphans.list({ limit: 10 });
    expect(pending).toEqual([
      expect.objectContaining({
        scope,
        generation: fence.generation,
        ownerId: fence.ownerId,
        sandbox: { provider: "fake", runtimeId: "runtime-fault" },
        reason: "completed",
        attempts: 0,
        lastError: "provider control plane unavailable",
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain(fence.token);

    const reconciler = createManagedRuntimeOrphanReconciler({
      orphans,
      sandbox: dependencies.sandbox,
    });
    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({
      inspected: 1,
      resolved: 1,
      remaining: 0,
    });
    expect(reap).toHaveBeenCalledWith({
      scope,
      lease: { provider: "fake", runtimeId: "runtime-fault" },
      reason: "completed",
    });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });

  it("retains an orphan and increments its attempt when reconciliation still fails", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    await orphans.enqueue({
      scope,
      generation: 9,
      ownerId: "owner-stale",
      sandbox: { provider: "fake", runtimeId: "runtime-stale" },
      reason: "lease_lost",
      error: new Error("initial kill failed"),
    });
    const { dependencies } = fixture({
      sandbox: {
        reap: vi.fn(async () => {
          throw new Error("still partitioned");
        }),
      },
    });
    const reconciler = createManagedRuntimeOrphanReconciler({
      orphans,
      sandbox: dependencies.sandbox,
    });

    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({
      inspected: 1,
      resolved: 0,
      remaining: 1,
    });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ attempts: 1, lastError: "still partitioned" }),
    ]);
  });

  it("rejects unsafe orphan reconciliation limits", async () => {
    const { dependencies } = fixture();
    const reconciler = createManagedRuntimeOrphanReconciler({
      orphans: new MemoryRuntimeOrphanPort(),
      sandbox: dependencies.sandbox,
    });

    await expect(reconciler.runOnce({ limit: 0 })).rejects.toThrow("positive integer");
    await expect(reconciler.runOnce({ limit: 1.5 })).rejects.toThrow("positive integer");
  });
});
