import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { describe, expect, it, vi } from "vitest";

import {
  SuperserveRuntime,
  createSuperserveManagedRuntime,
  createSuperserveManagedRuntimeDriver,
  createSuperserveProvider,
  type SuperserveCommandResult,
  type SuperserveCommandSessionPort,
  type SuperserveSandboxInfo,
  type SuperserveSandboxSdkPort,
  type SuperserveSdkPort,
} from "../src/superserve";
import { superserveFixtureCalls } from "./fixtures/superserve-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" };
const name = "oma-3f3af1ecebbd1410ab417ec0d27bbfcb";
const metadata = { openma: "managed", oma_env: "ba5285161ba6eed0085fb137", oma_session: "3f3af1ecebbd1410ab417ec0" };

function result(input: Partial<SuperserveCommandResult> = {}): SuperserveCommandResult {
  return { stdout: input.stdout ?? "", stderr: input.stderr ?? "", exitCode: input.exitCode ?? 0, truncated: input.truncated ?? false };
}

function process(input: { result?: SuperserveCommandResult; error?: unknown } = {}): SuperserveCommandSessionPort {
  return {
    stdin: { write: vi.fn(), close: vi.fn() },
    kill: vi.fn(),
    wait: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "error")) throw input.error;
      return input.result ?? result();
    }),
    close: vi.fn(async () => undefined),
  };
}

function sandbox(input: {
  id?: string;
  name?: string;
  metadata?: Record<string, string>;
  status?: string;
  infoError?: unknown;
  run?: SuperserveCommandResult;
  process?: SuperserveCommandSessionPort;
  killError?: unknown;
} = {}): SuperserveSandboxSdkPort {
  let status = input.status ?? "active";
  const id = input.id ?? "sandbox";
  const sandboxName = input.name ?? name;
  const sandboxMetadata = input.metadata ?? metadata;
  return {
    id,
    name: sandboxName,
    get status() { return status; },
    metadata: sandboxMetadata,
    commands: {
      run: vi.fn(async () => input.run ?? result()),
      spawn: vi.fn(async (_command, options) => {
        queueMicrotask(() => {
          options?.onStdout?.("out");
          options?.onStderr?.("err");
        });
        return input.process ?? process({ result: result({ exitCode: 4 }) });
      }),
    },
    files: {
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      readText: vi.fn(async () => "text"),
    },
    getInfo: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "infoError")) throw input.infoError;
      return { id, name: sandboxName, status, metadata: sandboxMetadata };
    }),
    pause: vi.fn(async () => { status = "paused"; }),
    resume: vi.fn(async () => { status = "active"; }),
    kill: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "killError")) throw input.killError;
      status = "failed";
    }),
    update: vi.fn(async () => undefined),
    attachSecret: vi.fn(async () => undefined),
    detachSecret: vi.fn(async () => undefined),
  };
}

function info(value: SuperserveSandboxSdkPort, input: { status?: string; name?: string; metadata?: Record<string, string> } = {}): SuperserveSandboxInfo {
  return { id: value.id, name: input.name ?? value.name, status: input.status ?? value.status, metadata: input.metadata ?? value.metadata };
}

function sdk(value: SuperserveSandboxSdkPort, input: {
  boxes?: SuperserveSandboxInfo[];
  lists?: SuperserveSandboxInfo[][];
  createError?: unknown;
  connectError?: unknown;
  killError?: unknown;
} = {}): SuperserveSdkPort {
  let listIndex = 0;
  return {
    create: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "createError")) throw input.createError;
      return value;
    }),
    connect: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "connectError")) throw input.connectError;
      return value;
    }),
    list: vi.fn(async () => input.lists?.[listIndex++] ?? input.boxes ?? []),
    killById: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "killError")) throw input.killError;
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
    outputs: null, credentialEgress: null, signal,
  };
}

