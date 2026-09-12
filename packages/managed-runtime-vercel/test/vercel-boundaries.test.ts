import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  VercelRuntime,
  createVercelManagedRuntime,
  createVercelManagedRuntimeDriver,
  createVercelProvider,
  type VercelCommandFinishedPort,
  type VercelCommandPort,
  type VercelNetworkPolicy,
  type VercelSandboxSdkPort,
  type VercelSdkPort,
} from "../src/vercel";
import { vercelFixtureCalls } from "./fixtures/vercel-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" };
const name = "oma-3f3af1ecebbd1410ab417ec0d27bbfcb";
const tags = { openma: "managed", oma_env: "ba5285161ba6eed0085fb137", oma_session: "3f3af1ecebbd1410ab417ec0" };

function finished(input: { code?: number; stdout?: string; stderr?: string } = {}): VercelCommandFinishedPort {
  return { exitCode: input.code ?? 0, stdout: vi.fn(async () => input.stdout ?? ""), stderr: vi.fn(async () => input.stderr ?? "") };
}

function detached(input: { code?: number; error?: unknown } = {}): VercelCommandPort {
  return {
    wait: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "error")) throw input.error;
      return { exitCode: input.code ?? 0 };
    }),
    kill: vi.fn(async () => undefined),
  };
}

function sandbox(input: {
  name?: string;
  status?: string;
  persistent?: boolean;
  tags?: Record<string, string>;
  snapshot?: string | null;
  currentSnapshotId?: string;
  command?: VercelCommandFinishedPort;
  child?: VercelCommandPort;
  file?: Buffer | null;
  deleteError?: unknown;
  onReady?: () => void;
  expiresAt?: Date;
} = {}): VercelSandboxSdkPort {
  const runCommandMock = vi.fn(async (commandInput: { detached?: boolean; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }) => {
    if (commandInput.detached === true) {
      commandInput.stdout?.write("out");
      commandInput.stderr?.write("err");
      return input.child ?? detached({ code: 4 });
    }
    input.onReady?.();
    return input.command ?? finished();
  });
  return {
    name: input.name ?? name,
    status: input.status ?? "running",
    persistent: input.persistent ?? true,
    tags: Object.prototype.hasOwnProperty.call(input, "tags") ? input.tags : tags,
    currentSnapshotId: input.currentSnapshotId,
    expiresAt: input.expiresAt,
    extendTimeout: vi.fn(async () => undefined),
    runCommand: runCommandMock as VercelSandboxSdkPort["runCommand"],
    mkDir: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => Object.prototype.hasOwnProperty.call(input, "file") ? input.file! : Buffer.from([1, 2, 3])),
    writeFiles: vi.fn(async () => undefined),
    stop: vi.fn(async () => input.snapshot === null ? {} : { snapshot: input.snapshot === undefined ? undefined : { id: input.snapshot } }),
    updateNetworkPolicy: vi.fn(async (policy) => policy),
    delete: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "deleteError")) throw input.deleteError;
    }),
  };
}

function sdk(value: VercelSandboxSdkPort, input: { getError?: unknown } = {}): VercelSdkPort {
  return {
    getOrCreate: vi.fn(async () => value),
    get: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "getError")) throw input.getError;
      return value;
    }),
  };
}

function acquisition(signal = new AbortController().signal) {
  return {
    scope, fence,
    plan: {
      workspaceStrategy: "retained_runtime" as const, outputStrategy: null, runtimeCheckpoint: null,
      driver: { type: "ama_worker" as const, process: { command: "worker" } },
    },
    workspace: { bindingId: "workspace", mountPath: "/workspace" as const },
    outputs: null,
    credentialEgress: null,
    environment: {
      type: "base" as const,
      identity: "vercel:preinstalled",
      artifact: { type: "preinstalled" as const },
    },
    signal,
  };
}

