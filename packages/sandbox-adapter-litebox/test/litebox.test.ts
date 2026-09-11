import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  instances: [] as FakeBox[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@boxlite-ai/boxlite", () => ({
  SimpleBox: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
      const box = sdk.instances.shift();
      if (!box) throw new Error("fake box missing");
      return box;
    }
  },
}));

import { LiteBoxSandbox, sandboxFactory } from "../src/litebox";

function fakeBox() {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async (_source: string, destination: string) => { await fs.writeFile(destination, "content"); }),
    stop: vi.fn(async () => {}),
  };
}

type FakeBox = ReturnType<typeof fakeBox>;

function queueBox() {
  const box = fakeBox();
  sdk.instances.push(box);
  return box;
}

const originalEnv = {
  memory: process.env.MEMORY_BLOB_DIR,
  outputs: process.env.FILES_BLOB_DIR,
  proxy: process.env.OMA_VAULT_PROXY_URL,
  ca: process.env.OMA_VAULT_CA_CERT,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.options.length = 0;
  delete process.env.MEMORY_BLOB_DIR;
  delete process.env.FILES_BLOB_DIR;
  delete process.env.OMA_VAULT_PROXY_URL;
  delete process.env.OMA_VAULT_CA_CERT;
});

afterEach(() => {
  restore("MEMORY_BLOB_DIR", originalEnv.memory);
  restore("FILES_BLOB_DIR", originalEnv.outputs);
  restore("OMA_VAULT_PROXY_URL", originalEnv.proxy);
  restore("OMA_VAULT_CA_CERT", originalEnv.ca);
  vi.restoreAllMocks();
});