describe("Superserve provider boundary contracts", () => {
  it("adapts every official SDK operation and connection option", async () => {
    superserveFixtureCalls.length = 0;
    const provider = createSuperserveProvider({ credentials: { apiKey: "key", baseUrl: "https://superserve" }, fromTemplate: "template" });
    const created = await provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    await provider.resume(created.runtimeHandle(), { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(superserveFixtureCalls).toEqual(expect.arrayContaining([
      { type: "list", input: expect.objectContaining({ apiKey: "key", baseUrl: "https://superserve", metadata }) },
      { type: "create", input: expect.objectContaining({ apiKey: "key", baseUrl: "https://superserve", fromTemplate: "template" }) },
      { type: "connect", input: expect.objectContaining({ id: created.runtimeHandle().runtimeId, options: expect.objectContaining({ apiKey: "key", baseUrl: "https://superserve" }) }) },
    ]));
    const runtime = createSuperserveManagedRuntime({ credentials: { apiKey: "key" }, leaseTtlMs: 100 });
    const lease = { leaseId: "lease", runtimeId: created.runtimeHandle().runtimeId, provider: "superserve", expiresAt: fence.expiresAt, handle: created.runtimeHandle(), sandbox: {} as never };
    await runtime.sandbox.reap({ scope, lease, reason: "completed" } as never);
    expect(superserveFixtureCalls).toContainEqual({
      type: "kill", input: { id: created.runtimeHandle().runtimeId, options: { apiKey: "key" } },
    });

    superserveFixtureCalls.length = 0;
    await createSuperserveProvider({}).create(
      { sessionId: "credentialless-session", workdir: "/workspace" }, {}, acquisition(),
    );
    expect(superserveFixtureCalls).toContainEqual({
      type: "list", input: expect.not.objectContaining({ apiKey: expect.anything() }),
    });
  });

  it("maps lifecycle status and rejects renewal for unavailable runtimes", async () => {
    await expect(new SuperserveRuntime(sandbox({ status: "paused" })).status()).resolves.toBe("suspended");
    for (const status of ["failed", "DELETED"]) await expect(new SuperserveRuntime(sandbox({ status })).status()).resolves.toBe("stopped");
    for (const status of ["starting", "ACTIVE", "pausing", "resuming"]) await expect(new SuperserveRuntime(sandbox({ status })).status()).resolves.toBe("running");
    await expect(new SuperserveRuntime(sandbox({ status: "queued" })).status()).resolves.toBe("unknown");
    for (const error of [Object.assign(new Error(), { name: "NotFoundError" }), new Error("not found"), new Error("not_found"), new Error("not-found"), new Error("404")]) {
      await expect(new SuperserveRuntime(sandbox({ infoError: error })).status()).resolves.toBe("stopped");
    }
    await expect(new SuperserveRuntime(sandbox({ infoError: new Error("network") })).status()).resolves.toBe("unknown");
    await expect(new SuperserveRuntime(sandbox({ infoError: "network" })).status()).resolves.toBe("unknown");
    const runtime = new SuperserveRuntime(sandbox());
    expect(runtime.runtimeHandle()).toEqual({ provider: "superserve", runtimeId: "sandbox" });
    expect(runtime.runtimeCapabilities()).toEqual({ lease: false, suspend: ["filesystem"], checkpoint: [] });
    await expect(runtime.renewLease()).resolves.toBeUndefined();
    await expect(new SuperserveRuntime(sandbox({ status: "failed" })).renewLease()).rejects.toThrow("no longer available");
    await expect(new SuperserveRuntime(sandbox({ status: "queued" })).renewLease()).rejects.toThrow("no longer available");
  });

  it("suspends, resumes, and validates retained filesystem handles", async () => {
    const value = sandbox();
    const runtime = new SuperserveRuntime(value);
    await expect(runtime.suspend({ kind: "memory" })).rejects.toThrow("retained filesystem");
    const handle = await runtime.suspend({ kind: "filesystem" });
    expect(value.pause).toHaveBeenCalledOnce();
    for (const invalid of [{ ...handle, provider: "other" }, { ...handle, scope: "portable" }, { ...handle, sourceRuntimeId: "other" }]) {
      await expect(runtime.resume(invalid as never)).rejects.toThrow("only resume its own");
    }
    await runtime.resume(handle);
    expect(value.resume).toHaveBeenCalledOnce();
    await expect(runtime.checkpoint()).rejects.toThrow("not promoted to a portable");
    const failed = sandbox({ run: result({ exitCode: 1, stderr: "sync failed" }) });
    await expect(new SuperserveRuntime(failed).suspend({ kind: "filesystem" })).rejects.toThrow("sync failed");
  });

  it("executes commands and exposes files, network policy, and provider secrets", async () => {
    const value = sandbox({ run: result({ stdout: "out ", stderr: "warn " }) });
    const runtime = new SuperserveRuntime(value);
    await expect(runtime.exec("echo", 5)).resolves.toBe("out \nwarn");
    await expect(new SuperserveRuntime(sandbox({ run: result({ exitCode: 7 }) })).exec("false")).resolves.toBe("\n[exit 7]");
    await expect(runtime.readFile("/workspace/a")).resolves.toBe("text");
    await expect(runtime.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(runtime.writeFile("/workspace/a", "text")).resolves.toBe("/workspace/a");
    await expect(runtime.writeFileBytes("/workspace/a", new Uint8Array([4]))).resolves.toBe("/workspace/a");
    await runtime.updateNetworkPolicy({ allowOut: ["example.com"] });
    await runtime.attachSecret("KEY", "secret");
    await runtime.detachSecret("KEY");
    expect(value.update).toHaveBeenCalledWith({ network: { allowOut: ["example.com"] }, autoDeleteSeconds: null });
    expect(value.attachSecret).toHaveBeenCalledWith("KEY", "secret");
    expect(value.detachSecret).toHaveBeenCalledWith("KEY");
  });

  it("quotes commands, streams duplex output, and closes or errors both streams", async () => {
    const childProcess = process({ result: result({ exitCode: 4 }) });
    const value = sandbox({ process: childProcess });
    const child = await new SuperserveRuntime(value).spawnDuplexProcess({
      command: "echo", args: ["it's", "safe"], cwd: "/workspace/project", env: { KEY: "value", OMIT: undefined },
    });
    const writer = child.stdin.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();
    await expect(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]))
      .resolves.toEqual(["out", "err", { code: 4, signal: null }]);
    expect(value.commands.spawn).toHaveBeenCalledWith("'echo' 'it'\"'\"'s' 'safe'", expect.objectContaining({ cwd: "/workspace/project", env: { KEY: "value" } }));
    await child.kill();
    await child.kill("SIGKILL");
    expect(childProcess.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(childProcess.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    const abortedProcess = process();
    const aborted = await new SuperserveRuntime(sandbox({ process: abortedProcess })).spawnDuplexProcess({ command: "worker" });
    await aborted.stdin.getWriter().abort();
    expect(abortedProcess.close).toHaveBeenCalledOnce();

    for (const error of [new Error("process failed"), "process failed"]) {
      const failed = await new SuperserveRuntime(sandbox({ process: process({ error }) })).spawnDuplexProcess({ command: "worker" });
      await expect(failed.exited).rejects.toBe(error);
      await expect(new Response(failed.stdout).text()).rejects.toThrow("process failed");
      await expect(new Response(failed.stderr).text()).rejects.toThrow("process failed");
    }
  });

  it("retries failed termination and makes successful destruction idempotent", async () => {
    const value = sandbox({ killError: new Error("kill failed") });
    const runtime = new SuperserveRuntime(value);
    await expect(runtime.destroy()).rejects.toThrow("kill failed");
    (value.kill as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await runtime.destroy();
    await runtime.destroy();
    expect(value.kill).toHaveBeenCalledTimes(2);
    await expect(runtime.status()).resolves.toBe("stopped");
  });

  it("requires acquisition, validates ownership, and honors aborted acquisition", async () => {
    const provider = createSuperserveProvider({ client: sdk(sandbox()) });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined)).rejects.toThrow("requires acquisition context");
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal))).rejects.toThrow();
    for (const value of [sandbox({ name: "other" }), sandbox({ metadata: {} }), sandbox({ metadata: { ...metadata, oma_session: "other" } })]) {
      await expect(createSuperserveProvider({ client: sdk(value) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toThrow("ownership metadata");
    }
  });

  it("reuses active owned boxes but skips terminal or differently named candidates", async () => {
    const value = sandbox();
    const active = info(value);
    const client = sdk(value, { boxes: [info(value, { name: "other" }), info(value, { status: "failed" }), active] });
    await createSuperserveProvider({ client }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(client.connect).toHaveBeenCalledWith(value.id, { signal: expect.any(AbortSignal) });
    expect(client.create).not.toHaveBeenCalled();
  });

  it("creates with defaults and overrides, and recovers provider conflicts", async () => {
    const value = sandbox();
    const client = sdk(value);
    const createOptions = vi.fn(() => ({ timeoutSeconds: 5, metadata: { ignored: "value" } }));
    await createSuperserveProvider({
      client, fromTemplate: "template", createOptions,
      network: () => ({ allowOut: ["example.com"], denyOut: [] }),
    }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      name, fromTemplate: "template", timeoutSeconds: 5, metadata, network: { allowOut: ["example.com"], denyOut: [] },
    }));
    expect(createOptions).toHaveBeenCalledWith(expect.objectContaining({ name, ownershipMetadata: metadata }));
    expect(value.update).toHaveBeenCalledWith({ network: { allowOut: ["example.com"], denyOut: [] }, autoDeleteSeconds: null });

    for (const conflict of [Object.assign(new Error("opaque"), { name: "ConflictError" }), new Error("already exists"), new Error("conflict"), new Error("409")]) {
      const winner = sandbox();
      const raced = sdk(winner, { lists: [[], [info(winner)]], createError: conflict });
      await expect(createSuperserveProvider({ client: raced }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).resolves.toBeInstanceOf(SuperserveRuntime);
      expect(raced.create).toHaveBeenCalledOnce();
      expect(raced.connect).toHaveBeenCalledOnce();
    }
    const conflict = new Error("conflict");
    await expect(createSuperserveProvider({ client: sdk(value, { createError: conflict }) }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toBe(conflict);
    for (const failure of ["create failed", {}, new Error("create failed")]) {
      await expect(createSuperserveProvider({ client: sdk(value, { createError: failure }) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toBe(failure);
    }
  });

  it("reports readiness output and catches aborts after readiness", async () => {
    for (const run of [result({ exitCode: 1, stderr: "stderr" }), result({ exitCode: 1, stdout: "stdout" })]) {
      await expect(createSuperserveProvider({ client: sdk(sandbox({ run })) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toThrow(/stderr|stdout/);
    }
    const controller = new AbortController();
    const value = sandbox();
    value.commands.run = vi.fn(async () => { controller.abort(); return result(); });
    await expect(createSuperserveProvider({ client: sdk(value) }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(controller.signal),
    )).rejects.toThrow();
  });

  it("validates resume and recreates a missing retained sandbox", async () => {
    const value = sandbox();
    const provider = createSuperserveProvider({ client: sdk(value) });
    await expect(provider.resume({ provider: "other", runtimeId: "sandbox" }, {} as never, {}, acquisition())).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "superserve", runtimeId: "" }, {} as never, {}, acquisition())).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "superserve", runtimeId: "sandbox" }, {} as never, {}, undefined)).rejects.toThrow("requires acquisition context");
    await expect(provider.resume(
      { provider: "superserve", runtimeId: "sandbox" }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SuperserveRuntime);
    for (const notFound of [Object.assign(new Error(), { name: "NotFoundError" }), new Error("not found"), new Error("404")]) {
      await expect(createSuperserveProvider({ client: sdk(value, { connectError: notFound }) }).resume(
        { provider: "superserve", runtimeId: "expired" }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).resolves.toBeInstanceOf(SuperserveRuntime);
    }
    const failure = new Error("network");
    await expect(createSuperserveProvider({ client: sdk(value, { connectError: failure }) }).resume(
      { provider: "superserve", runtimeId: "sandbox" }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toBe(failure);
    await expect(provider.restore({} as never, {} as never, {}, acquisition())).rejects.toThrow("does not advertise portable workspace restore");
  });

  it("projects optional resources and safely reaps owned runtimes", async () => {
    const value = sandbox();
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined, revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn(), synchronize: vi.fn() };
    const driver = createSuperserveManagedRuntimeDriver({
      client: sdk(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore(), credentialEgress: egress,
      sessionInputs, readiness: { timeoutMs: 500 },
    });
    expect(driver.descriptor()).toMatchObject({ capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } }, credentialEgress: egress.capabilities });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects.toThrow("does not support");
    expect(await driver.create({ placement: "in_process" } as never)).toMatchObject({ sessionInputs });
    const plain = createSuperserveManagedRuntimeDriver({ client: sdk(value), leaseTtlMs: 100, outputStore: null });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    expect(await plain.create({ placement: "in_process" } as never)).not.toHaveProperty("credentialEgress");
    const withOutput = createSuperserveManagedRuntime({ client: sdk(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore() });
    await expect(withOutput.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });

    const lease = { leaseId: "lease", runtimeId: value.id, provider: "superserve", expiresAt: fence.expiresAt, handle: { provider: "superserve", runtimeId: value.id }, sandbox: {} as never };
    const absent = createSuperserveManagedRuntime({ client: sdk(value), leaseTtlMs: 100 });
    await expect(absent.sandbox.reap({ scope, lease, reason: "orphan" } as never)).resolves.toBeUndefined();
    const liveSdk = sdk(value, { boxes: [info(value)] });
    await createSuperserveManagedRuntime({ client: liveSdk, leaseTtlMs: 100 }).sandbox.reap({ scope, lease, reason: "orphan" } as never);
    expect(liveSdk.killById).toHaveBeenCalledWith(value.id);
    const foreign = sandbox({ metadata: {} });
    await expect(createSuperserveManagedRuntime({ client: sdk(foreign, { boxes: [info(foreign)] }), leaseTtlMs: 100 }).sandbox.reap(
      { scope, lease, reason: "orphan" } as never,
    )).rejects.toThrow("ownership metadata");
  });
});
