import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { describe, expect, it, vi } from "vitest";

import {
  DaytonaRuntime,
  createDaytonaProvider,
  createDaytonaManagedRuntime,
  createDaytonaManagedRuntimeDriver,
  type DaytonaClientPort,
  type DaytonaSandboxSdkPort,
} from "../src/daytona";
import { fixtureConstructorInputs } from "./fixtures/daytona-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = {
  ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z",
};
const labels = {
  "openma.environment_id": scope.environmentId,
  "openma.session_id": scope.sessionId,
  "openma.mode": "managed",
};

function sandbox(input: {
  id?: string;
  name?: string;
  state?: string;
  labels?: Record<string, string> | undefined;
  execute?: Record<string, unknown>;
} = {}) {
  const files = new Map<string, Uint8Array>();
  let commandPolls = 0;
  const value = {
    id: input.id ?? "sandbox",
    name: input.name ?? "openma-session",
    state: input.state ?? "started",
    labels: Object.prototype.hasOwnProperty.call(input, "labels") ? input.labels : labels,
    fs: {
      uploadFile: vi.fn(async (bytes: Uint8Array, path: string) => { files.set(path, new Uint8Array(bytes)); }),
      downloadFile: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array([1, 2, 3])),
      createFolder: vi.fn(async () => undefined),
    },
    process: {
      executeCommand: vi.fn(async () => input.execute ?? ({ exitCode: 0, result: "" })),
      createSession: vi.fn(async () => undefined),
      executeSessionCommand: vi.fn(async () => ({ cmdId: "command" })),
      getSessionCommandLogs: vi.fn(async (
        _sessionId: string,
        _commandId: string,
        stdout: (chunk: string) => void,
        stderr: (chunk: string) => void,
      ) => { stdout("out"); stderr("err"); }),
      getSessionCommand: vi.fn(async () => ({
        id: "command", command: "worker", exitCode: commandPolls++ === 0 ? 0 : 0,
      })),
      sendSessionCommandInput: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    },
    refreshData: vi.fn(async () => undefined),
    refreshActivity: vi.fn(async () => undefined),
    start: vi.fn(async () => { value.state = "started"; }),
    stop: vi.fn(async () => { value.state = "stopped"; }),
    delete: vi.fn(async () => { value.state = "destroyed"; }),
    setLabels: vi.fn(async (next: Record<string, string>) => { value.labels = next; }),
    createSnapshot: vi.fn(async () => undefined),
  } satisfies DaytonaSandboxSdkPort;
  return { value, files };
}

function client(value: DaytonaSandboxSdkPort, input: { getError?: unknown; createError?: unknown } = {}) {
  let getAttempt = 0;
  return {
    get: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "getError") && getAttempt++ === 0) {
        throw input.getError;
      }
      return value;
    }),
    create: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "createError")) throw input.createError;
      return value;
    }),
  } satisfies DaytonaClientPort;
}

function runtime(value = sandbox().value) {
  return new DaytonaRuntime({ sandbox: value, environmentId: scope.environmentId, sessionId: scope.sessionId });
}

async function resources(client: DaytonaClientPort, options: Record<string, unknown> = {}) {
  return createDaytonaManagedRuntime({
    client, environmentId: scope.environmentId, leaseTtlMs: 100, ...options,
  });
}

async function acquire(client: DaytonaClientPort, options: Record<string, unknown> = {}) {
  const composition = await resources(client, options);
  const signal = new AbortController().signal;
  const workspace = await composition.workspace.materialize({
    scope, fence, strategy: "retained_runtime", activeCheckpoint: null,
    idempotencyKey: "workspace", signal,
  });
  const lease = await composition.sandbox.acquire({
    scope, fence,
    plan: {
      workspaceStrategy: "retained_runtime", outputStrategy: null, runtimeCheckpoint: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
    },
    workspace, outputs: null, signal,
  });
  return { composition, lease };
}

