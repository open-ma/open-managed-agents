import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeProviderHost,
  type ManagedRuntimeProviderDriverPort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_provider_host",
  environmentId: "environment_provider_host",
  sessionId: "session_provider_host",
  workId: "work_provider_host",
};

const profile = {
  workspace: { requirement: "ephemeral" as const },
  outputs: { requirement: "disabled" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: {
    type: "ama_worker" as const,
    process: { command: "managed-worker" },
  },
};

function driver(create: ManagedRuntimeProviderDriverPort["create"]): ManagedRuntimeProviderDriverPort {
  return {
    descriptor: () => ({
      provider: "acme",
      version: "1.0.0",
      placements: ["driver_service"],
      capabilities: {
        sandbox: {
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: { strategies: ["ephemeral"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker"] },
      },
      credentialEgress: {
        enforcement: "unsupported",
        credentialMode: "snapshot",
        interceptedProtocols: [],
      },
    }),
    create,
  };
}

describe("provider-backed Managed Runtime Host", () => {
  it("passes provider-owned config through the registry before entering the common fence state machine", async () => {
    const providerConfig = { endpoint: "https://sandbox.acme.test", pool: "warm" };
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => ({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported" as const,
          hardTerminate: "supported" as const,
          runtimeCheckpoints: [],
        })),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["ephemeral" as const] })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker" as const] })),
      },
    } as never));
    const acquire = vi.fn(async () => ({
      type: "conflict" as const,
      expiresAt: "2026-09-07T15:00:00.000Z",
    }));
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig,
      ownerId: "worker_01",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      fences: { acquire } as never,
      orphans: {} as never,
    });

    await expect(host.run({ scope, profile })).resolves.toEqual({
      type: "conflict",
      expiresAt: "2026-09-07T15:00:00.000Z",
    });
    expect(create).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      placement: "driver_service",
      plan: {
        workspaceStrategy: "ephemeral",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: profile.driver,
      },
      profile,
      providerConfig,
    });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("fails capability admission before a provider adapter can allocate resources", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => {
      throw new Error("must not allocate");
    });
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      fences: {} as never,
      orphans: {} as never,
    });

    await expect(host.run({
      scope,
      profile: { ...profile, workspace: { requirement: "durable" } },
    })).rejects.toThrow(/durable workspace/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("passes every optional provider Port and scheduler into the common host", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => ({
      sandbox: {
        capabilities: vi.fn(async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] })),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["ephemeral"] })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
      },
      runtimeCheckpoint: { restore: vi.fn(), checkpoint: vi.fn() },
      credentialEgress: {
        capabilities: vi.fn(async () => ({ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] })),
        issue: vi.fn(),
        revoke: vi.fn(),
      },
      sessionInputs: { materialize: vi.fn(), release: vi.fn() },
    } as never));
    const scheduler = { sleep: vi.fn() } as never;
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      fences: {
        acquire: vi.fn(async () => ({
          type: "conflict" as const,
          expiresAt: "2026-09-07T15:00:00.000Z",
        })),
      } as never,
      orphans: {} as never,
      scheduler,
    });

    await expect(host.run({ scope, profile })).resolves.toMatchObject({ type: "conflict" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("admits repository Sessions as credential-egress-required before creating provider resources", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => {
      throw new Error("must not allocate");
    });
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      leaseTtlMs: 90_000,
      heartbeatIntervalMs: 30_000,
      fences: {} as never,
      orphans: {} as never,
    });

    await expect(host.run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "github_repository",
          url: "https://github.com/openma-ai/example.git",
          mount_path: "/workspace/example",
        }],
      },
    })).rejects.toThrow(/credential egress/i);
    expect(create).not.toHaveBeenCalled();
  });
});
