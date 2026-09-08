import { describe, expect, it, vi } from "vitest";

import { createManagedRuntimeHost } from "../src/index";
import { MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

const profile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "disabled" as const },
  runtimeCheckpoint: "disabled" as const,
  credentialEgress: { requirement: "required" as const },
  driver: {
    type: "ama_worker" as const,
    process: { command: "worker" },
  },
};

function createFixture(options: {
  calls?: string[];
  egress?: Record<string, unknown> | null;
  sessionInputs?: Record<string, unknown>;
  run?: (signal: AbortSignal) => Promise<{ type: "completed" } | { type: "aborted" }>;
} = {}) {
  const calls = options.calls ?? [];
  const fence = {
    ...scope,
    ownerId: "owner_1",
    generation: 7,
    token: "runtime-fence-secret",
    expiresAt: "2099-09-06T00:00:00.000Z",
  };
  const binding = {
    bindingId: "egress-binding-7",
    enforcement: "enforced" as const,
    credentialMode: "live" as const,
  };
  const egress = options.egress === null
    ? undefined
    : {
        capabilities: vi.fn(async () => ({
          enforcement: "enforced" as const,
          credentialMode: "live" as const,
          interceptedProtocols: ["http", "https"] as const,
        })),
        prepare: vi.fn(async (input: any) => {
          calls.push("egress.prepare");
          expect(input.fence).toEqual(fence);
          expect(input.requirement).toBe("required");
          return binding;
        }),
        attach: vi.fn(async (input: any) => {
          calls.push("egress.attach");
          expect(input.binding).toEqual(binding);
          expect(input.sandbox.runtimeId).toBe("sandbox-1");
        }),
        revoke: vi.fn(async (input: any) => {
          calls.push(`egress.revoke:${input.reason}`);
        }),
        release: vi.fn(async () => {
          calls.push("egress.release");
        }),
        ...(options.egress ?? {}),
      };
  const host = createManagedRuntimeHost({
    ownerId: "owner_1",
    leaseTtlMs: 90_000,
    heartbeatIntervalMs: 30_000,
    scheduler: {
      sleep: (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
    fences: {
      acquire: vi.fn(async () => ({ type: "acquired" as const, fence, publication: null })),
      renew: vi.fn(),
      publish: vi.fn(async () => {
        calls.push("fence.publish");
        return { type: "published" as const, revision: 1 };
      }),
      release: vi.fn(async () => calls.push("fence.release")),
    },
    sandbox: {
      capabilities: vi.fn(async () => ({
        suspendResume: "unsupported" as const,
        hardTerminate: "supported" as const,
        runtimeCheckpoints: [],
      })),
      acquire: vi.fn(async (input: any) => {
        calls.push("sandbox.acquire");
        expect(input.credentialEgress).toEqual(binding);
        expect(JSON.stringify(input.credentialEgress)).not.toContain(fence.token);
        return { provider: "fake", runtimeId: "sandbox-1" };
      }),
      heartbeat: vi.fn(async () => ({ type: "alive" as const })),
      suspend: vi.fn(),
      terminate: vi.fn(async () => calls.push("sandbox.terminate")),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ state: "running" as const })),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore" as const] })),
      materialize: vi.fn(async () => ({
        bindingId: "workspace-binding",
        mountPath: "/workspace",
      })),
      attach: vi.fn(async () => calls.push("workspace.attach")),
      checkpoint: vi.fn(async () => ({
        id: "workspace-candidate",
        contentHash: "sha256:workspace",
        revision: 1,
      })),
      release: vi.fn(async () => calls.push("workspace.release")),
    },
    outputs: {
      capabilities: vi.fn(async () => ({ strategies: [] })),
      prepare: vi.fn(),
      attach: vi.fn(),
      collect: vi.fn(),
      finalize: vi.fn(),
      abort: vi.fn(),
      release: vi.fn(),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({
        drivers: ["ama_worker" as const, "openma_supervised" as const],
      })),
      run: vi.fn(async (input: any) => {
        calls.push("harness.run");
        return options.run?.(input.signal) ?? { type: "completed" as const };
      }),
    },
    orphans: new MemoryRuntimeOrphanPort(),
    ...(egress === undefined ? {} : { credentialEgress: egress }),
    ...(options.sessionInputs === undefined
      ? {}
      : { sessionInputs: options.sessionInputs }),
  } as any);
  return { host, calls, egress, binding };
}

