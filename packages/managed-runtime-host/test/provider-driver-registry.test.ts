import { describe, expect, it } from "vitest";

import * as managedRuntimeHost from "../src/index";

const durableProfile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "durable" as const },
  runtimeCheckpoint: "disabled" as const,
  credentialEgress: { requirement: "required" as const },
  driver: {
    type: "ama_worker" as const,
    process: { command: "managed-agent-worker" },
  },
};

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function registryFactory() {
  const factory = Reflect.get(
    managedRuntimeHost,
    "createManagedRuntimeProviderRegistry",
  );
  expect(factory).toBeTypeOf("function");
  return factory as (input: unknown) => {
    descriptors(): readonly unknown[];
    prepare(input: unknown): Promise<unknown>;
  };
}

function descriptor(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    version: "1.0.0",
    placements: ["in_process"],
    capabilities: {
      sandbox: { suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] },
      workspace: { strategies: ["checkpoint_restore"] },
      outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] },
      harness: { drivers: ["ama_worker"] },
    },
    credentialEgress: {
      enforcement: "enforced",
      credentialMode: "live",
      interceptedProtocols: ["http", "https"],
    },
    ...overrides,
  };
}

function resources(overrides: Record<string, unknown> = {}) {
  return {
    sandbox: { capabilities: async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] }) },
    workspace: { capabilities: async () => ({ strategies: ["checkpoint_restore"] }) },
    outputs: { capabilities: async () => ({ strategies: [{ strategy: "final_collect", durability: "durable" }] }) },
    harnessDriver: { driverCapabilities: async () => ({ drivers: ["ama_worker"] }) },
    credentialEgress: {
      capabilities: async () => ({ enforcement: "enforced", credentialMode: "live", interceptedProtocols: ["http", "https"] }),
    },
    ...overrides,
  };
}

