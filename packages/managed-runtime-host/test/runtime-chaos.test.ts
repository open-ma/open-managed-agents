import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeHost,
} from "../src/index";
import type { RuntimeResourceFence } from "@open-managed-agents/runtime-resource-contract";
import type { ManagedRuntimeHostDependencies } from "../src/index";
import {
  MemoryRuntimeOrphanPort,
  MemoryRuntimeResourceFencePort,
} from "../src/testing";

const scope = {
  workspaceId: "workspace_chaos",
  environmentId: "environment_chaos",
  sessionId: "session_chaos",
  workId: "work_chaos",
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

const postAcquireStages = [
  "workspace.materialize",
  "outputs.prepare",
  "sandbox.acquire",
  "workspace.attach",
  "outputs.attach",
  "harness.run",
  "workspace.checkpoint",
  "outputs.collect",
  "outputs.finalize",
  "fences.publish",
] as const;

type PostAcquireStage = (typeof postAcquireStages)[number];

function blockedScheduler() {
  return {
    sleep: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  };
}

function chaosFixture(failAt: PostAcquireStage) {
  const trace: string[] = [];
  let loseRenew = false;
  const fence = {
    ...scope,
    ownerId: "chaos-owner",
    generation: 11,
    token: "chaos-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const stage = <T>(name: PostAcquireStage, value: T) =>
    vi.fn(async (..._arguments: unknown[]) => {
      trace.push(name);
      if (name === failAt) throw new Error(`injected:${name}`);
      return value;
    });

  const dependencies = {
    ownerId: "chaos-owner",
    leaseTtlMs: 90_000,
    heartbeatIntervalMs: 30_000,
    scheduler: blockedScheduler(),
    orphans: new MemoryRuntimeOrphanPort(),
    fences: {
      acquire: vi.fn(async () => ({ type: "acquired" as const, fence, publication: null })),
      renew: vi.fn(async () =>
        loseRenew
          ? ({ type: "lost" as const })
          : ({ type: "renewed" as const, fence })
      ),
      publish: stage("fences.publish", { type: "published" as const, revision: 1 }),
      release: vi.fn(async ({ reason }: { reason: string }) => {
        trace.push(`fences.release:${reason}`);
      }),
    },
    sandbox: {
      capabilities: vi.fn(async () => ({
        suspendResume: "unsupported" as const,
        hardTerminate: "supported" as const,
        runtimeCheckpoints: [],
      })),
      acquire: stage("sandbox.acquire", { provider: "fake", runtimeId: "runtime-chaos" }),
      heartbeat: vi.fn(async () => ({ type: "alive" as const })),
      suspend: vi.fn(),
      terminate: vi.fn(async ({ reason }: { reason: string }) => {
        trace.push(`sandbox.terminate:${reason}`);
      }),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore" as const] })),
      materialize: stage("workspace.materialize", {
        bindingId: "workspace-chaos",
        mountPath: "/workspace" as const,
      }),
      attach: stage("workspace.attach", undefined),
      checkpoint: stage("workspace.checkpoint", {
        id: "workspace-candidate",
        contentHash: "sha256:workspace",
        revision: 11,
      }),
      release: vi.fn(async () => {
        trace.push("workspace.release");
      }),
    },
    outputs: {
      capabilities: vi.fn(async () => ({
        strategies: [{ strategy: "final_collect" as const, durability: "durable" as const }],
      })),
      prepare: stage("outputs.prepare", {
        bindingId: "outputs-chaos",
        mountPath: "/mnt/session/outputs" as const,
      }),
      attach: stage("outputs.attach", undefined),
      collect: stage("outputs.collect", []),
      finalize: stage("outputs.finalize", {
        id: "outputs-candidate",
        contentHash: "sha256:outputs",
        entries: 0,
      }),
      release: vi.fn(async () => {
        trace.push("outputs.release");
      }),
      abort: vi.fn(async ({ reason }: { reason: string }) => {
        trace.push(`outputs.abort:${reason}`);
      }),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker" as const] })),
      run: stage("harness.run", { type: "completed" as const }),
    },
  };
  return {
    dependencies,
    trace,
    loseFenceOnRenew() {
      loseRenew = true;
    },
  };
}

describe("managed runtime deterministic chaos matrix", () => {
  it.each(postAcquireStages)(
    "never publishes or releases a candidate when %s fails",
    async (failAt) => {
      const { dependencies, trace } = chaosFixture(failAt);
      await expect(
        createManagedRuntimeHost(
          dependencies as unknown as ManagedRuntimeHostDependencies,
        ).run({ scope, profile }),
      ).resolves.toMatchObject({
        type: "failed",
        error: expect.objectContaining({ message: `injected:${failAt}` }),
      });

      expect(dependencies.outputs.release).not.toHaveBeenCalled();
      if (failAt !== "fences.publish") {
        expect(dependencies.fences.publish).not.toHaveBeenCalled();
      }
      expect(dependencies.fences.release).toHaveBeenCalledOnce();
      expect(trace.at(-1)).toBe("fences.release:failed");

      const sandboxWasAllocated = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("sandbox.acquire");
      expect(dependencies.sandbox.terminate).toHaveBeenCalledTimes(
        sandboxWasAllocated ? 1 : 0,
      );
      const outputWasPrepared = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("outputs.prepare");
      expect(dependencies.outputs.abort).toHaveBeenCalledTimes(
        outputWasPrepared ? 1 : 0,
      );
      const workspaceWasMaterialized = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("workspace.materialize");
      expect(dependencies.workspace.release).toHaveBeenCalledTimes(
        workspaceWasMaterialized ? 1 : 0,
      );
    },
  );

  it("fences a run that loses ownership while output finalization is in flight", async () => {
    let wakeMonitor!: () => void;
    const monitorMayRun = new Promise<void>((resolve) => {
      wakeMonitor = resolve;
    });
    const { dependencies, loseFenceOnRenew } = chaosFixture("fences.publish");
    dependencies.scheduler = {
      sleep: async (_milliseconds: number, signal: AbortSignal) => {
        await Promise.race([
          monitorMayRun,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
      },
    };
    loseFenceOnRenew();
    dependencies.outputs.finalize.mockImplementation(async (rawInput: unknown) => {
      const { signal } = rawInput as { signal: AbortSignal };
      wakeMonitor();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
      throw new Error("unreachable");
    });

    await expect(
      createManagedRuntimeHost(
        dependencies as unknown as ManagedRuntimeHostDependencies,
      ).run({ scope, profile }),
    ).resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.fences.publish).not.toHaveBeenCalled();
    expect(dependencies.outputs.abort).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "lease_lost" }),
    );
    expect(dependencies.outputs.release).not.toHaveBeenCalled();
  });
});

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("runtime fence seeded model chaos", () => {
  it.each([1, 7, 42, 2_026_090_3])(
    "preserves single-owner and stale-publication invariants for seed %i",
    async (seed) => {
      const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
      let token = 0;
      const store = new MemoryRuntimeResourceFencePort({
        now: () => new Date(clock.now),
        nextToken: (generation) => `token:${generation}:${++token}`,
      });
      const random = mulberry32(seed);
      const held: RuntimeResourceFence[] = [];

      for (let step = 0; step < 250; step += 1) {
        const action = Math.floor(random() * 5);
        if (action === 0 || held.length === 0) {
          const ownerId = `owner_${Math.floor(random() * 4)}`;
          const result = await store.acquire({ scope, ownerId, ttlMs: 10 });
          if (result.type === "acquired") held.push(result.fence);
        } else if (action === 1) {
          clock.now += 1 + Math.floor(random() * 12);
        } else {
          const candidate = held[Math.floor(random() * held.length)]!;
          if (action === 2) {
            await store.renew({ fence: candidate, ttlMs: 10 });
          } else if (action === 3) {
            await store.release({ fence: candidate });
          } else {
            const publication = await store.publish({
              fence: candidate,
              workspaceCandidate: {
                id: `workspace:${candidate.generation}`,
                contentHash: `sha256:${candidate.generation}`,
              },
              outputCandidate: null,
            });
            if (publication.type === "published") {
              const observed = store.inspect(scope)!;
              expect(observed.active).toMatchObject({
                ownerId: candidate.ownerId,
                token: candidate.token,
                generation: candidate.generation,
              });
              expect(observed.publication).toMatchObject({
                generation: candidate.generation,
                revision: publication.revision,
              });
            }
          }
        }

        const observed = store.inspect(scope);
        if (observed?.active !== null && observed?.active !== undefined) {
          const successfulHeld = held.filter(
            (candidate) =>
              candidate.token === observed.active?.token &&
              candidate.generation === observed.active.generation,
          );
          expect(new Set(successfulHeld.map((candidate) => candidate.token)).size).toBe(1);
        }
        if (observed?.publication !== null && observed?.publication !== undefined) {
          expect(observed.publication.generation).toBeLessThanOrEqual(observed.generation);
          expect(observed.publication.revision).toBeGreaterThan(0);
        }
      }
    },
  );
});