describe("Vercel provider boundary contracts", () => {
  it("adapts official SDK credentials for create and resume", async () => {
    vercelFixtureCalls.length = 0;
    const credentials = { token: "token", teamId: "team", projectId: "project" };
    const provider = createVercelProvider({ credentials });
    const created = await provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    await provider.resume(created.runtimeHandle(), { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(vercelFixtureCalls).toEqual(expect.arrayContaining([
      { type: "getOrCreate", input: expect.objectContaining({ ...credentials, name, persistent: true, resume: true }) },
      { type: "get", input: expect.objectContaining({ ...credentials, name, resume: true }) },
    ]));
    vercelFixtureCalls.length = 0;
    await createVercelProvider({}).create({ sessionId: "other-session", workdir: "/workspace" }, {}, acquisition());
    expect(vercelFixtureCalls[0]?.input).not.toEqual(expect.objectContaining({ token: expect.anything() }));
  });

  it("maps all lifecycle states and renewal guarantees", async () => {
    await expect(new VercelRuntime(sandbox({ status: "stopped" })).status()).resolves.toBe("suspended");
    for (const status of ["failed", "ABORTED"]) await expect(new VercelRuntime(sandbox({ status })).status()).resolves.toBe("stopped");
    for (const status of ["running", "PENDING", "snapshotting", "stopping"]) await expect(new VercelRuntime(sandbox({ status })).status()).resolves.toBe("running");
    await expect(new VercelRuntime(sandbox({ status: "queued" })).status()).resolves.toBe("unknown");
    const value = sandbox({ expiresAt: new Date("2026-09-01T00:00:30.000Z") });
    const runtime = new VercelRuntime(value, () => Date.parse("2026-09-01T00:00:00.000Z"));
    expect(runtime.runtimeHandle()).toEqual({ provider: "vercel", runtimeId: name });
    expect(runtime.runtimeCapabilities()).toEqual({ lease: true, suspend: ["filesystem"], checkpoint: [] });
    await expect(runtime.renewLease({ ttlMs: 90_000 })).resolves.toBeUndefined();
    expect(value.extendTimeout).toHaveBeenCalledWith(60_000);
    await expect(runtime.renewLease({ ttlMs: 20_000 })).resolves.toBeUndefined();
    expect(value.extendTimeout).toHaveBeenCalledTimes(1);
    await expect(runtime.renewLease({ ttlMs: 0 })).rejects.toThrow("positive finite");
    await expect(new VercelRuntime(sandbox({ status: "failed", persistent: false })).renewLease({ ttlMs: 10 }))
      .rejects.toThrow("no longer available");
    await expect(new VercelRuntime(sandbox({ status: "failed", persistent: true })).renewLease({ ttlMs: 10 }))
      .rejects.toThrow("no longer available");
  });

  it("uses provider snapshot fallback order and validates retained handles", async () => {
    for (const [value, expected] of [
      [sandbox({ snapshot: "fresh", currentSnapshotId: "current" }), "fresh"],
      [sandbox({ snapshot: null, currentSnapshotId: "current" }), "current"],
      [sandbox({ snapshot: null }), name],
    ] as const) {
      const runtime = new VercelRuntime(value);
      const handle = await runtime.suspend({ kind: "filesystem" });
      expect(handle.checkpointId).toBe(expected);
    }
    const runtime = new VercelRuntime(sandbox());
    await expect(runtime.suspend({ kind: "memory" })).rejects.toThrow("only retains filesystem");
    const handle = await runtime.suspend({ kind: "filesystem" });
    for (const invalid of [{ ...handle, provider: "other" }, { ...handle, scope: "portable" }, { ...handle, sourceRuntimeId: "other" }]) {
      await expect(runtime.resume(invalid as never)).rejects.toThrow("only resume its own");
    }
    await expect(runtime.resume(handle)).resolves.toBeUndefined();
    await expect(runtime.checkpoint()).rejects.toThrow("not promoted to portable");
    await expect(new VercelRuntime(sandbox({ command: finished({ code: 1 }) })).suspend({ kind: "filesystem" }))
      .rejects.toThrow("sync failed");
  });

  it("executes commands and exposes files and network policies", async () => {
    const value = sandbox({ command: finished({ stdout: "out ", stderr: "warn " }) });
    const runtime = new VercelRuntime(value);
    await expect(runtime.exec("echo", 5)).resolves.toBe("out \nwarn");
    await expect(new VercelRuntime(sandbox({ command: finished({ code: 7 }) })).exec("false")).resolves.toBe("\n[exit 7]");
    await expect(runtime.readFile("/workspace/a")).resolves.toBe("\u0001\u0002\u0003");
    await expect(runtime.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(new VercelRuntime(sandbox({ file: null })).readFile("/missing")).rejects.toThrow("file not found");
    await expect(new VercelRuntime(sandbox({ file: null })).readFileBytes("/missing")).rejects.toThrow("file not found");
    await expect(runtime.writeFile("/workspace/a", "text")).resolves.toBe("/workspace/a");
    await expect(runtime.writeFileBytes("/workspace/a", new Uint8Array([4]))).resolves.toBe("/workspace/a");
    const signal = new AbortController().signal;
    await runtime.updateNetworkPolicy("deny-all", { signal });
    expect(value.updateNetworkPolicy).toHaveBeenCalledWith("deny-all", { signal });
  });

  it("streams detached output and preserves process failures and kill signals", async () => {
    const process = detached({ code: 4 });
    const value = sandbox({ child: process });
    const child = await new VercelRuntime(value).spawnDuplexProcess({
      command: "worker", args: ["--poll"], cwd: "/workspace/project", env: { KEY: "value", OMIT: undefined },
    });
    await expect(child.stdin.getWriter().write(new Uint8Array([1]))).rejects.toThrow("does not expose streaming stdin");
    await expect(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]))
      .resolves.toEqual(["out", "err", { code: 4, signal: null }]);
    expect(value.runCommand).toHaveBeenCalledWith({
      cmd: "worker", args: ["--poll"], cwd: "/workspace/project", env: { KEY: "value" }, detached: true,
      stdout: expect.any(PassThrough), stderr: expect.any(PassThrough),
    });
    await child.kill();
    await child.kill("SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    const defaults = sandbox({ child: detached() });
    await new VercelRuntime(defaults).spawnDuplexProcess({ command: "worker" });
    expect(defaults.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "worker", cwd: "/workspace", detached: true }));
    expect(defaults.runCommand).toHaveBeenCalledWith(expect.not.objectContaining({ args: expect.anything(), env: expect.anything() }));

    for (const error of [new Error("process failed"), "process failed"]) {
      const failed = await new VercelRuntime(sandbox({ child: detached({ error }) })).spawnDuplexProcess({ command: "worker" });
      await expect(failed.exited).rejects.toBe(error);
      await expect(new Response(failed.stdout).text()).rejects.toThrow("process failed");
      await expect(new Response(failed.stderr).text()).rejects.toThrow("process failed");
    }
  });

  it("retries failed deletion and makes successful destruction idempotent", async () => {
    const value = sandbox({ deleteError: new Error("delete failed") });
    const runtime = new VercelRuntime(value);
    await expect(runtime.destroy()).rejects.toThrow("delete failed");
    (value.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await runtime.destroy();
    await runtime.destroy();
    expect(value.delete).toHaveBeenCalledTimes(2);
    await expect(runtime.status()).resolves.toBe("stopped");
    await expect(runtime.renewLease({ ttlMs: 10 })).rejects.toThrow("no longer available");
  });

  it("requires acquisition, validates ownership and persistence, and honors aborts", async () => {
    const provider = createVercelProvider({ client: sdk(sandbox()) });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined)).rejects.toThrow("requires acquisition context");
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal))).rejects.toThrow();
    for (const invalid of [sandbox({ name: "other" }), sandbox({ persistent: false }), sandbox({ tags: undefined }), sandbox({ tags: {} }), sandbox({ tags: { ...tags, oma_session: "other" } })]) {
      await expect(createVercelProvider({ client: sdk(invalid) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toThrow("persistence or ownership tags");
    }
  });

  it("applies create options and policy before readiness", async () => {
    const value = sandbox();
    const client = sdk(value);
    const policy: VercelNetworkPolicy = { allow: ["example.com"] };
    const createOptions = vi.fn(() => ({ image: "node:24", timeout: 500 }));
    await createVercelProvider({ client, createOptions, networkPolicy: () => policy }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    );
    expect(client.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ image: "node:24", timeout: 500, name, tags, networkPolicy: policy }));
    expect(createOptions).toHaveBeenCalledWith(expect.objectContaining({ name, ownershipTags: tags }));
    expect(value.updateNetworkPolicy).toHaveBeenCalledWith(policy, { signal: expect.any(AbortSignal) });
  });

  it("rejects readiness failure and aborts occurring during preparation", async () => {
    await expect(createVercelProvider({ client: sdk(sandbox({ command: finished({ code: 1 }) })) }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toThrow("readiness probe exited with 1");
    for (const phase of ["mkdir", "probe"] as const) {
      const controller = new AbortController();
      const value = sandbox({ onReady: phase === "probe" ? () => controller.abort() : undefined });
      if (phase === "mkdir") (value.mkDir as ReturnType<typeof vi.fn>).mockImplementation(async () => { controller.abort(); });
      await expect(createVercelProvider({ client: sdk(value) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(controller.signal),
      )).rejects.toThrow();
    }
  });

  it("validates resume input and reap ownership", async () => {
    const value = sandbox();
    const provider = createVercelProvider({ client: sdk(value) });
    await expect(provider.resume({ provider: "other", runtimeId: name }, {} as never, {}, acquisition())).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "vercel", runtimeId: "" }, {} as never, {}, acquisition())).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "vercel", runtimeId: name }, {} as never, {}, undefined)).rejects.toThrow("requires acquisition context");
    await expect(provider.resume({ provider: "vercel", runtimeId: name }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .resolves.toBeInstanceOf(VercelRuntime);
    await expect(provider.restore({} as never, {} as never, {}, acquisition())).rejects.toThrow("does not advertise portable workspace restore");

    const lease = { leaseId: "lease", runtimeId: name, provider: "vercel", expiresAt: fence.expiresAt, handle: { provider: "vercel", runtimeId: name }, sandbox: {} as never };
    const live = createVercelManagedRuntime({ client: sdk(value), leaseTtlMs: 100 });
    await live.sandbox.reap({ scope, lease, reason: "orphan" } as never);
    expect(value.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
    for (const error of [new Error("not found"), new Error("not_found"), new Error("not-found"), new Error("404")]) {
      await expect(createVercelManagedRuntime({ client: sdk(value, { getError: error }), leaseTtlMs: 100 }).sandbox.reap(
        { scope, lease, reason: "orphan" } as never,
      )).resolves.toBeUndefined();
    }
    for (const error of ["network", new Error("network")]) {
      await expect(createVercelManagedRuntime({ client: sdk(value, { getError: error }), leaseTtlMs: 100 }).sandbox.reap(
        { scope, lease, reason: "orphan" } as never,
      )).rejects.toBe(error);
    }
    const foreign = sandbox({ tags: {} });
    await expect(createVercelManagedRuntime({ client: sdk(foreign), leaseTtlMs: 100 }).sandbox.reap(
      { scope, lease, reason: "orphan" } as never,
    )).rejects.toThrow("ownership tags");
  });

  it("projects outputs, credentials, session inputs, readiness, and placement", async () => {
    const value = sandbox();
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined, revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn(), synchronize: vi.fn() };
    const driver = createVercelManagedRuntimeDriver({
      client: sdk(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore(), credentialEgress: egress,
      sessionInputs, readiness: { timeoutMs: 500 },
    });
    expect(driver.descriptor()).toMatchObject({ capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } }, credentialEgress: egress.capabilities });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects.toThrow("does not support");
    expect(await driver.create({ placement: "in_process" } as never)).toMatchObject({ sessionInputs });
    const plain = createVercelManagedRuntimeDriver({ client: sdk(value), leaseTtlMs: 100, outputStore: null });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    expect(await plain.create({ placement: "in_process" } as never)).not.toHaveProperty("credentialEgress");
    const withOutput = createVercelManagedRuntime({ client: sdk(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore() });
    await expect(withOutput.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });
  });
});
