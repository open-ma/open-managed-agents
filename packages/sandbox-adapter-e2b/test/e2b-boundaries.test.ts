import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn<(template: string, options?: Record<string, unknown>) => Promise<unknown>>(),
  connect: vi.fn<(sandboxId: string, options?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("e2b", () => ({ Sandbox: { create: sdk.create, connect: sdk.connect } }));

import {
  createE2BSandbox,
  E2BSandboxExecutor,
  sandboxFactory,
  sandboxProvider,
} from "../src/e2b";

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type CommandHandle = {
  pid: number;
  kill(): Promise<boolean | void>;
  wait?(): Promise<CommandResult>;
  sendStdin?(data: string | Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
};
type CommandOptions = {
  timeoutMs?: number;
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  onStdout?(data: string): void | Promise<void>;
  onStderr?(data: string): void | Promise<void>;
  stdin?: boolean;
};
type CommandRun = (command: string, options?: CommandOptions) => Promise<CommandResult | CommandHandle>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: "sandbox-1",
    commands: { run: vi.fn<CommandRun>(async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 })) },
    files: {
      read: vi.fn(async () => "text"),
      write: vi.fn(async () => {}),
      makeDir: vi.fn(async () => {}),
    },
    kill: vi.fn(async () => {}),
    getInfo: vi.fn(async () => ({ state: "running" })),
    setTimeout: vi.fn(async () => {}),
    pause: vi.fn(async () => true),
    connect: vi.fn(async function (this: unknown) { return this; }),
    createSnapshot: vi.fn(async () => ({ snapshotId: "snapshot-1", names: ["named"] })),
    ...overrides,
  };
}

const originalProxy = process.env.OMA_VAULT_PROXY_URL;
const originalCa = process.env.OMA_VAULT_CA_CERT;

beforeEach(() => {
  sdk.create.mockReset();
  sdk.connect.mockReset();
  delete process.env.OMA_VAULT_PROXY_URL;
  delete process.env.OMA_VAULT_CA_CERT;
});

afterEach(() => {
  if (originalProxy === undefined) delete process.env.OMA_VAULT_PROXY_URL;
  else process.env.OMA_VAULT_PROXY_URL = originalProxy;
  if (originalCa === undefined) delete process.env.OMA_VAULT_CA_CERT;
  else process.env.OMA_VAULT_CA_CERT = originalCa;
  vi.restoreAllMocks();
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const item = await reader.read();
    if (item.done) return output;
    output += decoder.decode(item.value, { stream: true });
  }
}

