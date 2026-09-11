import { describe, expect, it, vi } from "vitest";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimePort,
} from "@open-managed-agents/sandbox";

import { createProviderManagedRuntime } from "../src/index";
import { createSandboxSessionMemoryFilePort } from "../src/provider-runtime";

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
  token: "fence-secret",
  expiresAt: "2026-09-03T12:00:00.000Z",
};

type Runtime = SandboxPort & SandboxRuntimePort & {
  spawnDuplexProcess: ReturnType<typeof vi.fn>;
};

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

function completedProcess(): SandboxDuplexProcess {
  return {
    stdin: new WritableStream(),
    stdout: emptyStream(),
    stderr: emptyStream(),
    kill: vi.fn(async () => {}),
    exited: Promise.resolve({ code: 0, signal: null }),
  };
}

function runtime(id: string): Runtime {
  return {
    runtimeHandle: () => ({ provider: "e2b", runtimeId: id }),
    runtimeCapabilities: () => ({
      lease: true,
      suspend: ["memory"],
      checkpoint: ["memory"],
    }),
    status: vi.fn(async () => "running" as const),
    renewLease: vi.fn(async () => {}),
    suspend: vi.fn(async () => ({
      provider: "e2b",
      checkpointId: id,
      sourceRuntimeId: id,
      kind: "memory",
      scope: "runtime",
    } satisfies SandboxCheckpointHandle)),
    resume: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({
      provider: "e2b",
      checkpointId: `snapshot-${id}`,
      sourceRuntimeId: id,
      kind: "memory",
      scope: "portable",
    } satisfies SandboxCheckpointHandle)),
    exec: vi.fn(async () => ""),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async (path: string) => path),
    writeFileBytes: vi.fn(async (path: string) => path),
    gitCheckout: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {}),
    spawnDuplexProcess: vi.fn(async () => completedProcess()),
  };
}

describe("sandbox Session Memory filesystem adapter", () => {
  it("scans nested files and preserves their mount-relative paths", async () => {
    const live = runtime("memory-files");
    vi.mocked(live.exec).mockResolvedValueOnce(btoa(
      "/workspace/memory/a.md\0/workspace/memory/nested/b.md\0",
    ));
    vi.mocked(live.readFile)
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b");
    const files = createSandboxSessionMemoryFilePort(live);

    await expect(files.scan("/workspace/memory/", new AbortController().signal))
      .resolves.toEqual(new Map([
        ["a.md", "a"],
        ["nested/b.md", "b"],
      ]));
  });

  it.each([
    ["/outside/a.md\0", /escaped its mount root/u],
    ["/workspace/memory/\0", /unsafe path/u],
    ["/workspace/memory/../a.md\0", /unsafe path/u],
  ])("rejects an unsafe scan result %#", async (paths, expected) => {
    const live = runtime("unsafe-memory-files");
    vi.mocked(live.exec).mockResolvedValueOnce(btoa(paths));
    const files = createSandboxSessionMemoryFilePort(live);

    await expect(files.scan("/workspace/memory", new AbortController().signal))
      .rejects.toThrow(expected);
  });

  it("reads present files and rejects an invalid existence probe", async () => {
    const live = runtime("memory-read");
    vi.mocked(live.exec)
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("unexpected");
    vi.mocked(live.readFile).mockResolvedValueOnce("value");
    const files = createSandboxSessionMemoryFilePort(live);

    await expect(files.read("/workspace/memory/a.md", new AbortController().signal))
      .resolves.toBe("value");
    await expect(files.read("/workspace/memory/b.md", new AbortController().signal))
      .rejects.toThrow(/invalid output/u);
  });

  it("writes and replaces through the runtime while handling root-level paths", async () => {
    const live = runtime("memory-write");
    const files = createSandboxSessionMemoryFilePort(live);
    const signal = new AbortController().signal;

    await files.write("leaf", "value", signal);
    await files.replace("", new Map([["", "root"], ["nested/a.md", "a"]]), signal);

    expect(live.exec).toHaveBeenCalledWith("mkdir -p -- '/'", 10_000);
    expect(live.writeFile).toHaveBeenCalledWith("leaf", "value");
    expect(live.writeFile).toHaveBeenCalledWith("/", "root");
    expect(live.writeFile).toHaveBeenCalledWith("/nested/a.md", "a");
  });
});