describe("managed runtime provider driver registry", () => {
  it("projects a provider supervisor transport into the supervised harness lane", async () => {
    const commands: unknown[] = [];
    const supervisedProfile = {
      ...durableProfile,
      credentialEgress: undefined,
      driver: {
        type: "openma_supervised" as const,
        protocol: "openma-harness-supervisor-v1" as const,
        supervisor: { command: "openma-supervisor" },
        harness: { id: "pi", version: "1" },
        readyTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
      },
    };
    const registry = registryFactory()({
      drivers: [{
        descriptor: () => descriptor("supervised-provider", {
          capabilities: {
            ...descriptor("unused").capabilities,
            harness: { drivers: ["ama_worker", "openma_supervised"] },
          },
          credentialEgress: {
            enforcement: "unsupported",
            credentialMode: "snapshot",
            interceptedProtocols: [],
          },
        }),
        create: async () => resources({
          credentialEgress: undefined,
          supervisorTransport: {
            async open() {
              return {
                async send(command: unknown) {
                  commands.push(command);
                },
                async *events() {
                  yield {
                    type: "ready" as const,
                    protocol: "openma-harness-supervisor-v1" as const,
                  };
                  yield { type: "completed" as const, exitCode: 0 };
                  yield { type: "drained" as const };
                },
                async close() {},
              };
            },
          },
        }),
      }],
    });

    const selection = await registry.prepare({
      provider: "supervised-provider",
      placement: "in_process",
      scope,
      profile: supervisedProfile,
      providerConfig: {},
    }) as any;

    await expect(selection.resources.harnessDriver.run({
      scope,
      fence: {
        ...scope,
        ownerId: "owner_1",
        generation: 1,
        token: "fence_1",
        expiresAt: "2026-09-07T12:00:00.000Z",
      },
      sandbox: { provider: "supervised-provider", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: "/mnt/session/outputs",
      driver: supervisedProfile.driver,
      signal: new AbortController().signal,
    })).resolves.toEqual({ type: "completed" });
    expect(commands).toEqual([
      {
        type: "start",
        scope,
        harness: { id: "pi", version: "1" },
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
      },
      { type: "drain" },
    ]);
  });

  it("rejects a supervised provider that omits both the driver and transport Port", async () => {
    const supervisedProfile = {
      ...durableProfile,
      credentialEgress: undefined,
      driver: {
        type: "openma_supervised" as const,
        protocol: "openma-harness-supervisor-v1" as const,
        supervisor: { command: "openma-supervisor" },
        harness: { id: "pi", version: "1" },
        readyTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
      },
    };
    const registry = registryFactory()({
      drivers: [{
        descriptor: () => descriptor("broken-supervised", {
          capabilities: {
            ...descriptor("unused").capabilities,
            harness: { drivers: ["ama_worker", "openma_supervised"] },
          },
          credentialEgress: {
            enforcement: "unsupported",
            credentialMode: "snapshot",
            interceptedProtocols: [],
          },
        }),
        create: async () => resources({ credentialEgress: undefined }),
      }],
    });

    await expect(registry.prepare({
      provider: "broken-supervised",
      placement: "in_process",
      scope,
      profile: supervisedProfile,
      providerConfig: {},
    })).rejects.toThrow(
      "advertises openma_supervised without a HarnessSupervisorTransportPort",
    );
  });

  it("validates registry identity and placement before allocation", async () => {
    expect(() => registryFactory()({
      drivers: [{ descriptor: () => descriptor(""), create: async () => resources() }],
    })).toThrow("provider id must not be empty");
    expect(() => registryFactory()({
      drivers: [
        { descriptor: () => descriptor("duplicate"), create: async () => resources() },
        { descriptor: () => descriptor("duplicate"), create: async () => resources() },
      ],
    })).toThrow("Duplicate Managed Runtime provider");

    const registry = registryFactory()({
      drivers: [{ descriptor: () => descriptor("known"), create: async () => resources() }],
    });
    expect(registry.descriptors()).toEqual([expect.objectContaining({ provider: "known" })]);
    await expect(registry.prepare({
      provider: "missing",
      placement: "in_process",
      scope,
      profile: durableProfile,
      providerConfig: {},
    })).rejects.toThrow("Unknown Managed Runtime provider");
    await expect(registry.prepare({
      provider: "known",
      placement: "driver_service",
      scope,
      profile: durableProfile,
      providerConfig: {},
    })).rejects.toThrow("does not support driver_service placement");
  });

  it("detects resource plan drift after provider allocation", async () => {
    const registry = registryFactory()({
      drivers: [{
        descriptor: () => descriptor("drift", {
          capabilities: {
            ...descriptor("unused").capabilities,
            workspace: { strategies: ["durable_mount", "checkpoint_restore"] },
          },
        }),
        create: async () => resources({
          workspace: { capabilities: async () => ({ strategies: ["checkpoint_restore"] }) },
        }),
      }],
    });

    await expect(registry.prepare({
      provider: "drift",
      placement: "in_process",
      scope,
      profile: durableProfile,
      providerConfig: {},
    })).rejects.toThrow("drifted from the advertised capability plan");
  });

  it("requires the checkpoint and credential egress Ports advertised by a provider", async () => {
    const checkpointProfile = {
      ...durableProfile,
      credentialEgress: undefined,
      runtimeCheckpoint: "required" as const,
    };
    const checkpointDescriptor = descriptor("checkpoint", {
      capabilities: {
        ...descriptor("unused").capabilities,
        sandbox: { suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: ["filesystem"] },
      },
    });
    const missingCheckpoint = registryFactory()({ drivers: [{
      descriptor: () => checkpointDescriptor,
      create: async () => resources({
        sandbox: { capabilities: async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: ["filesystem"] }) },
        credentialEgress: undefined,
      }),
    }] });
    await expect(missingCheckpoint.prepare({
      provider: "checkpoint", placement: "in_process", scope,
      profile: checkpointProfile, providerConfig: {},
    })).rejects.toThrow("without a RuntimeCheckpointPort");

    const withCheckpoint = registryFactory()({ drivers: [{
      descriptor: () => checkpointDescriptor,
      create: async () => resources({
        sandbox: { capabilities: async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: ["filesystem"] }) },
        runtimeCheckpoint: {},
        credentialEgress: undefined,
      }),
    }] });
    await expect(withCheckpoint.prepare({
      provider: "checkpoint", placement: "in_process", scope,
      profile: checkpointProfile, providerConfig: {},
    })).resolves.toMatchObject({ plan: { runtimeCheckpoint: "filesystem" } });

    const missingEgress = registryFactory()({ drivers: [{
      descriptor: () => descriptor("missing-egress"),
      create: async () => resources({ credentialEgress: undefined }),
    }] });
    await expect(missingEgress.prepare({
      provider: "missing-egress", placement: "in_process", scope,
      profile: durableProfile, providerConfig: {},
    })).rejects.toThrow("without a CredentialEgressPort");

    const weakEgress = registryFactory()({ drivers: [{
      descriptor: () => descriptor("weak-egress"),
      create: async () => resources({
        credentialEgress: { capabilities: async () => ({ enforcement: "best_effort" }) },
      }),
    }] });
    await expect(weakEgress.prepare({
      provider: "weak-egress", placement: "in_process", scope,
      profile: durableProfile, providerConfig: {},
    })).rejects.toThrow("cannot enforce credential egress");

    const complete = registryFactory()({ drivers: [{
      descriptor: () => descriptor("complete"),
      create: async () => resources(),
    }] });
    await expect(complete.prepare({
      provider: "complete", placement: "in_process", scope,
      profile: durableProfile, providerConfig: {},
    })).resolves.toMatchObject({ descriptor: { provider: "complete" } });
  });
  it("rejects an incompatible replacement before allocating provider compute", async () => {
    let allocations = 0;
    const registry = registryFactory()({
      drivers: [{
        descriptor: () => ({
          provider: "ephemeral-only",
          version: "1.0.0",
          placements: ["in_process"],
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
        create: async () => {
          allocations += 1;
          throw new Error("must not allocate");
        },
      }],
    });

    await expect(registry.prepare({
      provider: "ephemeral-only",
      placement: "in_process",
      scope,
      profile: durableProfile,
      providerConfig: {},
    })).rejects.toThrow(/durable workspace/);
    expect(allocations).toBe(0);
  });

  it("rejects a driver whose returned resource Ports drift from its descriptor", async () => {
    const registry = registryFactory()({
      drivers: [{
        descriptor: () => ({
          provider: "drifting-provider",
          version: "1.0.0",
          placements: ["in_process"],
          capabilities: {
            sandbox: {
              suspendResume: "unsupported",
              hardTerminate: "supported",
              runtimeCheckpoints: [],
            },
            workspace: { strategies: ["checkpoint_restore"] },
            outputs: {
              strategies: [{ strategy: "final_collect", durability: "durable" }],
            },
            harness: { drivers: ["ama_worker"] },
          },
          credentialEgress: {
            enforcement: "enforced",
            credentialMode: "live",
            interceptedProtocols: ["http", "https"],
          },
        }),
        create: async () => ({
          sandbox: {
            capabilities: async () => ({
              suspendResume: "unsupported",
              hardTerminate: "supported",
              runtimeCheckpoints: [],
            }),
          },
          workspace: {
            capabilities: async () => ({ strategies: ["checkpoint_restore"] }),
          },
          outputs: {
            capabilities: async () => ({ strategies: [] }),
          },
          harnessDriver: {
            driverCapabilities: async () => ({ drivers: ["ama_worker"] }),
          },
          credentialEgress: {
            capabilities: async () => ({
              enforcement: "enforced",
              credentialMode: "live",
              interceptedProtocols: ["http", "https"],
            }),
          },
        }),
      }],
    });

    await expect(registry.prepare({
      provider: "drifting-provider",
      placement: "in_process",
      scope,
      profile: durableProfile,
      providerConfig: {},
    })).rejects.toThrow(/durable Session outputs/);
  });
});