describe("E2BSandboxExecutor boundaries", () => {
  it("covers runtime identity, status, lease, suspend, resume, and checkpoint validation", async () => {
    const sb = remote();
    const runtime = new E2BSandboxExecutor(sb as never, {});
    expect(runtime.runtimeHandle()).toEqual({ provider: "e2b", runtimeId: "sandbox-1" });
    expect(runtime.runtimeCapabilities()).toEqual({ lease: true, suspend: ["filesystem", "memory"], checkpoint: ["memory"] });
    await expect(runtime.status()).resolves.toBe("running");
    sb.getInfo.mockResolvedValueOnce({ state: "paused" });
    await expect(runtime.status()).resolves.toBe("suspended");
    sb.getInfo.mockResolvedValueOnce({ state: "dead" });
    await expect(runtime.status()).resolves.toBe("unknown");
    await expect(new E2BSandboxExecutor({ ...sb, getInfo: undefined } as never, {}).status()).resolves.toBe("unknown");

    for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runtime.renewLease({ ttlMs })).rejects.toThrow("positive integer");
    }
    await runtime.renewLease({ ttlMs: 1000 });
    expect(sb.setTimeout).toHaveBeenCalledWith(1000);
    await expect(new E2BSandboxExecutor({ ...sb, setTimeout: undefined } as never, {}).renewLease({ ttlMs: 1 })).rejects.toThrow("setTimeout");

    await expect(runtime.suspend({ kind: "filesystem" })).resolves.toMatchObject({ kind: "filesystem", scope: "runtime" });
    expect(sb.pause).toHaveBeenLastCalledWith({ keepMemory: false });
    await expect(new E2BSandboxExecutor({ ...sb, pause: undefined } as never, {}).suspend({ kind: "memory" })).rejects.toThrow("sandbox.pause");

    const own = { provider: "e2b", checkpointId: "sandbox-1", sourceRuntimeId: "sandbox-1", kind: "memory", scope: "runtime" } as const;
    await runtime.resume(own);
    for (const checkpoint of [
      { ...own, provider: "other" },
      { ...own, scope: "portable" },
      { ...own, checkpointId: "other" },
    ]) await expect(runtime.resume(checkpoint as never)).rejects.toThrow("own runtime-scoped");
    await expect(new E2BSandboxExecutor({ ...sb, connect: undefined } as never, {}).resume(own)).rejects.toThrow("sandbox.connect");

    await expect(runtime.checkpoint({ kind: "filesystem" })).rejects.toThrow("memory state only");
    await expect(new E2BSandboxExecutor({ ...sb, createSnapshot: undefined } as never, {}).checkpoint({ kind: "memory" })).rejects.toThrow("createSnapshot");
    await expect(runtime.checkpoint({ kind: "memory" })).resolves.toMatchObject({ checkpointId: "snapshot-1", scope: "portable" });
    expect(sb.createSnapshot).toHaveBeenLastCalledWith(undefined);

    const missingId = new E2BSandboxExecutor({ ...sb, sandboxId: undefined } as never, {});
    expect(() => missingId.runtimeHandle()).toThrow("sandboxId");
  });

  it("formats synchronous commands without duplicate newlines and applies scoped env safely", async () => {
    const sb = remote();
    sb.commands.run
      .mockResolvedValueOnce({ stdout: "out\n", stderr: "err\n", exitCode: 2 })
      .mockResolvedValueOnce({ stdout: "out", stderr: "err", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const runtime = new E2BSandboxExecutor(sb as never, { defaultTimeoutMs: 50 });
    await runtime.setEnvVars({ BASE: "a'b" });
    await runtime.setEnvVars({ NEXT: "2" });
    runtime.registerCommandSecrets("git ", { TOKEN: "secret" });
    runtime.registerCommandSecrets("npm ", { NPM: "secret" });
    await expect(runtime.exec("git clone", 2)).resolves.toBe("out\nerr\n[exit 2]");
    await expect(runtime.exec("echo clean")).resolves.toBe("out\nerr");
    await expect(new E2BSandboxExecutor(sb as never, {}).exec("echo empty")).resolves.toBe("");
    expect(sb.commands.run.mock.calls[0]?.[0]).toContain("export BASE='a'\\''b';");
    expect(sb.commands.run.mock.calls[0]?.[0]).toContain("export TOKEN='secret';");
    expect(sb.commands.run.mock.calls[1]?.[0]).not.toContain("TOKEN");
    expect(sb.commands.run.mock.calls[0]?.[1]).toEqual({ timeoutMs: 2 });
    expect(sb.commands.run.mock.calls[1]?.[1]).toEqual({ timeoutMs: 50 });
  });

  it("maps background ProcessHandle lifecycle, including missing pids and kill errors", async () => {
    const pending = deferred<CommandResult>();
    const command = { pid: 9, kill: vi.fn(async () => true), wait: vi.fn(() => pending.promise) };
    const sb = remote();
    sb.commands.run.mockResolvedValueOnce(command).mockResolvedValueOnce({ pid: 0, kill: vi.fn() });
    const runtime = new E2BSandboxExecutor(sb as never, {});
    const handle = await runtime.startProcess("work");
    expect(handle?.id).toMatch(/^proc_9_/);
    expect(handle?.pid).toBe(9);
    await expect(handle?.getStatus()).resolves.toBe("running");
    await expect(handle?.getLogs()).resolves.toEqual({ stdout: "", stderr: "" });
    pending.resolve({ stdout: "done", stderr: "warn", exitCode: 3 });
    await vi.waitFor(async () => expect(await handle?.getStatus()).toBe("error"));
    await expect(handle?.getLogs()).resolves.toEqual({ stdout: "done", stderr: "warn" });
    await handle?.kill("SIGTERM");
    expect(command.kill).toHaveBeenCalled();
    await expect(runtime.startProcess("missing")).resolves.toBeNull();

    sb.commands.run.mockResolvedValueOnce({ pid: 11, kill: vi.fn(async () => true) });
    const noWait = await runtime.startProcess("no-wait");
    await expect(noWait?.getStatus()).resolves.toBe("running");
    await expect(noWait?.getLogs()).resolves.toEqual({ stdout: "", stderr: "" });

    const completed = deferred<CommandResult>();
    const failedKill = { pid: 10, kill: vi.fn(async () => { throw new Error("denied"); }), wait: () => completed.promise };
    sb.commands.run.mockResolvedValueOnce(failedKill);
    const failing = await runtime.startProcess("failing");
    await expect(failing?.kill("SIGKILL")).rejects.toThrow("kill failed: denied");
    completed.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await vi.waitFor(async () => expect(await failing?.getStatus()).toBe("completed"));
  });

  it("requires the complete live-stdin handle and reaps partial handles", async () => {
    for (const partial of [
      { pid: 1, kill: vi.fn(async () => {}) },
      { pid: 1, kill: vi.fn(async () => {}), wait: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
      { pid: 1, kill: vi.fn(async () => {}), wait: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })), sendStdin: vi.fn(async () => {}) },
    ]) {
      const sb = remote();
      sb.commands.run.mockResolvedValueOnce(partial);
      await expect(new E2BSandboxExecutor(sb as never, {}).spawnDuplexProcess({ command: "agent" })).rejects.toThrow("live-stdin");
      expect(partial.kill).toHaveBeenCalled();
    }
    const partial = { pid: 1, kill: vi.fn(async () => { throw new Error("already gone"); }) };
    const sb = remote();
    sb.commands.run.mockResolvedValueOnce(partial);
    await expect(new E2BSandboxExecutor(sb as never, {}).spawnDuplexProcess({ command: "agent" })).rejects.toThrow("live-stdin");
  });

  it("drives duplex stdin/stdout, override deletion, close, kill, and post-exit guards", async () => {
    const wait = deferred<CommandResult>();
    let options: CommandOptions | undefined;
    const command = {
      pid: 2,
      kill: vi.fn(async () => true),
      wait: vi.fn(() => wait.promise),
      sendStdin: vi.fn(async () => {}),
      closeStdin: vi.fn(async () => {}),
    };
    const sb = remote();
    sb.commands.run.mockImplementationOnce(async (_command: string, input?: CommandOptions) => { options = input; return command; });
    const runtime = new E2BSandboxExecutor(sb as never, {});
    await runtime.setEnvVars({ REMOVE: "x", KEEP: "y" });
    runtime.registerCommandSecrets("agent", { SECRET: "z" });
    const child = await runtime.spawnDuplexProcess({ command: "agent", args: ["a'b"], cwd: "/workspace", env: { REMOVE: undefined, ADD: "v" } });
    const stdout = readAll(child.stdout);
    const stderr = readAll(child.stderr);
    const writer = child.stdin.getWriter();
    await writer.write(new Uint8Array([1, 2]));
    await writer.close();
    expect(command.sendStdin).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(command.closeStdin).toHaveBeenCalled();
    expect(options).toMatchObject({ background: true, stdin: true, timeoutMs: 0, cwd: "/workspace", envs: { KEEP: "y", SECRET: "z", ADD: "v" } });
    expect(options?.envs).not.toHaveProperty("REMOVE");
    expect(sb.commands.run.mock.calls[0]?.[0]).toBe("'agent' 'a'\\''b'");
    (options?.onStdout as (data: string) => void)("");
    (options?.onStdout as (data: string) => void)("out");
    (options?.onStderr as (data: string) => void)("err");
    wait.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe("out");
    await expect(stderr).resolves.toBe("err");
    await expect(writer.write(new Uint8Array([3]))).rejects.toThrow();
    await child.kill();
  });

  it("maps duplex kill/abort and all wait rejection shapes", async () => {
    async function spawned() {
      const wait = deferred<CommandResult>();
      const command = { pid: 3, kill: vi.fn(async () => true), wait: () => wait.promise, sendStdin: vi.fn(async () => {}), closeStdin: vi.fn(async () => {}) };
      const sb = remote();
      sb.commands.run.mockResolvedValueOnce(command);
      return { child: await new E2BSandboxExecutor(sb as never, {}).spawnDuplexProcess({ command: "agent" }), wait, command };
    }
    const killed = await spawned();
    await killed.child.kill("SIGKILL");
    await expect(killed.child.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    killed.wait.reject(new Error("late"));

    const aborted = await spawned();
    const writer = aborted.child.stdin.getWriter();
    await writer.abort();
    await expect(aborted.child.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    aborted.wait.reject(new Error("late"));

    const coded = await spawned();
    coded.wait.reject({ exitCode: 17 });
    await expect(coded.child.exited).resolves.toEqual({ code: 17, signal: null });

    const failed = await spawned();
    const reader = failed.child.stdout.getReader();
    failed.wait.reject("transport");
    await expect(failed.child.exited).resolves.toEqual({ code: null, signal: null });
    await expect(reader.read()).rejects.toThrow("transport");

    const failedWithError = await spawned();
    const errorReader = failedWithError.child.stderr.getReader();
    failedWithError.wait.reject(new Error("typed transport"));
    await expect(errorReader.read()).rejects.toThrow("typed transport");

    const afterExit = await spawned();
    const afterExitWriter = afterExit.child.stdin.getWriter();
    afterExit.wait.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await afterExit.child.exited;
    await expect(afterExitWriter.write(new Uint8Array([1]))).rejects.toThrow("cannot write");

    const closeAfterExit = await spawned();
    const closeWriter = closeAfterExit.child.stdin.getWriter();
    closeAfterExit.wait.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await closeAfterExit.child.exited;
    await expect(closeWriter.close()).resolves.toBeUndefined();

    const abortAfterExit = await spawned();
    const abortWriter = abortAfterExit.child.stdin.getWriter();
    abortAfterExit.wait.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await abortAfterExit.child.exited;
    await expect(abortWriter.abort()).resolves.toBeUndefined();
  });

  it("handles cancelled output streams without corrupting process completion", async () => {
    const wait = deferred<CommandResult>();
    let onStdout: ((data: string) => void) | undefined;
    const command = { pid: 4, kill: vi.fn(async () => true), wait: () => wait.promise, sendStdin: vi.fn(async () => {}), closeStdin: vi.fn(async () => {}) };
    const sb = remote();
    sb.commands.run.mockImplementationOnce(async (_command: string, options?: CommandOptions) => { onStdout = options?.onStdout; return command; });
    const child = await new E2BSandboxExecutor(sb as never, {}).spawnDuplexProcess({ command: "agent" });
    await child.stdout.cancel();
    onStdout?.("ignored");
    wait.resolve({ stdout: "", stderr: "", exitCode: 0 });
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("wires outbound proxy/CA and file operations, including binary failure", async () => {
    const caPath = join(tmpdir(), `openma-e2b-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_PROXY_URL = "http://localhost:14322";
    process.env.OMA_VAULT_CA_CERT = caPath;
    const warn = vi.fn();
    const sb = remote();
    const runtime = new E2BSandboxExecutor(sb as never, { logger: { warn } });
    await runtime.setOutboundContext({ tenantId: "t", sessionId: "s" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
    expect(sb.files.write).toHaveBeenCalledWith("/etc/ssl/oma-vault-ca.crt", Buffer.from("CA"));
    await runtime.setOutboundContext();
    await expect(runtime.readFile("/a")).resolves.toBe("text");
    await expect(runtime.writeFile("/a", "x")).resolves.toBe("/a");
    await expect(runtime.writeFileBytes("/b", new Uint8Array([1]))).resolves.toBe("/b");

    sb.commands.run.mockResolvedValueOnce({ stdout: Buffer.from([1, 2]).toString("base64"), stderr: "", exitCode: 0 });
    await expect(runtime.readFileBytes("/a'b")).resolves.toEqual(new Uint8Array([1, 2]));
    expect(sb.commands.run.mock.calls.at(-1)?.[0]).toContain("a'\\''b");
    sb.commands.run.mockResolvedValueOnce({ stdout: "failed", stderr: "", exitCode: 1 });
    await expect(runtime.readFileBytes("/missing")).rejects.toThrow("readFileBytes failed");
    await fs.unlink(caPath);
  });

  it("skips incomplete proxy config and reports CA upload failures for local and remote URLs", async () => {
    const sb = remote();
    const warn = vi.fn();
    const runtime = new E2BSandboxExecutor(sb as never, { logger: { warn } });
    await runtime.setOutboundContext();
    process.env.OMA_VAULT_PROXY_URL = "https://proxy.example";
    await runtime.setOutboundContext();
    process.env.OMA_VAULT_CA_CERT = "/missing.pem";
    await runtime.setOutboundContext();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vault CA upload failed"));
    process.env.OMA_VAULT_PROXY_URL = "http://127.0.0.1:1";
    await runtime.setOutboundContext();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
  });

  it("mounts S3 once, supports path-style policy/read-only, output bootstrap, and setup failures", async () => {
    const config = { endpoint: "https://s3.example", accessKey: "a", secretKey: "s", bucketName: "b'ucket" };
    const sb = remote();
    const warn = vi.fn();
    const runtime = new E2BSandboxExecutor(sb as never, { memoryBucket: config, logger: { warn } });
    expect(runtime.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await runtime.mountMemoryStore({ storeName: "m", storeId: "id", readOnly: false });
    await runtime.mountMemoryStore({ storeName: "ro", storeId: "id2", readOnly: true });
    await runtime.mountSessionOutputs({ tenantId: "t", sessionId: "s" });
    expect(sb.files.write).toHaveBeenCalledWith("/root/.passwd-s3fs", "a:s\n");
    expect(sb.commands.run.mock.calls.some(([command]) => String(command).includes("use_path_request_style"))).toBe(true);
    expect(sb.commands.run.mock.calls.some(([command]) => String(command).includes("chmod -R a-w"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bucket b'ucket mounted"));

    const fresh = remote();
    const outputs = new E2BSandboxExecutor(fresh as never, { memoryBucket: { ...config, usePathRequestStyle: false } });
    await outputs.mountSessionOutputs({ tenantId: "t", sessionId: "s" });
    expect(fresh.commands.run.mock.calls.some(([command]) => String(command).includes("use_path_request_style"))).toBe(false);

    const missing = new E2BSandboxExecutor(remote() as never, {});
    expect(missing.sessionOutputMountCapabilities()).toBeNull();
    await expect(missing.mountMemoryStore({ storeName: "m", storeId: "i", readOnly: false })).rejects.toThrow("without memoryBucket");
    await expect(missing.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("no memoryBucket");

    const broken = remote();
    broken.commands.run.mockResolvedValueOnce({ stdout: "bad", stderr: "", exitCode: 1 });
    await expect(new E2BSandboxExecutor(broken as never, { memoryBucket: config }).mountMemoryStore({ storeName: "m", storeId: "i", readOnly: false })).rejects.toThrow("setup command failed");
  });

  it("destroys best-effort and keeps the default logger callable", async () => {
    const sb = remote();
    sb.kill.mockRejectedValueOnce(new Error("kill failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new E2BSandboxExecutor(sb as never, {}).destroy();
    expect(warn).toHaveBeenCalledWith("[e2b-sandbox] destroy failed: kill failed");
    sb.kill.mockResolvedValueOnce(undefined);
    await new E2BSandboxExecutor(sb as never, {}).destroy();
  });

  it("validates provider handles/checkpoints and maps full/default factory options", async () => {
    await expect(sandboxProvider.resume({ provider: "other", runtimeId: "x" }, {} as never, {})).rejects.toThrow("incompatible runtime handle");
    await expect(sandboxProvider.resume({ provider: "e2b", runtimeId: "" }, {} as never, {})).rejects.toThrow("incompatible runtime handle");
    for (const checkpoint of [
      { provider: "other", checkpointId: "x", scope: "portable" },
      { provider: "e2b", checkpointId: "x", scope: "runtime" },
      { provider: "e2b", checkpointId: "", scope: "portable" },
    ]) await expect(sandboxProvider.restore(checkpoint as never, {} as never, {})).rejects.toThrow("incompatible portable checkpoint");

    sdk.create.mockResolvedValue(remote({ sandboxId: "created" }));
    await createE2BSandbox({ apiKey: "key" });
    expect(sdk.create).toHaveBeenCalledWith("base", expect.objectContaining({ apiKey: "key" }));
    sdk.create.mockResolvedValue(remote({ sandboxId: "factory" }));
    await sandboxFactory({ sessionId: "s" } as never, {
      E2B_API_KEY: "key", E2B_API_URL: "api", E2B_SANDBOX_URL: "sandbox", E2B_DOMAIN: "domain", SANDBOX_IMAGE: "template",
      MEMORY_S3_ENDPOINT: "endpoint", MEMORY_S3_ACCESS_KEY: "access", MEMORY_S3_SECRET_KEY: "secret", MEMORY_S3_BUCKET: "bucket",
    });
    expect(sdk.create).toHaveBeenLastCalledWith("template", expect.objectContaining({ apiUrl: "api", sandboxUrl: "sandbox", domain: "domain" }));
  });

  it("explains a missing optional SDK", async () => {
    vi.resetModules();
    vi.doMock("e2b", () => { throw new Error("not installed"); });
    const fresh = await import("../src/e2b");
    await expect(fresh.createE2BSandbox()).rejects.toThrow("failed to load 'e2b' SDK");
    vi.doUnmock("e2b");
  });
});