describe("ManagedRuntimeHost credential egress", () => {
  it("leaves memory stores to an official AMA worker without requiring a host materializer", async () => {
    const fixture = createFixture();

    await expect(fixture.host.run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
    } as any)).resolves.toEqual({ type: "completed", revision: 1 });

    expect(fixture.calls).toContain("harness.run");
  });

  it("requires the host materializer for memory stores used by a supervised harness", async () => {
    const fixture = createFixture();

    await expect(fixture.host.run({
      scope,
      profile: {
        ...profile,
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: { command: "supervisor" },
          harness: { id: "pi", version: "1" },
          readyTimeoutMs: 1_000,
          heartbeatTimeoutMs: 1_000,
          drainTimeoutMs: 1_000,
        },
      },
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
    } as any)).rejects.toThrow(/Session resources require a SessionInputMaterializerPort/);

    expect(fixture.calls).not.toContain("sandbox.acquire");
  });

  it("fails closed before allocating compute when Session resources have no materializer", async () => {
    const fixture = createFixture();

    await expect(fixture.host.run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          id: "sesrsc_repo_01",
          checkout: { type: "commit", sha: "0123456789abcdef" },
          mount_path: "/workspace",
          type: "github_repository",
          url: "https://github.com/openma-ai/example.git",
        }],
      },
    } as any)).rejects.toThrow(/Session resources require a SessionInputMaterializerPort/);

    expect(fixture.calls).not.toContain("sandbox.acquire");
    expect(fixture.calls).not.toContain("harness.run");
  });

  it("treats a repository resource as requiring credential egress even when the profile omits it", async () => {
    const fixture = createFixture({
      egress: null,
      sessionInputs: { materialize: vi.fn(async () => undefined) },
    });

    await expect(fixture.host.run({
      scope,
      profile: { ...profile, credentialEgress: { requirement: "disabled" } },
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          id: "sesrsc_repo_01",
          checkout: { type: "commit", sha: "0123456789abcdef" },
          mount_path: "/workspace/example",
          type: "github_repository",
          url: "https://github.com/openma-ai/example.git",
        }],
      },
    } as any)).rejects.toThrow(/Required credential egress is unavailable/);

    expect(fixture.calls).not.toContain("sandbox.acquire");
  });

  it("materializes Session resources and metadata after workspace and egress attach but before the harness", async () => {
    const calls: string[] = [];
    const materialize = vi.fn(async () => {
      calls.push("session_inputs.materialize");
    });
    const fixture = createFixture({
      calls,
      sessionInputs: { materialize },
    });

    await expect(fixture.host.run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {
          input_file: "s3://fixture-bucket/input.csv",
          commit_sha: "0123456789abcdef",
        },
        resources: [{
          id: "sesrsc_file_01",
          file_id: "file_01",
          mount_path: "/workspace/input.csv",
          type: "file",
        }],
      },
    } as any)).resolves.toEqual({ type: "completed", revision: 1 });

    expect(calls).toContain("session_inputs.materialize");
    expect(calls.indexOf("session_inputs.materialize")).toBeGreaterThan(
      calls.indexOf("egress.attach"),
    );
    expect(calls.indexOf("session_inputs.materialize")).toBeLessThan(
      calls.indexOf("harness.run"),
    );
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      resourceOwnership: { memoryStore: "worker" },
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {
          input_file: "s3://fixture-bucket/input.csv",
          commit_sha: "0123456789abcdef",
        },
        resources: [{
          id: "sesrsc_file_01",
          file_id: "file_01",
          mount_path: "/workspace/input.csv",
          type: "file",
        }],
      },
      workspace: expect.objectContaining({ mountPath: "/workspace" }),
      sandbox: expect.objectContaining({ runtimeId: "sandbox-1" }),
    }));
  });

  it("marks memory stores as materializer-owned for a supervised harness", async () => {
    const materialize = vi.fn(async () => undefined);
    const fixture = createFixture({ sessionInputs: { materialize } });

    await expect(fixture.host.run({
      scope,
      profile: {
        ...profile,
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: { command: "supervisor" },
          harness: { id: "pi", version: "1" },
          readyTimeoutMs: 1_000,
          heartbeatTimeoutMs: 1_000,
          drainTimeoutMs: 1_000,
        },
      },
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
    } as any)).resolves.toEqual({ type: "completed", revision: 1 });

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      resourceOwnership: { memoryStore: "materializer" },
    }));
  });

  it("does not start the harness when Session input staging fails", async () => {
    const calls: string[] = [];
    const fixture = createFixture({
      calls,
      sessionInputs: {
        async materialize() {
          calls.push("session_inputs.materialize");
          throw new Error("injected staging failure");
        },
      },
    });

    await expect(fixture.host.run({
      scope,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: { input_file: "s3://fixture-bucket/input.csv" },
        resources: [],
      },
    } as any)).resolves.toMatchObject({
      type: "failed",
      error: expect.objectContaining({ message: "injected staging failure" }),
    });

    expect(calls).toContain("session_inputs.materialize");
    expect(calls).not.toContain("harness.run");
  });

  it("binds enforced egress before the harness and revokes it before sandbox cleanup", async () => {
    const fixture = createFixture();

    await expect(fixture.host.run({ scope, profile } as any)).resolves.toEqual({
      type: "completed",
      revision: 1,
    });

    expect(fixture.calls).toEqual([
      "egress.prepare",
      "sandbox.acquire",
      "workspace.attach",
      "egress.attach",
      "harness.run",
      "fence.publish",
      "egress.revoke:completed",
      "sandbox.terminate",
      "egress.release",
      "workspace.release",
      "fence.release",
    ]);
  });

  it("fails closed before allocating compute when required egress is unavailable", async () => {
    const fixture = createFixture({ egress: null });

    await expect(fixture.host.run({ scope, profile } as any)).rejects.toThrow(
      /required credential egress/i,
    );
    expect(fixture.calls).not.toContain("sandbox.acquire");
    expect(fixture.calls).not.toContain("harness.run");
  });

  it("rejects advisory capability for a required profile", async () => {
    const fixture = createFixture({
      egress: {
        capabilities: vi.fn(async () => ({
          enforcement: "advisory" as const,
          credentialMode: "live" as const,
          interceptedProtocols: ["http", "https"] as const,
        })),
      },
    });

    await expect(fixture.host.run({ scope, profile } as any)).rejects.toThrow(
      /requires enforced credential egress/i,
    );
    expect(fixture.calls).not.toContain("egress.prepare");
  });

  it("revokes a generation before termination when the outer work lease is lost", async () => {
    const controller = new AbortController();
    const fixture = createFixture({
      run: async (signal) => {
        controller.abort(new Error("official Work lease lost"));
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { type: "aborted" };
      },
    });

    await expect(
      fixture.host.run({ scope, profile, signal: controller.signal } as any),
    ).resolves.toEqual({ type: "lease_lost" });

    expect(fixture.calls.indexOf("egress.revoke:lease_lost")).toBeGreaterThan(-1);
    expect(fixture.calls.indexOf("egress.revoke:lease_lost")).toBeLessThan(
      fixture.calls.indexOf("sandbox.terminate"),
    );
  });
});