describe("Daytona provider boundary contracts", () => {
  it("loads the current optional SDK with every constructor option", async () => {
    fixtureConstructorInputs.length = 0;
    await createDaytonaManagedRuntime({
      environmentId: scope.environmentId,
      leaseTtlMs: 100,
      apiKey: "key",
      apiUrl: "https://daytona",
      target: "us",
    });
    await createDaytonaManagedRuntime({ environmentId: scope.environmentId, leaseTtlMs: 100 });
    expect(fixtureConstructorInputs).toEqual([
      { apiKey: "key", apiUrl: "https://daytona", target: "us" },
      {},
    ]);
  });

  it("maps every runtime status and lease heartbeat", async () => {
    const { value } = sandbox();
    const instance = runtime(value);
    expect(instance.runtimeHandle()).toEqual({ provider: "daytona", runtimeId: "sandbox" });
    expect(instance.runtimeCapabilities()).toEqual({
      lease: true, suspend: ["filesystem"], checkpoint: ["filesystem"],
    });
    for (const [state, expected] of [
      ["started", "running"],
      ["stopped", "suspended"],
      ["archived", "suspended"],
      ["paused", "suspended"],
      ["destroyed", "stopped"],
      ["destroying", "stopped"],
      ["creating", "unknown"],
      [undefined, "unknown"],
    ] as const) {
      Object.defineProperty(value, "state", { value: state, writable: true, configurable: true });
      await expect(instance.status()).resolves.toBe(expected);
    }
    await instance.renewLease();
    expect(value.refreshActivity).toHaveBeenCalledOnce();
  });

  it("implements retained suspension and validates every resume field", async () => {
    const { value } = sandbox({ state: "paused" });
    const instance = runtime(value);
    await expect(instance.suspend({ kind: "memory" })).rejects.toThrow("filesystem checkpoint");
    const handle = await instance.suspend({ kind: "filesystem" });
    expect(handle).toMatchObject({ provider: "daytona", sourceRuntimeId: "sandbox", scope: "runtime" });
    for (const invalid of [
      { ...handle, provider: "other" },
      { ...handle, scope: "portable" },
      { ...handle, sourceRuntimeId: "other" },
    ]) {
      await expect(instance.resume(invalid as never)).rejects.toThrow("Incompatible Daytona");
    }
    value.state = "archived";
    await instance.resume(handle);
    expect(value.start).toHaveBeenCalledWith(300);
    value.state = "started";
    await instance.resume(handle);
    expect(value.start).toHaveBeenCalledOnce();
  });

  it("uses stable, experimental, and missing snapshot APIs", async () => {
    const current = sandbox().value;
    await expect(runtime(current).checkpoint({ kind: "memory" })).rejects.toThrow("filesystem only");
    await expect(runtime(current).checkpoint({ kind: "filesystem", name: "snapshot one" })).resolves
      .toMatchObject({ checkpointId: "snapshot-one", scope: "portable" });
    expect(current.createSnapshot).toHaveBeenCalledWith("snapshot-one", 300);

    const experimental = sandbox().value;
    Object.defineProperty(experimental, "createSnapshot", { value: undefined });
    const experimentalSnapshot = vi.fn(async () => undefined);
    Object.defineProperty(experimental, "_experimental_createSnapshot", { value: experimentalSnapshot });
    await runtime(experimental).checkpoint({ kind: "filesystem" });
    expect(experimentalSnapshot).toHaveBeenCalled();

    const unsupported = sandbox().value;
    Object.defineProperty(unsupported, "createSnapshot", { value: undefined });
    await expect(runtime(unsupported).checkpoint({ kind: "filesystem" })).rejects
      .toThrow("does not expose sandbox snapshots");
    await expect(runtime(current).checkpoint({ kind: "filesystem", name: "" })).rejects
      .toThrow("name must not be empty");
    const long = await runtime(current).checkpoint({ kind: "filesystem", name: "x".repeat(120) });
    expect(long.checkpointId).toHaveLength(96);
  });

  it("normalizes execute output and timeout variants", async () => {
    await expect(runtime(sandbox({ execute: { result: "result" } }).value).exec("x"))
      .resolves.toBe("result");
    await expect(runtime(sandbox({ execute: {
      exitCode: 7, result: "fallback", artifacts: { stdout: "stdout ", stderr: "stderr " },
    } }).value).exec("x", 1)).resolves.toBe("stdout \nstderr \n[exit 7]");
    await expect(runtime(sandbox({ execute: { exitCode: 0, artifacts: {} } }).value).exec("x", 1_001))
      .resolves.toBe("");
    await expect(runtime(sandbox({ execute: { exitCode: undefined } }).value).exec("x"))
      .resolves.toBe("");
  });

  it("reads and writes text/binary files and tolerates parent creation failure", async () => {
    const { value, files } = sandbox();
    const instance = runtime(value);
    await expect(instance.writeFile("/workspace/a.txt", "hello")).resolves.toBe("/workspace/a.txt");
    await expect(instance.readFile("/workspace/a.txt")).resolves.toBe("hello");
    await expect(instance.writeFileBytes("relative", new Uint8Array([4]))).resolves.toBe("relative");
    value.fs.createFolder = vi.fn(async () => { throw new Error("already exists"); });
    await instance.writeFileBytes("/workspace/b.bin", new Uint8Array([5]));
    expect(files.get("/workspace/b.bin")).toEqual(new Uint8Array([5]));
  });

  it("builds shell-safe duplex commands and streams stdin/stdout/stderr", async () => {
    const { value } = sandbox();
    const instance = runtime(value);
    const process = await instance.spawnDuplexProcess({
      command: "worker tool", args: ["it's", "safe"], cwd: "/workspace/a b",
      env: { SAFE: "yes", QUOTED: "two words", OMIT: undefined },
    });
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode("input"));
    await writer.close();
    await expect(Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ])).resolves.toEqual(["out", "err", { code: 0, signal: null }]);
    expect(value.process.executeSessionCommand).toHaveBeenCalledWith(
      expect.any(String),
      {
        command: "cd '/workspace/a b' && env SAFE=yes QUOTED='two words' 'worker tool' 'it'\\''s' safe",
        runAsync: true,
        suppressInputEcho: true,
      },
    );
    expect(value.process.sendSessionCommandInput).toHaveBeenCalledWith(expect.any(String), "command", "input");

    const trailing = await instance.spawnDuplexProcess({ command: "worker" });
    const trailingWriter = trailing.stdin.getWriter();
    await trailingWriter.write(new Uint8Array([0xc3]));
    await trailingWriter.close();
    await trailing.exited;
    expect(value.process.sendSessionCommandInput).toHaveBeenCalledWith(expect.any(String), "command", "�");
  });

  it("polls asynchronous commands, maps killed log failures, and makes kill idempotent", async () => {
    const pending = sandbox();
    pending.value.process.getSessionCommand = vi.fn()
      .mockResolvedValueOnce({ id: "command", command: "worker" })
      .mockResolvedValueOnce({ id: "command", command: "worker", exitCode: 3 });
    const polled = await runtime(pending.value).spawnDuplexProcess({ command: "worker" });
    await expect(polled.exited).resolves.toEqual({ code: 3, signal: null });

    const killed = sandbox();
    let rejectLogs!: (reason: unknown) => void;
    killed.value.process.getSessionCommandLogs = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogs = reject; }));
    killed.value.process.deleteSession = vi.fn(async () => { rejectLogs(new Error("stopped")); });
    const process = await runtime(killed.value).spawnDuplexProcess({ command: "worker" });
    await process.kill("SIGKILL");
    await process.kill();
    await expect(process.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(killed.value.process.deleteSession).toHaveBeenCalledTimes(2);

    const failed = sandbox();
    failed.value.process.getSessionCommandLogs = vi.fn(async () => { throw new Error("log failed"); });
    failed.value.process.deleteSession = vi.fn(async () => { throw new Error("cleanup failed"); });
    const failing = await runtime(failed.value).spawnDuplexProcess({ command: "worker" });
    await expect(failing.exited).rejects.toThrow("log failed");
  });

  it("retries destroy after failure and validates ownership", async () => {
    const { value } = sandbox();
    value.delete = vi.fn().mockRejectedValueOnce(new Error("delete failed")).mockResolvedValue(undefined);
    const instance = runtime(value);
    await expect(instance.destroy()).rejects.toThrow("delete failed");
    await instance.destroy();
    await instance.destroy();
    expect(value.delete).toHaveBeenCalledTimes(2);
    await expect(instance.status()).resolves.toBe("stopped");

    await expect(runtime(sandbox({ labels: undefined }).value).validateOwnership()).rejects.toThrow("ownership labels");
    for (const foreign of [
      { ...labels, "openma.environment_id": "other" },
      { ...labels, "openma.session_id": "other" },
      { ...labels, "openma.mode": "other" },
    ]) {
      await expect(runtime(sandbox({ labels: foreign }).value).validateOwnership()).rejects.toThrow("ownership labels");
    }
    await expect(runtime(sandbox().value).validateOwnership()).resolves.toBeUndefined();
  });

  it("creates, attaches, starts, and configures every Daytona sandbox option", async () => {
    const created = sandbox({ state: "stopped" });
    const sdk = client(created.value, { getError: { response: { status: 404 } } });
    await acquire(sdk, {
      snapshot: "base", image: "ignored", autoStopInterval: 1, autoPauseInterval: 2,
      autoArchiveInterval: 3, autoDeleteInterval: 4, networkBlockAll: true,
      networkAllowList: "10.0.0.0/8", domainAllowList: "example.com", outboundProxyUrl: "https://proxy",
    });
    expect(sdk.create).toHaveBeenCalledWith({
      name: "openma-session",
      snapshot: "base",
      labels,
      autoStopInterval: 1,
      autoPauseInterval: 2,
      autoArchiveInterval: 3,
      autoDeleteInterval: 4,
      networkBlockAll: true,
      networkAllowList: "10.0.0.0/8",
      domainAllowList: "example.com",
      outboundProxyUrl: "https://proxy",
    }, { timeout: 300 });
    expect(created.value.start).toHaveBeenCalledWith(300);

    const defaults = sandbox();
    const defaultClient = client(defaults.value, { getError: Object.assign(new Error(), { name: "DaytonaNotFoundError" }) });
    await acquire(defaultClient, { image: undefined });
    expect(defaultClient.create).toHaveBeenCalledWith(expect.objectContaining({ image: "node:22-slim" }), { timeout: 300 });
  });

  it("propagates non-not-found and non-conflict failures and recognizes all status shapes", async () => {
    const value = sandbox().value;
    for (const error of [
      "plain",
      null,
      { statusCode: "404" },
      { status: 500 },
      { response: null },
      { response: { status: "404" } },
      new Error("ordinary"),
    ]) {
      await expect(acquire(client(value, { getError: error }))).rejects.toBe(error);
    }
    for (const getError of [{ status: 404 }, { statusCode: 404 }]) {
      const createError = { response: { status: 500 } };
      await expect(acquire(client(value, { getError, createError }))).rejects.toBe(createError);
    }
    const conflict = Object.assign(new Error("conflict"), { name: "DaytonaConflictError" });
    await expect(acquire(client(value, { getError: { status: 404 }, createError: conflict }))).resolves.toBeDefined();
  });

  it("restores portable checkpoints, validates them, and resolves restore conflicts", async () => {
    const value = sandbox({ state: "paused" }).value;
    const sdk = client(value);
    const providerCheckpoint = {
      provider: "daytona", checkpointId: "snap/id", sourceRuntimeId: "old",
      kind: "filesystem" as const, scope: "portable" as const,
    };
    const provider = createDaytonaProvider(sdk, { client: sdk, leaseTtlMs: 100 }, scope.environmentId);
    await provider.restore(
      providerCheckpoint,
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
    );
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ snapshot: "snap/id" }), { timeout: 300 });

    for (const invalid of [
      { ...providerCheckpoint, provider: "other" },
      { ...providerCheckpoint, kind: "memory" },
      { ...providerCheckpoint, scope: "runtime" },
    ]) {
      await expect(provider.restore(
        invalid as never,
        { sessionId: scope.sessionId, workdir: "/workspace" },
        {},
      )).rejects.toThrow("incompatible workspace checkpoint");
    }

    const conflictClient = client(value, {
      createError: Object.assign(new Error("conflict"), { statusCode: 409 }),
    });
    const conflictProvider = createDaytonaProvider(
      conflictClient, { client: conflictClient, leaseTtlMs: 100 }, scope.environmentId,
    );
    await expect(conflictProvider.restore(
      providerCheckpoint,
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
    )).resolves.toBeDefined();

    await expect(provider.resume(
      { provider: "other", runtimeId: "sandbox" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {},
    )).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume(
      { provider: "daytona", runtimeId: "" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {},
    )).rejects.toThrow("incompatible runtime handle");
    Object.defineProperty(value, "state", { value: undefined, writable: true, configurable: true });
    await expect(provider.resume(
      { provider: "daytona", runtimeId: "sandbox" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {},
    )).resolves.toBeInstanceOf(DaytonaRuntime);

    const restoreFailure = new Error("restore failed");
    const failingClient = client(value, { createError: restoreFailure });
    await expect(createDaytonaProvider(
      failingClient, { client: failingClient, leaseTtlMs: 100 }, scope.environmentId,
    ).restore(
      providerCheckpoint,
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
    )).rejects.toBe(restoreFailure);
  });

  it("projects optional outputs, credentials, session inputs, readiness, and placement", async () => {
    const value = sandbox().value;
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined,
      revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn() };
    const driver = createDaytonaManagedRuntimeDriver({
      client: client(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore(),
      outputKeyPrefix: "outputs", credentialEgress: egress, sessionInputs,
      readiness: { timeoutMs: 500 },
    });
    expect(driver.descriptor()).toMatchObject({
      capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } },
      credentialEgress: egress.capabilities,
    });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects.toThrow("does not support");
    const projected = await driver.create({ placement: "in_process", environmentId: scope.environmentId } as never);
    expect(projected).toMatchObject({ sessionInputs });
    await expect(projected.credentialEgress?.capabilities(scope)).resolves.toEqual(egress.capabilities);

    const plain = createDaytonaManagedRuntimeDriver({ client: client(value), leaseTtlMs: 100, outputStore: null });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    const plainProjected = await plain.create({ placement: "in_process", environmentId: scope.environmentId } as never);
    expect(plainProjected).not.toHaveProperty("credentialEgress");
    expect(plainProjected).not.toHaveProperty("sessionInputs");

    const defaultOutput = await createDaytonaManagedRuntime({
      client: client(value), environmentId: scope.environmentId, leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(),
    });
    await expect(defaultOutput.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });
  });

  it("reaps only a sandbox whose ownership still matches", async () => {
    const value = sandbox().value;
    const sdk = client(value);
    const { composition, lease } = await acquire(sdk);
    await composition.sandbox.reap({ scope, lease, reason: "completed" });
    expect(value.delete).toHaveBeenCalledWith(300, true);
  });
});
