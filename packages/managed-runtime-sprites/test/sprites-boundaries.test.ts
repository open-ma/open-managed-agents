import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  SpritesRuntime,
  createSpritesManagedRuntime,
  createSpritesManagedRuntimeDriver,
  createSpritesProvider,
  type SpriteCommandPort,
  type SpriteExecResult,
  type SpriteFilesystemPort,
  type SpriteSdkPort,
  type SpritesClientPort,
} from "../src/sprites";
import { spritesFixtureCalls } from "./fixtures/sprites-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" };
const name = "oma-3f3af1ecebbd1410ab417ec0d27bbfcb";
const labels = ["openma-managed", "openma-env-ba5285161ba6eed0085fb137", "openma-session-3f3af1ecebbd1410ab417ec0"];

class Filesystem implements SpriteFilesystemPort {
  readFile(_path: string, encoding: "utf8"): Promise<string>;
  readFile(_path: string, encoding?: null): Promise<Buffer>;
  async readFile(_path: string, encoding: "utf8" | null = null): Promise<string | Buffer> {
    return encoding === "utf8" ? "text" : Buffer.from([1, 2, 3]);
  }
  readonly writeFile = vi.fn(async () => undefined);
  readonly mkdir = vi.fn(async () => undefined);
}

function command(input: { code?: number; start?: () => void | Promise<void> } = {}): SpriteCommandPort {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  queueMicrotask(async () => {
    await input.start?.();
    stdout.end("out");
    stderr.end("err");
  });
  return {
    stdin, stdout, stderr,
    start: vi.fn(async () => { throw new Error("Command already started"); }),
    once(event: "spawn" | "error", listener: (...args: unknown[]) => void) {
      if (event === "spawn") queueMicrotask(listener);
      return this;
    },
    wait: vi.fn(async () => input.code ?? 0),
    kill: vi.fn(),
    close: vi.fn(),
  };
}

function sprite(input: {
  name?: string;
  labels?: string[];
  status?: string;
  checkError?: unknown;
  exec?: Partial<SpriteExecResult>;
  command?: SpriteCommandPort;
} = {}): SpriteSdkPort & { filesystemPort: Filesystem } {
  const filesystemPort = new Filesystem();
  return {
    name: input.name ?? name,
    id: "sprite-id",
    status: input.status ?? "running",
    labels: input.labels ?? labels,
    filesystemPort,
    filesystem: vi.fn(() => filesystemPort),
    execFileHTTP: vi.fn(async () => ({
      stdout: input.exec?.stdout ?? "",
      stderr: input.exec?.stderr ?? "",
      exitCode: input.exec?.exitCode ?? 0,
    })),
    spawn: vi.fn(() => input.command ?? command()),
    check: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "checkError")) throw input.checkError;
      return { status: input.status ?? "running" };
    }),
    updateNetworkPolicy: vi.fn(async () => undefined),
    closeControlConnection: vi.fn(),
    delete: vi.fn(async () => undefined),
  };
}

function client(value: SpriteSdkPort, input: {
  getError?: unknown;
  found?: SpriteSdkPort;
  winner?: SpriteSdkPort;
  createError?: unknown;
  deleteError?: unknown;
} = {}): SpritesClientPort {
  let attempts = 0;
  return {
    getSprite: vi.fn(async () => {
      const attempt = attempts++;
      if (Object.prototype.hasOwnProperty.call(input, "getError") && attempt === 0) throw input.getError;
      if (attempt > 0 && input.winner !== undefined) return input.winner;
      return input.found ?? value;
    }),
    createSprite: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "createError")) throw input.createError;
      return value;
    }),
    deleteSprite: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "deleteError")) throw input.deleteError;
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