function composition(
  provider: SandboxProviderPort<Runtime>,
  outputs?: { store: InMemoryBlobStore },
) {
  return createProviderManagedRuntime({
    providerName: "e2b",
    provider,
    context: (inputScope): SandboxFactoryContext => ({
      sessionId: inputScope.sessionId,
      workdir: `/tmp/${inputScope.workId}`,
    }),
    environment: (): SandboxFactoryEnv => ({}),
    leaseTtlMs: 90_000,
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      retainedSuspendKind: "memory",
      portableCheckpointKind: "memory",
    },
    ...(outputs === undefined ? {} : { outputs }),
    drivers: ["ama_worker"],
  });
}

async function freshBinding(runtimeComposition: ReturnType<typeof composition>) {
  return runtimeComposition.workspace.materialize({
    scope,
    fence,
    strategy: "retained_runtime",
    activeCheckpoint: null,
    idempotencyKey: "materialize-1",
    signal: new AbortController().signal,
  });
}

describe("provider managed runtime adapter", () => {
  it("materializes official file and repository resources through the attached provider runtime", async () => {
    const created = runtime("session-input-runtime");
    const composed = composition({
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const signal = new AbortController().signal;
    const workspace = await freshBinding(composed);
    const sandbox = await composed.sandbox.acquire({
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
    const sessionInputs = composed.sessionInputs;
    const downloadFile = vi.fn(async () => ({
      content: new Uint8Array([0, 255, 1]),
      filename: "input.bin",
      mimeType: "application/octet-stream",
    }));

    await sessionInputs.materialize({
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [
          {
            id: "sesrsc_file_01",
            type: "file",
            file_id: "file_01",
            mount_path: "/mnt/session/uploads/input.bin",
          },
          {
            id: "sesrsc_repo_01",
            type: "github_repository",
            url: "https://github.com/openma-ai/example.git",
            mount_path: "/workspace/example",
            checkout: { type: "branch", name: "feature/runtime-port" },
          },
        ],
      },
      workspace,
      sandbox,
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "worker" },
      idempotencyKey: "session-inputs-1",
      access: { downloadFile },
      authorize: vi.fn(async () => true),
      signal,
    });

    expect(downloadFile).toHaveBeenCalledWith({ fileId: "file_01", signal });
    expect(created.writeFileBytes).toHaveBeenCalledWith(
      "/mnt/session/uploads/input.bin",
      new Uint8Array([0, 255, 1]),
    );
    expect(created.gitCheckout).toHaveBeenCalledWith(
      "https://github.com/openma-ai/example.git",
      { branch: "feature/runtime-port", targetDir: "/workspace/example" },
    );
  });

  it("hydrates materializer-owned memory stores for the supervised lane", async () => {
    const created = runtime("session-memory-runtime");
    created.exec = vi.fn(async (command: string) =>
      command.startsWith("if [ -f") ? "0" : "");
    const composed = composition({
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const signal = new AbortController().signal;
    const workspace = await freshBinding(composed);
    const sandbox = await composed.sandbox.acquire({
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

    const list = vi.fn(async () => [{
      id: "mem_01",
      path: "/notes.md",
      content: "canonical",
      contentSha256: "sha-canonical",
    }]);
    await expect(composed.sessionInputs.materialize({
      scope,
      fence,
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
      workspace,
      sandbox,
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "materializer" },
      idempotencyKey: "session-memory-1",
      access: {
        downloadFile: vi.fn(),
        memories: {
          list,
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
      authorize: vi.fn(async () => true),
      signal,
    } as any)).resolves.toBeUndefined();
    expect(created.writeFile).toHaveBeenCalledWith(
      "/workspace/memory/notes.md",
      "canonical",
    );
    expect(created.writeFile).toHaveBeenCalledWith(
      "/workspace/memory/.openma-memory-store",
      "openma-memory-store-v1\nmemstore_01",
    );

    await expect(composed.sessionInputs.synchronize({
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [],
      },
      workspace,
      sandbox,
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "worker" },
      idempotencyKey: "session-memory-worker-owned-sync",
      access: { downloadFile: vi.fn() },
      authorize: vi.fn(async () => true),
      signal,
    } as any)).resolves.toBeUndefined();
  });

  it("supports an explicit ephemeral workspace without inventing provider persistence", async () => {
    const created = runtime("ephemeral-runtime");
    const create = vi.fn(async (..._args: unknown[]) => {
      created.runtimeHandle = () => ({
        provider: "ephemeral-provider",
        runtimeId: "ephemeral-runtime",
      });
      return created;
    });
    const composed = createProviderManagedRuntime({
      providerName: "ephemeral-provider",
      provider: {
        create,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({
        sessionId: inputScope.sessionId,
        workdir: "/workspace",
      }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      sandboxCapabilities: {
        suspendResume: "unsupported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: { strategies: ["ephemeral"] },
      drivers: ["ama_worker"],
    });
    const signal = new AbortController().signal;
    const binding = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "ephemeral",
      activeCheckpoint: {
        id: "previous-marker",
        contentHash: "sha256:previous",
      },
      idempotencyKey: "ephemeral-materialize",
      signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "ephemeral",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: binding,
      outputs: null,
      signal,
    });
    expect(create.mock.calls[0]?.[2]).toMatchObject({
      scope,
      fence,
      plan: { workspaceStrategy: "ephemeral" },
      workspace: binding,
      outputs: null,
      credentialEgress: null,
      signal,
    });

    await expect(composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "ephemeral",
      binding,
      sandbox: lease,
      idempotencyKey: "ephemeral-checkpoint",
      signal,
    })).resolves.toMatchObject({
      revision: 1,
      metadata: {
        "openma.workspace.ephemeral.v1": expect.stringContaining("ephemeral-runtime"),
      },
    });
    expect(created.checkpoint).not.toHaveBeenCalled();
  });

  it("does not invent provider lease renewal for runtimes that only expose liveness", async () => {
    const created = runtime("liveness-only");
    created.runtimeCapabilities = () => ({
      lease: false,
      suspend: [],
      checkpoint: ["filesystem"],
    });
    const composed = composition({
      create: async () => created,
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const workspace = await freshBinding(composed);
    const lease = await composed.sandbox.acquire({
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
      signal: new AbortController().signal,
    });

    expect(created.status).toHaveBeenCalledOnce();
    expect(created.renewLease).not.toHaveBeenCalled();
    await expect(composed.sandbox.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "alive",
    });
    expect(created.renewLease).not.toHaveBeenCalled();
  });

  it("destroys provider allocations when identity validation or readiness is aborted", async () => {
    const invalid = runtime("invalid-runtime");
    invalid.runtimeHandle = () => ({ provider: "another-provider", runtimeId: "invalid-runtime" });
    const aborted = runtime("aborted-runtime");
    vi.mocked(aborted.status).mockResolvedValue("unknown");
    const abortController = new AbortController();
    let allocation = invalid;
    const composed = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => allocation,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({ sessionId: inputScope.sessionId, workdir: "/workspace" }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      readiness: {
        timeoutMs: 1_000,
        pollIntervalMs: 25,
        wait: async () => {
          abortController.abort(new Error("claim fenced"));
        },
      },
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: { strategies: ["checkpoint_restore"], portableCheckpointKind: "memory" },
      drivers: ["ama_worker"],
    });
    const workspace = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace-start-failure",
      signal: new AbortController().signal,
    });
    const acquire = (signal: AbortSignal) => composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal,
    });

    await expect(acquire(new AbortController().signal)).rejects.toThrow(
      "incompatible runtime",
    );
    expect(invalid.destroy).toHaveBeenCalledOnce();

    allocation = aborted;
    await expect(acquire(abortController.signal)).rejects.toThrow("claim fenced");
    expect(aborted.destroy).toHaveBeenCalledOnce();
  });

  it("holds acquisition behind provider readiness and cleans up failed starts", async () => {
    const created = runtime("sandbox-starting");
    vi.mocked(created.status)
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("running");
    const waits: number[] = [];
    const composed = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => created,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({ sessionId: inputScope.sessionId, workdir: "/workspace" }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      readiness: {
        timeoutMs: 1_000,
        pollIntervalMs: 25,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: { strategies: ["checkpoint_restore"], portableCheckpointKind: "memory" },
      drivers: ["ama_worker"],
    });
    const workspace = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace-readiness",
      signal: new AbortController().signal,
    });

    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal: new AbortController().signal,
    });

    expect(lease.runtimeId).toBe("sandbox-starting");
    expect(created.status).toHaveBeenCalledTimes(2);
    expect(created.renewLease).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([25]);

    const stopped = runtime("sandbox-stopped");
    vi.mocked(stopped.status).mockResolvedValue("stopped");
    const stoppedComposition = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => stopped,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({ sessionId: inputScope.sessionId, workdir: "/workspace" }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      readiness: { timeoutMs: 1_000, pollIntervalMs: 25 },
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: { strategies: ["checkpoint_restore"], portableCheckpointKind: "memory" },
      drivers: ["ama_worker"],
    });
    const stoppedWorkspace = await stoppedComposition.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace-stopped",
      signal: new AbortController().signal,
    });

    await expect(stoppedComposition.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: stoppedWorkspace,
      outputs: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("stopped before it became ready");
    expect(stopped.destroy).toHaveBeenCalledOnce();
  });

  it("turns a provider wire point into an opaque credential-egress Port", async () => {
    const created = runtime("sandbox-egress");
    const lifecycle: string[] = [];
    const composed = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => created,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({ sessionId: inputScope.sessionId, workdir: "/workspace" }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: { strategies: ["checkpoint_restore"], portableCheckpointKind: "memory" },
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
        attach: vi.fn(async (input) => {
          lifecycle.push("attach");
          expect(input.runtime).toBe(created);
          expect(input.scope).toEqual(scope);
          expect(input.fence).toEqual(fence);
        }),
        revoke: vi.fn(async (input) => {
          lifecycle.push(`revoke:${input.reason}`);
          expect(input.runtime).toBe(created);
          expect(input.fence.token).toBe("fence-secret");
        }),
      },
      drivers: ["ama_worker"],
    });

    await expect(composed.credentialEgress!.capabilities(scope)).resolves.toEqual({
      enforcement: "enforced",
      credentialMode: "live",
      interceptedProtocols: ["http", "https"],
    });
    const binding = await composed.credentialEgress!.prepare({
      scope,
      fence,
      requirement: "required",
      idempotencyKey: "egress-prepare",
      signal: new AbortController().signal,
    });
    expect(binding).toMatchObject({
      bindingId: expect.stringMatching(/^provider-egress-/),
      enforcement: "enforced",
      credentialMode: "live",
    });
    expect(JSON.stringify(binding)).not.toContain(fence.token);

    const workspace = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      credentialEgress: binding,
      signal: new AbortController().signal,
    });
    await composed.credentialEgress!.attach({
      scope,
      fence,
      binding: binding!,
      sandbox: lease,
      signal: new AbortController().signal,
    });
    await composed.credentialEgress!.revoke({
      scope,
      fence,
      binding: binding!,
      reason: "lease_lost",
    });
    await composed.credentialEgress!.release({
      scope,
      fence,
      binding: binding!,
    });

    expect(lifecycle).toEqual(["attach", "revoke:lease_lost"]);
  });

  it("exposes an explicit provider checkpoint port without promoting snapshots", async () => {
    const previous = runtime("checkpoint-source");
    const restored = runtime("checkpoint-restored");
    let checkpointRestoreRuntime = restored;
    const composed = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => previous,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({ sessionId: inputScope.sessionId, workdir: "/workspace" }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: ["process"],
      },
      workspace: { strategies: ["checkpoint_restore"], portableCheckpointKind: "memory" },
      drivers: ["ama_worker"],
      runtimeCheckpoint: {
        kind: "process",
        create: async ({ runtime: providerRuntime }) => ({
          provider: "e2b",
          checkpointId: "process-1",
          sourceRuntimeId: providerRuntime.runtimeHandle().runtimeId,
          kind: "memory",
          scope: "portable",
        }),
        restore: async () => checkpointRestoreRuntime,
      },
    });

    const binding = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: "process",
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: binding,
      outputs: null,
      signal: new AbortController().signal,
    });
    const checkpoint = await composed.runtimeCheckpoint!.create({
      scope,
      fence,
      sandbox: lease,
      kind: "process",
      workspaceRevision: 4,
      harnessVersion: "worker-v1",
      runtimeIdentity: "identity-1",
    });
    expect(checkpoint).toMatchObject({
      provider: "e2b",
      checkpointId: "process-1",
      kind: "process",
      sourceRuntimeId: "checkpoint-source",
      sessionId: scope.sessionId,
      workGeneration: fence.generation,
      workspaceRevision: 4,
    });
    await expect(composed.runtimeCheckpoint!.restore({
      scope,
      fence,
      checkpoint,
    })).resolves.toEqual({ provider: "e2b", runtimeId: "checkpoint-restored" });

    const failedRestore = runtime("checkpoint-failed");
    vi.mocked(failedRestore.status).mockResolvedValue("stopped");
    checkpointRestoreRuntime = failedRestore;
    await expect(composed.runtimeCheckpoint!.restore({
      scope,
      fence,
      checkpoint,
    })).rejects.toThrow("stopped before it became ready");
    expect(failedRestore.destroy).toHaveBeenCalledOnce();
  });

  it("exposes a provider-native Session output mount without folding it into SandboxPort", async () => {
    const created = runtime("sandbox-output-mount");
    const mounted: Array<{ runtimeId: string; tenant: string; session: string }> = [];
    const composed = createProviderManagedRuntime({
      providerName: "e2b",
      provider: {
        create: async () => created,
        resume: vi.fn(),
        restore: vi.fn(),
      },
      context: (inputScope) => ({
        sessionId: inputScope.sessionId,
        workdir: `/tmp/${inputScope.workId}`,
      }),
      environment: () => ({}),
      leaseTtlMs: 90_000,
      sandboxCapabilities: {
        suspendResume: "supported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      },
      workspace: {
        strategies: ["retained_runtime"],
        retainedSuspendKind: "memory",
      },
      outputs: {
        store: new InMemoryBlobStore(),
        durableMount: {
          async attach({ runtime: providerRuntime, scope: inputScope }) {
            mounted.push({
              runtimeId: providerRuntime.runtimeHandle().runtimeId,
              tenant: inputScope.workspaceId,
              session: inputScope.sessionId,
            });
          },
        },
      },
      drivers: ["ama_worker"],
    });

    await expect(composed.outputs.capabilities(scope)).resolves.toEqual({
      strategies: [
        { strategy: "durable_mount", durability: "durable" },
        { strategy: "final_collect", durability: "durable" },
      ],
    });
    const workspace = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "workspace",
      signal: new AbortController().signal,
    });
    const outputs = await composed.outputs.prepare({
      scope,
      fence,
      strategy: "durable_mount",
      idempotencyKey: "outputs",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: "durable_mount",
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs,
      signal: new AbortController().signal,
    });
    await composed.outputs.attach({
      scope,
      fence,
      strategy: "durable_mount",
      binding: outputs,
      sandbox: lease,
      signal: new AbortController().signal,
    });

    expect(mounted).toEqual([{
      runtimeId: "sandbox-output-mount",
      tenant: "workspace_1",
      session: "session_1",
    }]);
  });

  it("carries the shared supervisor protocol over sandbox stdio with fragmented JSONL", async () => {
    const commands: string[] = [];
    const encoder = new TextEncoder();
    const protocolProcess: SandboxDuplexProcess = {
      stdin: new WritableStream({
        write(chunk: Uint8Array) {
          commands.push(new TextDecoder().decode(chunk));
        },
      }),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"rea'));
          controller.enqueue(
            encoder.encode(
              'dy","protocol":"openma-harness-supervisor-v1"}\n{"type":"heartbeat","sequence":7}\n',
            ),
          );
          controller.close();
        },
      }),
      stderr: emptyStream(),
      kill: vi.fn(async () => {}),
      exited: Promise.resolve({ code: 0, signal: null }),
    };
    const created = runtime("sandbox-1");
    created.spawnDuplexProcess.mockResolvedValue(protocolProcess);
    const composed = composition({
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const workspace = await freshBinding(composed);
    const controller = new AbortController();
    const lease = await composed.sandbox.acquire({
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
      signal: controller.signal,
    });
    const channel = await composed.supervisorTransport.open({
      scope,
      sandbox: lease,
      process: { command: "openma-supervisor", args: ["--stdio"] },
      signal: controller.signal,
    });
    await channel.send({ type: "drain" });
    const events = [];
    for await (const event of channel.events(controller.signal)) events.push(event);
    await channel.close();

    expect(created.spawnDuplexProcess).toHaveBeenCalledWith({
      command: "openma-supervisor",
      args: ["--stdio"],
    });
    expect(commands).toEqual(['{"type":"drain"}\n']);
    expect(events).toEqual([
      { type: "ready", protocol: "openma-harness-supervisor-v1" },
      { type: "heartbeat", sequence: 7 },
    ]);
    expect(protocolProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("runs a community AMA worker declaration unchanged and never injects the fence", async () => {
    const created = runtime("sandbox-1");
    const provider: SandboxProviderPort<Runtime> = {
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    };
    const composed = composition(provider);
    const workspace = await freshBinding(composed);
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "community-worker",
            args: ["--poll"],
            cwd: "/workspace",
            env: { ENVIRONMENT_KEY: "env-key" },
          },
        },
      },
      workspace,
      outputs: null,
      signal: new AbortController().signal,
    });

    await expect(
      composed.harness.run({
        scope,
        fence,
        sandbox: lease,
        workspacePath: "/workspace",
        outputPath: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "community-worker",
            args: ["--poll"],
            cwd: "/workspace",
            env: { ENVIRONMENT_KEY: "env-key" },
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ type: "completed" });
    expect(created.spawnDuplexProcess).toHaveBeenCalledWith({
      command: "community-worker",
      args: ["--poll"],
      cwd: "/workspace",
      env: { ENVIRONMENT_KEY: "env-key" },
    });
    expect(JSON.stringify(created.spawnDuplexProcess.mock.calls)).not.toContain(
      fence.token,
    );
  });

  it("publishes and resumes an opaque retained-runtime candidate", async () => {
    const first = runtime("sandbox-1");
    const resumed = runtime("sandbox-1");
    const provider: SandboxProviderPort<Runtime> = {
      create: vi.fn(async () => first),
      resume: vi.fn(async () => resumed),
      restore: vi.fn(),
    };
    const composed = composition(provider);
    const binding = await freshBinding(composed);
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: binding,
      outputs: null,
      signal: new AbortController().signal,
    });
    const suspended = await composed.sandbox.suspend({
      scope,
      fence,
      lease,
      signal: new AbortController().signal,
    });
    const candidate = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding,
      sandbox: suspended,
      idempotencyKey: "checkpoint-1",
      signal: new AbortController().signal,
    });

    const nextFence = { ...fence, generation: 2, token: "next-secret" };
    const nextBinding = await composed.workspace.materialize({
      scope,
      fence: nextFence,
      strategy: "retained_runtime",
      activeCheckpoint: candidate,
      idempotencyKey: "materialize-2",
      signal: new AbortController().signal,
    });
    await composed.sandbox.acquire({
      scope,
      fence: nextFence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: nextBinding,
      outputs: null,
      signal: new AbortController().signal,
    });

    expect(provider.resume).toHaveBeenCalledWith(
      { provider: "e2b", runtimeId: "sandbox-1" },
      expect.objectContaining({ sessionId: scope.sessionId }),
      {},
      expect.objectContaining({
        scope,
        fence: nextFence,
        workspace: nextBinding,
      }),
    );
    expect(provider.restore).not.toHaveBeenCalled();
  });

  it("rejects and cleans up a portable restore that never becomes runnable", async () => {
    const first = runtime("sandbox-1");
    const restored = runtime("sandbox-2");
    vi.mocked(restored.status).mockResolvedValue("stopped");
    const provider: SandboxProviderPort<Runtime> = {
      create: vi.fn(async () => first),
      resume: vi.fn(),
      restore: vi.fn(async () => restored),
    };
    const composed = composition(provider);
    const binding = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "materialize-1",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: binding,
      outputs: null,
      signal: new AbortController().signal,
    });
    const candidate = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "checkpoint_restore",
      binding,
      sandbox: lease,
      idempotencyKey: "checkpoint-1",
      signal: new AbortController().signal,
    });
    await composed.sandbox.terminate({ scope, fence, lease, reason: "completed" });

    const nextFence = { ...fence, generation: 2, token: "next-secret" };
    const nextBinding = await composed.workspace.materialize({
      scope,
      fence: nextFence,
      strategy: "checkpoint_restore",
      activeCheckpoint: candidate,
      idempotencyKey: "materialize-2",
      signal: new AbortController().signal,
    });
    await expect(composed.sandbox.acquire({
      scope,
      fence: nextFence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: nextBinding,
      outputs: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("stopped before it became ready");

    expect(provider.restore).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "snapshot-sandbox-1" }),
      expect.any(Object),
      {},
      expect.objectContaining({
        scope,
        fence: nextFence,
        workspace: nextBinding,
      }),
    );
    expect(restored.destroy).toHaveBeenCalledOnce();
  });

  it("collects binary Session outputs into immutable object candidates and detects mutation", async () => {
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([
      ["/mnt/session/outputs/report.txt", encoder.encode("first")],
      ["/mnt/session/outputs/nested/image.bin", new Uint8Array([0, 1, 2, 255])],
    ]);
    const created = runtime("sandbox-output");
    created.readFileBytes = vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing:${path}`);
      return new Uint8Array(value);
    });
    created.spawnDuplexProcess.mockImplementation(async (spec: { command: string }) => {
      if (spec.command === "mkdir") return completedProcess();
      if (spec.command !== "find") throw new Error(`unexpected:${spec.command}`);
      const bytes = encoder.encode([...files.keys()].join("\0") + "\0");
      return {
        ...completedProcess(),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 17));
            controller.enqueue(bytes.slice(17));
            controller.close();
          },
        }),
      };
    });
    const store = new InMemoryBlobStore();
    const composed = composition(
      { create: vi.fn(async () => created), resume: vi.fn(), restore: vi.fn() },
      { store },
    );
    const workspace = await freshBinding(composed);
    const outputs = await composed.outputs.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "outputs-prepare",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: "final_collect",
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs,
      signal: new AbortController().signal,
    });
    await composed.outputs.attach({
      scope,
      fence,
      strategy: "final_collect",
      binding: outputs,
      sandbox: lease,
      signal: new AbortController().signal,
    });
    const entries = await composed.outputs.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding: outputs,
      signal: new AbortController().signal,
    });
    expect(entries.map((entry) => [entry.logicalPath, entry.size])).toEqual([
      ["nested/image.bin", 4],
      ["report.txt", 5],
    ]);

    const corruptBlobKey = `managed-runtime-outputs/blobs/${
      entries.find((entry) => entry.logicalPath === "report.txt")!
        .contentHash.slice("sha256:".length)
    }`;
    await store.put(corruptBlobKey, "WRONG");
    await expect(
      composed.outputs.finalize({
        scope,
        fence,
        strategy: "final_collect",
        binding: outputs,
        entries,
        idempotencyKey: "outputs-finalize",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/existing session output blob is invalid/i);
    await store.delete(corruptBlobKey);

    files.set("/mnt/session/outputs/report.txt", encoder.encode("changed"));
    await expect(
      composed.outputs.finalize({
        scope,
        fence,
        strategy: "final_collect",
        binding: outputs,
        entries,
        idempotencyKey: "outputs-finalize",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/changed during collection/i);

    files.set("/mnt/session/outputs/report.txt", encoder.encode("first"));
    const first = await composed.outputs.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding: outputs,
      entries,
      idempotencyKey: "outputs-finalize",
      signal: new AbortController().signal,
    });
    const retried = await composed.outputs.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding: outputs,
      entries,
      idempotencyKey: "outputs-finalize",
      signal: new AbortController().signal,
    });

    expect(retried).toEqual(first);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^out_[a-f0-9]{64}$/),
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      entries: 2,
      metadata: { manifestKey: expect.stringMatching(/\.json$/) },
    });
    expect(store.keys().filter((key) => key.includes("/blobs/"))).toHaveLength(2);
    expect(store.keys().filter((key) => key.includes("/manifests/"))).toHaveLength(1);
  });

  it("keeps a failed hard-terminate attached so cleanup can be retried idempotently", async () => {
    const created = runtime("sandbox-reap");
    vi.mocked(created.destroy!)
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const composed = composition({
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const workspace = await freshBinding(composed);
    const lease = await composed.sandbox.acquire({
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
      signal: new AbortController().signal,
    });

    await expect(
      composed.sandbox.terminate({ scope, fence, lease, reason: "lease_lost" }),
    ).rejects.toThrow("provider unavailable");
    await expect(
      composed.sandbox.terminate({ scope, fence, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    await expect(
      composed.sandbox.terminate({ scope, fence, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    expect(created.destroy).toHaveBeenCalledTimes(2);
  });

  it("reconnects a serialized orphan lease after host restart before destroying it", async () => {
    const resumed = runtime("sandbox-orphan-restart");
    const provider: SandboxProviderPort<Runtime> = {
      create: vi.fn(),
      resume: vi.fn(async () => resumed),
      restore: vi.fn(),
    };
    const restarted = composition(provider);
    const lease = { provider: "e2b", runtimeId: "sandbox-orphan-restart" };

    await expect(
      restarted.sandbox.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    await expect(
      restarted.sandbox.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    expect(provider.resume).toHaveBeenCalledOnce();
    expect(resumed.destroy).toHaveBeenCalledOnce();
  });

  it("rejects corrupt provider checkpoint metadata and never silently creates an empty workspace", async () => {
    const restored = runtime("sandbox-corrupt");
    const provider: SandboxProviderPort<Runtime> = {
      create: vi.fn(async () => runtime("sandbox-empty")),
      resume: vi.fn(),
      restore: vi.fn(async () => restored),
    };
    const composed = composition(provider);
    const binding = await composed.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "materialize-corrupt-source",
      signal: new AbortController().signal,
    });
    const lease = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: binding,
      outputs: null,
      signal: new AbortController().signal,
    });
    const candidate = await composed.workspace.checkpoint({
      scope,
      fence,
      strategy: "checkpoint_restore",
      binding,
      sandbox: lease,
      idempotencyKey: "checkpoint-corrupt-source",
      signal: new AbortController().signal,
    });

    await expect(
      composed.workspace.materialize({
        scope,
        fence: { ...fence, generation: 2, token: "next" },
        strategy: "checkpoint_restore",
        activeCheckpoint: { ...candidate, contentHash: "sha256:tampered" },
        idempotencyKey: "materialize-corrupt-target",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/content hash mismatch/i);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.restore).not.toHaveBeenCalled();
  });

  it("destroys a runtime when cancellation races its running readiness result", async () => {
    const created = runtime("sandbox-ready-abort-race");
    const controller = new AbortController();
    vi.mocked(created.status).mockImplementationOnce(async () => {
      controller.abort(new Error("claim fenced at ready"));
      return "running";
    });
    const composed = composition({
      create: vi.fn(async () => created),
      resume: vi.fn(),
      restore: vi.fn(),
    });
    const workspace = await freshBinding(composed);
    await expect(composed.sandbox.acquire({
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
      signal: controller.signal,
    })).rejects.toThrow("claim fenced at ready");
    expect(created.destroy).toHaveBeenCalledOnce();
  });

  it("does not let a terminated marker suppress cleanup of a newly acquired runtime with the same provider id", async () => {
    const first = runtime("stable-provider-id");
    const second = runtime("stable-provider-id");
    const provider = {
      create: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      resume: vi.fn(),
      restore: vi.fn(),
    };
    const composed = composition(provider);
    const acquireGeneration = async (generation: number) => {
      const nextFence = { ...fence, generation };
      const workspace = await composed.workspace.materialize({
        scope,
        fence: nextFence,
        strategy: "retained_runtime",
        activeCheckpoint: null,
        idempotencyKey: `workspace-${generation}`,
        signal: new AbortController().signal,
      });
      return composed.sandbox.acquire({
        scope,
        fence: nextFence,
        plan: {
          workspaceStrategy: "retained_runtime",
          outputStrategy: null,
          runtimeCheckpoint: null,
          driver: { type: "ama_worker", process: { command: "worker" } },
        },
        workspace,
        outputs: null,
        signal: new AbortController().signal,
      });
    };
    const firstLease = await acquireGeneration(1);
    await composed.sandbox.terminate({ scope, fence, lease: firstLease, reason: "completed" });
    const secondLease = await acquireGeneration(2);
    await composed.sandbox.terminate({
      scope,
      fence: { ...fence, generation: 2 },
      lease: secondLease,
      reason: "completed",
    });
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).toHaveBeenCalledOnce();
  });
});
