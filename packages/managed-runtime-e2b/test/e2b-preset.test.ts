import { describe, expect, it, vi } from "vitest";

import * as e2bPreset from "../src/e2b";

const { createE2BManagedRuntime } = e2bPreset;

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "owner_1",
  generation: 1,
  token: "token",
  expiresAt: "2026-09-07T12:00:00.000Z",
};

function providerRuntime() {
  return {
    runtimeHandle: () => ({ provider: "e2b", runtimeId: "runtime-1" }),
    runtimeCapabilities: () => ({ lease: true, suspend: ["filesystem" as const, "memory" as const], checkpoint: ["memory" as const] }),
    status: async () => "running" as const,
    renewLease: async () => {},
    suspend: async () => ({ provider: "e2b", checkpointId: "runtime-1", sourceRuntimeId: "runtime-1", kind: "memory" as const, scope: "runtime" as const }),
    resume: async () => {},
    checkpoint: async () => ({ provider: "e2b", checkpointId: "snapshot", sourceRuntimeId: "runtime-1", kind: "memory" as const, scope: "portable" as const }),
    exec: async (command: string) =>
      command.includes("__OPENMA_RUNTIME_READY__")
        ? "__OPENMA_RUNTIME_READY__"
        : "",
    startProcess: async () => null,
    setEnvVars: async () => {},
    registerCommandSecrets: () => {},
    readFile: async () => "",
    readFileBytes: async () => new Uint8Array(),
    writeFile: async (path: string) => path,
    writeFileBytes: async (path: string) => path,
    destroy: async () => {},
  };
}