describe("Sprites provider boundary contracts", () => {
  it("adapts the official SDK constructor and environment options", async () => {
    spritesFixtureCalls.length = 0;
    const provider = createSpritesProvider({ token: "token", baseURL: "https://sprites", timeoutMs: 123 });
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);
    expect(spritesFixtureCalls).toEqual(expect.arrayContaining([
      { type: "constructor", input: { token: "token", options: { baseURL: "https://sprites", timeout: 123, controlMode: true } } },
      { type: "create", input: expect.objectContaining({ name, options: expect.objectContaining({ labels }) }) },
    ]));
    await expect(provider.resume(
      { provider: "sprites", runtimeId: name }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);

    spritesFixtureCalls.length = 0;
    await expect(createSpritesProvider({ token: "token" }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);
    expect(spritesFixtureCalls).toContainEqual({
      type: "constructor", input: { token: "token", options: { controlMode: true } },
    });
  });

  it("classifies all provider status outcomes and lease renewal", async () => {
    for (const status of ["destroyed", "DELETED", "failed", "stopped"]) {
      await expect(new SpritesRuntime({ client: client(sprite()), sprite: sprite({ status }) }).status()).resolves.toBe("stopped");
    }
    for (const status of ["running", "WARM", "cold", "created"]) {
      await expect(new SpritesRuntime({ client: client(sprite()), sprite: sprite({ status }) }).status()).resolves.toBe("running");
    }
    await expect(new SpritesRuntime({ client: client(sprite()), sprite: sprite({ status: "pending" }) }).status()).resolves.toBe("unknown");
    for (const error of [{ statusCode: 404 }, { status: 404 }, new Error("not found"), new Error("not-found")]) {
      await expect(new SpritesRuntime({ client: client(sprite()), sprite: sprite({ checkError: error }) }).status()).resolves.toBe("stopped");
    }
    await expect(new SpritesRuntime({ client: client(sprite()), sprite: sprite({ checkError: new Error("network") }) }).status())
      .resolves.toBe("unknown");
    const runningSprite = sprite();
    const running = new SpritesRuntime({ client: client(runningSprite), sprite: runningSprite });
    expect(running.runtimeHandle()).toEqual({ provider: "sprites", runtimeId: name });
    expect(running.runtimeCapabilities()).toEqual({ lease: true, suspend: ["filesystem"], checkpoint: [] });
    await expect(running.renewLease({ ttlMs: 90_000 })).resolves.toBeUndefined();
    expect(runningSprite.execFileHTTP).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", expect.stringContaining("PUT /v1/tasks/openma-runtime")],
      expect.objectContaining({ cwd: "/", timeout: 60_000 }),
    );

    const rejected = sprite();
    (rejected.execFileHTTP as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stdout: "",
      stderr: "task api unavailable",
      exitCode: 1,
    });
    await expect(new SpritesRuntime({ client: client(rejected), sprite: rejected }).renewLease({ ttlMs: 90_000 }))
      .rejects.toThrow("keep-alive");
  });

  it("uses an exclusive process lock and releases provider keep-alive before suspend", async () => {
    const value = sprite();
    const runtime = new SpritesRuntime({ client: client(value), sprite: value });
    const process = await runtime.spawnDuplexProcess({
      command: "openma-harness-supervisor",
      args: ["--stdio"],
      cwd: "/workspace",
    });
    await process.exited;
    expect(value.spawn).toHaveBeenCalledWith(
      "/usr/bin/flock",
      [
        "--nonblock",
        "/run/openma-managed-agent.lock",
        "openma-harness-supervisor",
        "--stdio",
      ],
      expect.objectContaining({ cwd: "/workspace", tty: false }),
    );

    await runtime.suspend({ kind: "filesystem" });
    expect(value.execFileHTTP).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", expect.stringContaining("DELETE /v1/tasks/openma-runtime")],
      expect.objectContaining({ cwd: "/", timeout: 60_000 }),
    );
  });

  it("syncs retained filesystems and validates resume handles", async () => {
    const value = sprite();
    const runtime = new SpritesRuntime({ client: client(value), sprite: value });
    await expect(runtime.suspend({ kind: "memory" })).rejects.toThrow("only retain filesystem");
    const handle = await runtime.suspend({ kind: "filesystem" });
    expect(value.closeControlConnection).toHaveBeenCalledOnce();
    expect(handle).toMatchObject({ provider: "sprites", sourceRuntimeId: name, kind: "filesystem" });
    for (const invalid of [
      { ...handle, provider: "other" }, { ...handle, scope: "portable" }, { ...handle, sourceRuntimeId: "other" },
    ]) await expect(runtime.resume(invalid as never)).rejects.toThrow("only resume its own");
    await expect(runtime.resume(handle)).resolves.toBeUndefined();
    await expect(runtime.checkpoint()).rejects.toThrow("not promoted to portable");
    const failed = sprite({ exec: { exitCode: 1, stderr: Buffer.from("sync failed") } });
    await expect(new SpritesRuntime({ client: client(failed), sprite: failed }).suspend({ kind: "filesystem" }))
      .rejects.toThrow("Sprite sync failed: sync failed");
  });

  it("executes commands and exposes byte-safe filesystem and network operations", async () => {
    const value = sprite({ exec: { stdout: Buffer.from("out "), stderr: "warn ", exitCode: 0 } });
    const runtime = new SpritesRuntime({ client: client(value), sprite: value });
    await expect(runtime.exec("echo", 5)).resolves.toBe("out \nwarn");
    const failed = sprite({ exec: { exitCode: 9 } });
    await expect(new SpritesRuntime({ client: client(failed), sprite: failed }).exec("false")).resolves.toBe("\n[exit 9]");
    await expect(runtime.readFile("/workspace/a")).resolves.toBe("text");
    await expect(runtime.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(runtime.writeFile("/workspace/a", "text")).resolves.toBe("/workspace/a");
    await expect(runtime.writeFileBytes("/workspace/a", new Uint8Array([4]))).resolves.toBe("/workspace/a");
    await runtime.updateNetworkPolicy({ rules: [{ domain: "example.com", action: "allow" }] });
    expect(value.updateNetworkPolicy).toHaveBeenCalledWith({ rules: [{ domain: "example.com", action: "allow" }] });
  });

  it("projects and flushes generation-scoped Memory workspaces when the host supplies a bridge", async () => {
    const value = sprite({
      exec: { stdout: "/mnt/memory/project/notes/alpha.txt\0", exitCode: 0 },
    });
    const put = vi.fn(async () => ({ etag: "etag", size: 4 }));
    const remove = vi.fn(async () => undefined);
    const memoryWorkspace = {
      getText: vi.fn(async (key: string) => ({ text: key.endsWith("alpha.txt") ? "alpha" : "stale" })),
      list: vi.fn(async () => ({
        keys: ["snapshot/data/notes/alpha.txt", "snapshot/data/notes/deleted.txt"],
        nextCursor: null,
      })),
      put,
      delete: remove,
    };
    const runtime = await createSpritesProvider({
      client: client(value),
      memoryWorkspace,
    }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
      acquisition(),
    );

    expect(runtime.mountMemoryStore).toBeTypeOf("function");
    expect(runtime.synchronizeMemoryStores).toBeTypeOf("function");
    await runtime.mountMemoryStore!({
      storeName: "project",
      storeId: "snapshot/data",
      readOnly: false,
    });
    expect(value.filesystemPort.writeFile).toHaveBeenCalledWith(
      "/mnt/memory/project/notes/alpha.txt",
      "alpha",
    );
    await runtime.synchronizeMemoryStores!();
    expect(put).toHaveBeenCalledWith("snapshot/data/notes/alpha.txt", "text");
    expect(remove).toHaveBeenCalledWith("snapshot/data/notes/deleted.txt");

    await expect(runtime.mountMemoryStore!({
      storeName: "../escape",
      storeId: "snapshot/data",
      readOnly: false,
    })).rejects.toThrow(/safe path segment/i);
  });

  it("preserves native duplex streams and process termination semantics", async () => {
    const process = command({ code: 4 });
    const value = sprite({ command: process });
    const child = await new SpritesRuntime({ client: client(value), sprite: value }).spawnDuplexProcess({
      command: "worker", args: ["--poll"], cwd: "/workspace/project", env: { KEY: "value", OMIT: undefined },
    });
    await expect(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]))
      .resolves.toEqual(["out", "err", { code: 4, signal: null }]);
    expect(process.close).toHaveBeenCalledOnce();
    expect(value.spawn).toHaveBeenCalledWith("/usr/bin/flock", [
      "--nonblock",
      "/run/openma-managed-agent.lock",
      "worker",
      "--poll",
    ], {
      cwd: "/workspace/project", env: { KEY: "value" }, tty: false, maxRunAfterDisconnect: "1h",
    });
    await child.kill();
    await child.kill("SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    const defaults = sprite({ command: command() });
    await new SpritesRuntime({ client: client(defaults), sprite: defaults }).spawnDuplexProcess({ command: "worker" });
    expect(defaults.spawn).toHaveBeenCalledWith("/usr/bin/flock", [
      "--nonblock",
      "/run/openma-managed-agent.lock",
      "worker",
    ], {
      cwd: "/workspace", tty: false, maxRunAfterDisconnect: "1h",
    });
  });

  it("retries failed destruction and makes successful destruction idempotent", async () => {
    const value = sprite();
    const sdk = client(value, { deleteError: new Error("delete failed") });
    const runtime = new SpritesRuntime({ client: sdk, sprite: value });
    await expect(runtime.destroy()).rejects.toThrow("delete failed");
    (sdk.deleteSprite as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await runtime.destroy();
    await runtime.destroy();
    expect(sdk.deleteSprite).toHaveBeenCalledTimes(2);
    await expect(runtime.status()).resolves.toBe("stopped");
  });

  it("requires acquisition and validates identity before readiness", async () => {
    const value = sprite();
    const provider = createSpritesProvider({ client: client(value) });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined))
      .rejects.toThrow("requires acquisition context");
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal),
    )).rejects.toThrow();
    for (const invalid of [
      sprite({ name: "other" }),
      sprite({ labels: [] }),
      sprite({ labels: labels.slice(1) }),
    ]) {
      await expect(createSpritesProvider({ client: client(invalid) }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toThrow("ownership labels");
    }
  });

  it("creates after not-found, recovers conflicts, applies optional policy, and rejects failures", async () => {
    const notFoundErrors = [{ statusCode: 404 }, { status: 404 }, new Error("not found"), new Error("not-found")];
    for (const notFound of notFoundErrors) {
      const value = sprite();
      const sdk = client(value, { getError: notFound });
      await expect(createSpritesProvider({
        client: sdk,
        createOptions: () => ({ config: { cpus: 2 } }),
        networkPolicy: () => ({ rules: [{ domain: "example.com", action: "allow" }] }),
      }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .resolves.toBeInstanceOf(SpritesRuntime);
      expect(sdk.createSprite).toHaveBeenCalledWith(name, expect.objectContaining({ labels, config: { cpus: 2 } }));
      expect(value.updateNetworkPolicy).toHaveBeenCalledWith({ rules: [{ domain: "example.com", action: "allow" }] });
    }
    for (const conflict of [{ statusCode: 409 }, { status: 409 }, new Error("already exists"), new Error("conflict")]) {
      const winner = sprite();
      const sdk = client(winner, { getError: { statusCode: 404 }, createError: conflict, winner });
      await expect(createSpritesProvider({ client: sdk }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).resolves.toBeInstanceOf(SpritesRuntime);
      expect(sdk.createSprite).toHaveBeenCalledOnce();
      expect(sdk.getSprite).toHaveBeenCalledTimes(2);
    }
    for (const error of ["network", {}, new Error("network")]) {
      await expect(createSpritesProvider({
        client: client(sprite(), { getError: error }),
        lifecycleRetry: { wait: async () => undefined },
      }).create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toBe(error);
    }
    for (const createError of ["create", {}, new Error("create")]) {
      await expect(createSpritesProvider({
        client: client(sprite(), { getError: { statusCode: 404 }, createError }),
      }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toBe(createError);
    }
    await expect(createSpritesProvider({ client: client(sprite()), networkPolicy: () => null }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);
  });

  it("retries transient lifecycle requests without retrying arbitrary provider failures", async () => {
    const value = sprite();
    const transient = Object.assign(new Error("Network error: fetch failed"), { code: "ETIMEDOUT" });
    const sdk = client(value, { getError: transient });
    const waits: number[] = [];
    await expect(createSpritesProvider({
      client: sdk,
      lifecycleRetry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      },
    }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);
    expect(sdk.getSprite).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([10]);

    const permanent = new Error("permission denied");
    const rejected = client(value, { getError: permanent });
    await expect(createSpritesProvider({
      client: rejected,
      lifecycleRetry: { wait: async () => undefined },
    }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toBe(permanent);
    expect(rejected.getSprite).toHaveBeenCalledOnce();
  });

  it("handles readiness failures and aborts after the readiness command", async () => {
    const failed = sprite({ exec: { exitCode: 1, stderr: Buffer.from("not ready") } });
    await expect(createSpritesProvider({ client: client(failed) }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toThrow("readiness probe failed: not ready");
    const controller = new AbortController();
    const value = sprite();
    value.execFileHTTP = vi.fn(async () => { controller.abort(); return { stdout: "", stderr: "", exitCode: 0 }; });
    await expect(createSpritesProvider({ client: client(value) }).create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(controller.signal),
    )).rejects.toThrow();
  });

  it("validates resume input and applies resume policy", async () => {
    const value = sprite();
    const provider = createSpritesProvider({
      client: client(value), networkPolicy: () => ({ rules: [{ action: "deny", include: "private" }] }),
    });
    await expect(provider.resume({ provider: "other", runtimeId: name }, {} as never, {}, acquisition()))
      .rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "sprites", runtimeId: "" }, {} as never, {}, acquisition()))
      .rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume(
      { provider: "sprites", runtimeId: name }, {} as never, {}, undefined,
    )).rejects.toThrow("requires acquisition context");
    await expect(provider.resume(
      { provider: "sprites", runtimeId: name }, { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(SpritesRuntime);
    expect(value.updateNetworkPolicy).toHaveBeenCalledWith({ rules: [{ action: "deny", include: "private" }] });
    await expect(provider.restore({} as never, {} as never, {}, acquisition())).rejects
      .toThrow("does not advertise portable workspace restore");
  });

  it("projects optional resources and reaps absent, invalid, and live runtimes", async () => {
    const value = sprite();
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined, revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn(), synchronize: vi.fn() };
    const driver = createSpritesManagedRuntimeDriver({
      client: client(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore(), credentialEgress: egress, sessionInputs,
      readiness: { timeoutMs: 500 },
    });
    expect(driver.descriptor()).toMatchObject({
      capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } },
      credentialEgress: egress.capabilities,
    });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects.toThrow("does not support");
    const projected = await driver.create({ placement: "in_process" } as never);
    expect(projected).toMatchObject({ sessionInputs });
    await expect(projected.credentialEgress?.capabilities(scope)).resolves.toEqual(egress.capabilities);
    const plain = createSpritesManagedRuntimeDriver({ client: client(value), leaseTtlMs: 100, outputStore: null });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    expect(await plain.create({ placement: "in_process" } as never)).not.toHaveProperty("credentialEgress");
    const withOutput = createSpritesManagedRuntime({ client: client(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore() });
    await expect(withOutput.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });

    const lease = {
      leaseId: "lease", runtimeId: name, provider: "sprites", expiresAt: fence.expiresAt,
      handle: { provider: "sprites", runtimeId: name }, sandbox: {} as never,
    };
    const liveClient = client(value);
    await createSpritesManagedRuntime({ client: liveClient, leaseTtlMs: 100 }).sandbox.reap({ scope, lease, reason: "orphan" } as never);
    expect(liveClient.deleteSprite).toHaveBeenCalledWith(name);
    for (const notFound of [{ statusCode: 404 }, { status: 404 }, new Error("not found")]) {
      const absent = createSpritesManagedRuntime({ client: client(value, { getError: notFound }), leaseTtlMs: 100 });
      await expect(absent.sandbox.reap({ scope, lease, reason: "orphan" } as never)).resolves.toBeUndefined();
    }
    const failure = new Error("network");
    await expect(createSpritesManagedRuntime({ client: client(value, { getError: failure }), leaseTtlMs: 100 }).sandbox.reap(
      { scope, lease, reason: "orphan" } as never,
    )).rejects.toBe(failure);
    const foreign = sprite({ labels: [] });
    await expect(createSpritesManagedRuntime({ client: client(foreign), leaseTtlMs: 100 }).sandbox.reap(
      { scope, lease, reason: "orphan" } as never,
    )).rejects.toThrow("ownership labels");
  });
});