describe("LiteBoxSandbox", () => {
  it("creates lazily once with default options and executes commands", async () => {
    const box = queueBox();
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.exec("one")).resolves.toBe("ok");
    await expect(sandbox.exec("two")).resolves.toBe("ok");
    expect(sdk.options).toEqual([{ image: "node:22-slim", memoryMib: undefined, cpus: undefined, name: undefined, volumes: [] }]);
    expect(box.exec).toHaveBeenNthCalledWith(1, "sh", ["-c", "one"], {}, { timeoutSecs: 120 });
    expect(box.exec).toHaveBeenNthCalledWith(2, "sh", ["-c", "two"], {}, { timeoutSecs: 120 });
    await expect(sandbox.startProcess("ignored")).resolves.toBeNull();
    await sandbox.destroy();
  });

  it("maps output, minimum/default timeouts, env, secrets, and failures", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 4, stdout: "out\n", stderr: "err\n" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "out", stderr: "err" })
      .mockRejectedValueOnce(new Error("offline"));
    const sandbox = new LiteBoxSandbox({ image: "image:1", memoryMib: 512, cpus: 2, name: "named", defaultTimeoutMs: 100 });
    await sandbox.setEnvVars({ A: "1" });
    await sandbox.setEnvVars({ B: "2" });
    sandbox.registerCommandSecrets("git ", { TOKEN: "secret" });
    sandbox.registerCommandSecrets("npm ", { NPM: "secret" });
    await expect(sandbox.exec("git clone", 1)).resolves.toBe("out\nerr\n[exit 4]");
    await expect(sandbox.exec("echo clean")).resolves.toBe("out\nerr");
    await expect(sandbox.exec("npm install")).resolves.toBe("[error: offline]");
    expect(box.exec.mock.calls[0]?.[2]).toEqual({ A: "1", B: "2", TOKEN: "secret" });
    expect(box.exec.mock.calls[1]?.[2]).toEqual({ A: "1", B: "2" });
    expect(box.exec.mock.calls[0]?.[3]).toEqual({ timeoutSecs: 1 });
    expect(sdk.options[0]).toMatchObject({ image: "image:1", memoryMib: 512, cpus: 2, name: "named" });
    await sandbox.destroy();
  });

  it("explains a missing optional SDK", async () => {
    vi.resetModules();
    vi.doMock("@boxlite-ai/boxlite", () => { throw new Error("not installed"); });
    const fresh = await import("../src/litebox");
    const missing = new fresh.LiteBoxSandbox({ logger: { warn: vi.fn(), log: vi.fn() } });
    await expect(missing.exec("x")).rejects.toThrow("failed to load '@boxlite-ai/boxlite'");
    await missing.destroy();
    vi.doUnmock("@boxlite-ai/boxlite");
    vi.doMock("@boxlite-ai/boxlite", () => ({
      SimpleBox: class {
        constructor(options: Record<string, unknown>) {
          sdk.options.push(options);
          const box = sdk.instances.shift();
          if (!box) throw new Error("fake box missing");
          return box as never;
        }
      },
    }));
  });

  it("mounts memory and outputs from explicit roots before construction", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-roots-"));
    queueBox();
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({ memoryRoot: join(root, "memory"), outputsRoot: join(root, "outputs"), logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "memory", storeId: "store", readOnly: true });
    await sandbox.mountSessionOutputs({ tenantId: "tenant", sessionId: "session" });
    await sandbox.exec("x");
    expect(sdk.options[0]?.volumes).toEqual([
      { hostPath: join(root, "memory", "store"), guestPath: "/mnt/memory/memory", readOnly: true },
      { hostPath: join(root, "outputs", "tenant", "session"), guestPath: "/mnt/session/outputs", readOnly: false },
    ]);
    expect(warn).not.toHaveBeenCalled();
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("supports legacy env roots with warnings and reports missing/late mount configuration", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-env-"));
    process.env.MEMORY_BLOB_DIR = join(root, "memory");
    process.env.FILES_BLOB_DIR = join(root, "outputs");
    const warn = vi.fn();
    queueBox();
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false });
    await sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" });
    expect(warn).toHaveBeenCalledTimes(2);
    await sandbox.exec("x");
    await expect(sandbox.mountMemoryStore({ storeName: "late", storeId: "s", readOnly: false })).rejects.toThrow("box already created");
    await expect(sandbox.mountSessionOutputs({ tenantId: "late", sessionId: "s" })).rejects.toThrow("box already created");
    await sandbox.destroy();

    delete process.env.MEMORY_BLOB_DIR;
    delete process.env.FILES_BLOB_DIR;
    const missing = new LiteBoxSandbox();
    expect(missing.sessionOutputMountCapabilities()).toBeNull();
    await expect(missing.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false })).rejects.toThrow("memoryRoot not provided");
    await expect(missing.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("outputsRoot not provided");
    await missing.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("copies text and bytes in both directions with relative and absolute paths", async () => {
    const box = queueBox();
    box.copyOut
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, "text"); })
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, new Uint8Array([1, 2, 3])); });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("relative.txt")).resolves.toBe("text");
    await expect(sandbox.readFileBytes("/absolute.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(sandbox.writeFile("relative.txt", "hello")).resolves.toBe("/workspace/relative.txt");
    await expect(sandbox.writeFileBytes("/absolute.bin", new Uint8Array([4, 5]))).resolves.toBe("/absolute.bin");
    expect(box.copyOut.mock.calls[0]?.[0]).toBe("/workspace/relative.txt");
    expect(box.copyOut.mock.calls[1]?.[0]).toBe("/absolute.bin");
    expect(box.copyIn.mock.calls[0]?.[1]).toBe("/workspace/relative.txt");
    expect(box.copyIn.mock.calls[1]?.[1]).toBe("/absolute.bin");
    await sandbox.destroy();
  });

  it("cleans staging paths even when copy operations or cleanup fail", async () => {
    const box = queueBox();
    box.copyOut.mockRejectedValueOnce(new Error("copy out"));
    box.copyIn.mockRejectedValueOnce(new Error("copy in"));
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("a")).rejects.toThrow("copy out");
    await expect(sandbox.writeFile("b", "x")).rejects.toThrow("copy in");
    await sandbox.destroy();

    const cleanup = queueBox();
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup"));
    const cleanupFailure = new LiteBoxSandbox();
    await expect(cleanupFailure.readFile("a")).resolves.toBe("content");
    expect(rm).toHaveBeenCalled();
    rm.mockRestore();
    await cleanupFailure.destroy();
    expect(cleanup.copyOut).toHaveBeenCalled();
  });

  it("wires the outbound proxy and makes CA upload best-effort", async () => {
    const caPath = join(tmpdir(), `openma-litebox-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    process.env.OMA_VAULT_CA_CERT = caPath;
    const box = queueBox();
    const sandbox = new LiteBoxSandbox();
    await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await sandbox.exec("x");
    expect(box.copyIn).toHaveBeenCalledWith(caPath, "/etc/ssl/oma-vault-ca.crt");
    expect(box.exec.mock.calls[0]?.[2]).toMatchObject({ HTTPS_PROXY: "http://proxy", SSL_CERT_FILE: "/etc/ssl/oma-vault-ca.crt" });
    await sandbox.destroy();

    const warn = vi.fn();
    const failing = queueBox();
    failing.copyIn.mockRejectedValueOnce(new Error("copy failed"));
    const uploadFailure = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await uploadFailure.setOutboundContext();
    await uploadFailure.exec("x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("copy failed"));
    await uploadFailure.destroy();
    await fs.unlink(caPath);
  });

  it("skips incomplete outbound proxy settings", async () => {
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();
    await sandbox.destroy();
  });

  it("destroy is repeatable and absorbs stop, create, and scratch cleanup failures", async () => {
    const warn = vi.fn();
    const stopped = queueBox();
    stopped.stop.mockRejectedValueOnce(new Error("stop failed"));
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await sandbox.exec("x");
    await sandbox.destroy();
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("destroy stop failed: stop failed");

    const rejected = queueBox();
    rejected.exec.mockRejectedValueOnce(new Error("exec"));
    const createPromise = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await createPromise.exec("x");
    await createPromise.destroy();

    const scratchRoot = await fs.mkdtemp(join(tmpdir(), "openma-litebox-cleanup-failure-"));
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("rm"));
    const scratch = new LiteBoxSandbox({ scratchRoot });
    await expect(scratch.destroy()).resolves.toBeUndefined();
    rm.mockRestore();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("factory maps optional provider construction settings", async () => {
    const configured = await sandboxFactory(
      { sessionId: "session", memoryRoot: "/memory", outputsRoot: "/outputs" } as never,
      { SANDBOX_IMAGE: "image", LITEBOX_MEMORY_MIB: "1024", LITEBOX_CPUS: "4" },
    );
    const defaults = await sandboxFactory({ sessionId: "session" } as never, {});
    expect(configured).toBeInstanceOf(LiteBoxSandbox);
    expect(defaults).toBeInstanceOf(LiteBoxSandbox);
    await configured.destroy();
    await defaults.destroy();
  });

  it("factory scopes copy staging to the session workdir lifecycle", async () => {
    const workdir = await fs.mkdtemp(join(tmpdir(), "openma-litebox-session-"));
    const sandbox = await sandboxFactory({ sessionId: "session", workdir }, {});

    const scratchEntries = await fs.readdir(join(workdir, ".openma"));
    expect(scratchEntries).toHaveLength(1);
    expect(scratchEntries[0]).toMatch(/^litebox-scratch-/);

    await sandbox.destroy();
    await expect(fs.readdir(join(workdir, ".openma"))).resolves.toEqual([]);
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("default logger callbacks remain usable", async () => {
    const box = queueBox();
    box.stop.mockRejectedValueOnce(new Error("stop"));
    const sandbox = new LiteBoxSandbox();
    await sandbox.exec("x");
    await sandbox.destroy();
  });
});