describe("E2B managed runtime provider package", () => {
  it("launches the resolved Environment template instead of the SDK base fallback", async () => {
    const create = vi.fn(async () => providerRuntime());
    const runtime = createE2BManagedRuntime({
      environment: { E2B_API_KEY: "test-only", SANDBOX_IMAGE: "stale-template" },
      provider: { create, resume: vi.fn(), restore: vi.fn() } as never,
      runtimeEnvironment: {
        type: "custom",
        identity: "custom-e2b-template",
        artifact: { type: "template", reference: "openma-template-v2" },
        prepare: async () => {},
      },
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "environment-template",
      signal,
    });

    await runtime.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal,
    });

    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ SANDBOX_IMAGE: "openma-template-v2" }),
      expect.objectContaining({
        environment: {
          type: "custom",
          identity: "custom-e2b-template",
          artifact: { type: "template", reference: "openma-template-v2" },
        },
      }),
    );
  });

  it("projects the configured E2B implementation through the swappable provider driver Port", async () => {
    const createDriver = Reflect.get(e2bPreset, "createE2BManagedRuntimeDriver");
    expect(createDriver).toBeTypeOf("function");
    const driver = (createDriver as unknown as (input: unknown) => {
      descriptor(): unknown;
      create(input: unknown): Promise<Record<string, unknown>>;
    })({
      environment: { E2B_API_KEY: "test-only" },
      leaseTtlMs: 90_000,
      outputStore: null,
    });

    expect(driver.descriptor()).toEqual({
      provider: "e2b",
      version: "1.0.0",
      placements: ["in_process"],
      capabilities: {
        sandbox: {
          suspendResume: "supported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: { strategies: ["retained_runtime", "checkpoint_restore"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
      credentialEgress: {
        enforcement: "unsupported",
        credentialMode: "snapshot",
        interceptedProtocols: [],
      },
    });

    const resources = await driver.create({
      environmentId: "environment_1",
      placement: "in_process",
      profile: {
        workspace: { requirement: "continuable" },
        outputs: { requirement: "disabled" },
        runtimeCheckpoint: "disabled",
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      providerConfig: {},
    });
    expect(resources).toEqual(expect.objectContaining({
      sandbox: expect.any(Object),
      workspace: expect.any(Object),
      outputs: expect.any(Object),
      harnessDriver: expect.any(Object),
      sessionInputs: expect.objectContaining({ materialize: expect.any(Function) }),
    }));
  });

  it("exposes the operator Session resource materializer through the driver package", async () => {
    const sessionInputs = {
      materialize: async () => undefined,
      synchronize: async () => undefined,
    };
    const driver = e2bPreset.createE2BManagedRuntimeDriver({
      environment: { E2B_API_KEY: "test-only" },
      leaseTtlMs: 90_000,
      outputStore: null,
      sessionInputs,
    });

    await expect(driver.create({ placement: "in_process" } as never)).resolves
      .toMatchObject({ sessionInputs });
  });

  it("declares only semantics implemented by the E2B provider bridge", async () => {
    const runtime = createE2BManagedRuntime({
      environment: {
        E2B_API_URL: "http://e2b-compatible.invalid",
        E2B_API_KEY: "test-only",
      },
      leaseTtlMs: 90_000,
    });

    await expect(runtime.sandbox.capabilities(scope)).resolves.toEqual({
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    });
    await expect(runtime.workspace.capabilities(scope)).resolves.toEqual({
      strategies: ["retained_runtime", "checkpoint_restore"],
    });
    await expect(runtime.outputs.capabilities(scope)).resolves.toEqual({ strategies: [] });
    await expect(runtime.harness.driverCapabilities(scope)).resolves.toEqual({
      drivers: ["ama_worker"],
    });
  });

  it("preinstalls durable final collection when an S3-compatible files store is configured", async () => {
    const runtime = createE2BManagedRuntime({
      environment: {
        E2B_API_KEY: "test-only",
        FILES_S3_ENDPOINT: "http://minio.invalid",
        FILES_S3_BUCKET: "outputs",
        FILES_S3_ACCESS_KEY: "access",
        FILES_S3_SECRET_KEY: "secret",
      },
      leaseTtlMs: 90_000,
    });

    await expect(runtime.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [{ strategy: "final_collect", durability: "durable" }],
    });
  });

  it("accepts an explicit provider-native credential-egress wire point", async () => {
    const runtime = createE2BManagedRuntime({
      environment: { E2B_API_KEY: "test-only" },
      leaseTtlMs: 90_000,
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
        attach: async () => undefined,
        revoke: async () => undefined,
      },
    });

    await expect(runtime.credentialEgress?.capabilities(scope)).resolves.toEqual({
      enforcement: "enforced",
      credentialMode: "live",
      interceptedProtocols: ["http", "https"],
    });
  });

  it("executes functional environment/context seams through an injected provider", async () => {
    const create = vi.fn<(context: unknown, environment: unknown, acquisition: unknown) => Promise<ReturnType<typeof providerRuntime>>>(async () => providerRuntime());
    const environment = vi.fn(() => ({
      E2B_API_KEY: "scope-key",
      SANDBOX_IMAGE: "openma-template",
    }));
    const context = vi.fn(() => ({ sessionId: "custom-session", workdir: "/custom" }));
    const runtime = createE2BManagedRuntime({
      environment,
      context,
      provider: { create } as never,
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "workspace",
      signal,
    });
    await runtime.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal,
    });
    expect(environment).toHaveBeenCalledWith(scope);
    expect(context).toHaveBeenCalledWith(scope);
    expect(create).toHaveBeenCalledWith(
      { sessionId: "custom-session", workdir: "/custom" },
      { E2B_API_KEY: "scope-key", SANDBOX_IMAGE: "openma-template" },
      expect.objectContaining({ scope, fence }),
    );
  });

  it("uses the default context during actual acquisition", async () => {
    const create = vi.fn<(context: unknown, environment: unknown, acquisition: unknown) => Promise<ReturnType<typeof providerRuntime>>>(async () => providerRuntime());
    const runtime = createE2BManagedRuntime({
      environment: { E2B_API_KEY: "key", SANDBOX_IMAGE: "openma-template" },
      provider: { create } as never,
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({ scope, fence, strategy: "retained_runtime", activeCheckpoint: null, idempotencyKey: "w", signal });
    await runtime.sandbox.acquire({
      scope,
      fence,
      plan: { workspaceStrategy: "retained_runtime", outputStrategy: null, runtimeCheckpoint: null, driver: { type: "ama_worker", process: { command: "worker" } } },
      workspace,
      outputs: null,
      signal,
    });
    expect(create.mock.calls[0]?.[0]).toEqual({ sessionId: scope.sessionId, workdir: "/workspace" });
  });

  it("covers output configuration precedence and every incomplete S3 tuple", async () => {
    const complete = {
      FILES_S3_ENDPOINT: "http://minio",
      FILES_S3_BUCKET: "bucket",
      FILES_S3_ACCESS_KEY: "access",
      FILES_S3_SECRET_KEY: "secret",
    };
    for (const missing of Object.keys(complete)) {
      const environment = { ...complete } as Record<string, string>;
      delete environment[missing];
      expect(e2bPreset.createE2BManagedRuntimeDriver({ environment, leaseTtlMs: 1 }).descriptor().capabilities.outputs.strategies).toEqual([]);
    }
    const explicitStore = {} as never;
    expect(e2bPreset.createE2BManagedRuntimeDriver({ environment: () => ({}), leaseTtlMs: 1, outputStore: explicitStore }).descriptor().capabilities.outputs.strategies).toHaveLength(1);
    expect(e2bPreset.createE2BManagedRuntimeDriver({ environment: () => ({}), leaseTtlMs: 1 }).descriptor().capabilities.outputs.strategies).toEqual([]);
    await expect(createE2BManagedRuntime({ environment: () => ({}), leaseTtlMs: 1 }).outputs.capabilities(scope)).resolves.toEqual({ strategies: [] });
    expect(e2bPreset.createE2BManagedRuntimeDriver({ environment: { ...complete, FILES_S3_REGION: "cn", FILES_S3_FORCE_PATH_STYLE: "false", FILES_S3_PREFIX: "prefix" }, leaseTtlMs: 1 }).descriptor().capabilities.outputs.strategies).toHaveLength(1);
    expect(e2bPreset.createE2BManagedRuntimeDriver({ environment: complete, leaseTtlMs: 1, outputStore: null }).descriptor().capabilities.outputs.strategies).toEqual([]);
  });

  it("rejects unsupported placement and exposes credential capabilities/resources", async () => {
    const credentialEgress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https"] as const },
      attach: async () => undefined,
      revoke: async () => undefined,
    };
    const driver = e2bPreset.createE2BManagedRuntimeDriver({ environment: {}, leaseTtlMs: 1, outputStore: null, credentialEgress });
    expect(driver.descriptor().credentialEgress).toEqual(credentialEgress.capabilities);
    await expect(driver.create({ placement: "external_worker" } as never)).rejects.toThrow("does not support external_worker");
    await expect(driver.create({ placement: "in_process" } as never)).resolves.toMatchObject({ credentialEgress: expect.any(Object) });
  });
});
