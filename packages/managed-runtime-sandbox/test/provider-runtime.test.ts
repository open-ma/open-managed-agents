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
    destroy: vi.fn(async () => {}),
    spawnDuplexProcess: vi.fn(async () => completedProcess()),
  };
}

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
    );
    expect(provider.restore).not.toHaveBeenCalled();
  });

  it("restores portable checkpoint candidates and reports a stopped runtime as lost", async () => {
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
    const nextLease = await composed.sandbox.acquire({
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
    });

    expect(provider.restore).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "snapshot-sandbox-1" }),
      expect.any(Object),
      {},
    );
    await expect(
      composed.sandbox.heartbeat({ scope, fence: nextFence, lease: nextLease }),
    ).resolves.toEqual({ type: "lost" });
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
});
