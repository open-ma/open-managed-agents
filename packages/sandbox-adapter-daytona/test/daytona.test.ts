import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  client: undefined as FakeClient | undefined,
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor(config: Record<string, unknown>) {
      sdk.configs.push(config);
      if (!sdk.client) throw new Error("fake Daytona client missing");
      return sdk.client;
    }
  },
}));

import { DaytonaSandbox, sandboxFactory } from "../src/daytona";

type Result = { exitCode: number; result: string; artifacts?: { stdout?: string; stderr?: string } };

function fixture() {
  const process = {
    executeCommand: vi.fn(async (): Promise<Result> => ({ exitCode: 0, result: "", artifacts: { stdout: "ok\n" } })),
  };
  const fileSystem = {
    uploadFile: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => Buffer.from("content")),
    createFolder: vi.fn(async () => {}),
  };
  const sandbox = { id: "sandbox-1", process, fs: fileSystem };
  const client = {
    create: vi.fn(async () => sandbox),
    delete: vi.fn(async () => {}),
  };
  sdk.client = client;
  return { process, fileSystem, sandbox, client };
}

type FakeClient = ReturnType<typeof fixture>["client"];

const originalEnv = {
  key: process.env.DAYTONA_API_KEY,
  url: process.env.DAYTONA_API_URL,
  proxy: process.env.OMA_VAULT_PROXY_URL,
  ca: process.env.OMA_VAULT_CA_CERT,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  sdk.configs.length = 0;
  fixture();
  delete process.env.DAYTONA_API_KEY;
  delete process.env.DAYTONA_API_URL;
  delete process.env.OMA_VAULT_PROXY_URL;
  delete process.env.OMA_VAULT_CA_CERT;
});

afterEach(() => {
  restore("DAYTONA_API_KEY", originalEnv.key);
  restore("DAYTONA_API_URL", originalEnv.url);
  restore("OMA_VAULT_PROXY_URL", originalEnv.proxy);
  restore("OMA_VAULT_CA_CERT", originalEnv.ca);
  vi.restoreAllMocks();
});

const bucket = {
  endpoint: "https://s3.example.test",
  accessKey: "access'key",
  secretKey: "secret",
  bucketName: "bucket",
};

describe("DaytonaSandbox", () => {
  it("loads the SDK lazily, uses stable labels/defaults, and only creates once", async () => {
    const { client, process: { executeCommand: remote } } = fixture();
    process.env.DAYTONA_API_KEY = "env-key";
    process.env.DAYTONA_API_URL = "https://env.daytona";
    const sandbox = new DaytonaSandbox({ sessionId: "session-1" });
    await expect(sandbox.exec("one")).resolves.toBe("ok");
    await expect(sandbox.exec("two")).resolves.toBe("ok");
    expect(sdk.configs).toEqual([{ apiKey: "env-key", apiUrl: "https://env.daytona" }]);
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.create).toHaveBeenCalledWith({ image: "node:22-slim", labels: { "oma-session-id": "session-1" } });
    expect(remote).toHaveBeenNthCalledWith(1, "one", undefined, {}, 120);
    expect(remote).toHaveBeenNthCalledWith(2, "two", undefined, {}, 120);
  });

  it("maps output, timeouts, env, scoped secrets, and execution errors", async () => {
    const { process: { executeCommand: remote } } = fixture();
    remote
      .mockResolvedValueOnce({ exitCode: 7, result: "", artifacts: { stdout: "out\n", stderr: "err\n" } })
      .mockResolvedValueOnce({ exitCode: 0, result: "", artifacts: { stdout: "out", stderr: "err" } })
      .mockResolvedValueOnce({ exitCode: 0, result: "" })
      .mockRejectedValueOnce(new Error("offline"));
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key", apiUrl: "https://explicit", image: "image:1", defaultTimeoutMs: 100 });
    await sandbox.setEnvVars({ BASE: "yes" });
    await sandbox.setEnvVars({ NEXT: "yes" });
    sandbox.registerCommandSecrets("git ", { TOKEN: "secret" });
    sandbox.registerCommandSecrets("npm ", { NPM: "secret" });
    await expect(sandbox.exec("git clone", 1)).resolves.toBe("out\nerr\n[exit 7]");
    await expect(sandbox.exec("echo clean")).resolves.toBe("out\nerr");
    await expect(sandbox.exec("echo empty")).resolves.toBe("");
    await expect(sandbox.exec("npm install")).resolves.toBe("[error: offline]");
    expect(remote.mock.calls[0]?.[2]).toEqual({ BASE: "yes", NEXT: "yes", TOKEN: "secret" });
    expect(remote.mock.calls[0]?.[3]).toBe(1);
    expect(remote.mock.calls[1]?.[2]).toEqual({ BASE: "yes", NEXT: "yes" });
    expect(sdk.configs).toEqual([{ apiKey: "key", apiUrl: "https://explicit" }]);
    await expect(sandbox.startProcess("ignored")).resolves.toBeNull();
  });

  it("requires a key and explains a missing SDK", async () => {
    await expect(new DaytonaSandbox({ sessionId: "s" }).exec("x")).rejects.toThrow("apiKey not provided");

    vi.resetModules();
    vi.doMock("@daytonaio/sdk", () => { throw new Error("not installed"); });
    const fresh = await import("../src/daytona");
    await expect(new fresh.DaytonaSandbox({ sessionId: "s", apiKey: "key" }).exec("x")).rejects.toThrow("failed to load '@daytonaio/sdk'");
    vi.doUnmock("@daytonaio/sdk");
    vi.doMock("@daytonaio/sdk", () => ({
      Daytona: class {
        constructor(config: Record<string, unknown>) {
          sdk.configs.push(config);
          if (!sdk.client) throw new Error("fake Daytona client missing");
          return sdk.client as never;
        }
      },
    }));
  });

  it("reads/writes text and bytes, normalises relative paths, and tolerates mkdir failures", async () => {
    const { fileSystem } = fixture();
    fileSystem.downloadFile
      .mockResolvedValueOnce(Buffer.from("text"))
      .mockResolvedValueOnce(Buffer.from([1, 2, 3]));
    fileSystem.createFolder.mockRejectedValueOnce(new Error("exists"));
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key" });
    await expect(sandbox.readFile("relative.txt")).resolves.toBe("text");
    await expect(sandbox.readFileBytes("/absolute.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(sandbox.writeFile("dir/file.txt", "hello")).resolves.toBe("/workspace/dir/file.txt");
    await expect(sandbox.writeFileBytes("/", new Uint8Array([4]))).resolves.toBe("/");
    expect(fileSystem.downloadFile).toHaveBeenNthCalledWith(1, "/workspace/relative.txt");
    expect(fileSystem.downloadFile).toHaveBeenNthCalledWith(2, "/absolute.bin");
    expect(fileSystem.uploadFile.mock.calls[0]?.[0].toString()).toBe("hello");
    expect(fileSystem.uploadFile.mock.calls[1]?.[0]).toEqual(Buffer.from([4]));
  });

  it("configures local and remote outbound proxies and uploads the CA", async () => {
    const { fileSystem } = fixture();
    const caPath = join(tmpdir(), `openma-daytona-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_PROXY_URL = "http://127.0.0.1:14322";
    process.env.OMA_VAULT_CA_CERT = caPath;
    const warn = vi.fn();
    const log = vi.fn();
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key", logger: { warn, log } });
    await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await sandbox.exec("x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
    expect(fileSystem.createFolder).toHaveBeenCalledWith("/etc/ssl", "0755");
    expect(fileSystem.uploadFile).toHaveBeenCalledWith(Buffer.from("CA"), "/etc/ssl/oma-vault-ca.crt");
    expect(log).toHaveBeenCalledWith("uploaded vault CA cert (2 bytes)");

    process.env.OMA_VAULT_PROXY_URL = "https://proxy.example";
    const remote = new DaytonaSandbox({ sessionId: "s2", apiKey: "key", logger: { warn, log } });
    await remote.setOutboundContext();
    await remote.exec("x");
    expect(warn).toHaveBeenCalledTimes(1);
    await fs.unlink(caPath);
  });

  it("skips incomplete proxy config and makes CA preparation best-effort", async () => {
    const absent = new DaytonaSandbox({ sessionId: "s", apiKey: "key" });
    await expect(absent.setOutboundContext()).resolves.toBeUndefined();
    process.env.OMA_VAULT_PROXY_URL = "https://proxy";
    await expect(absent.setOutboundContext()).resolves.toBeUndefined();

    process.env.OMA_VAULT_CA_CERT = "/missing.pem";
    const warn = vi.fn();
    const failingRead = new DaytonaSandbox({ sessionId: "s", apiKey: "key", logger: { warn, log: vi.fn() } });
    await failingRead.setOutboundContext();
    await failingRead.exec("x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vault CA upload failed"));

    const caPath = join(tmpdir(), `openma-daytona-folder-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_CA_CERT = caPath;
    const { fileSystem } = fixture();
    fileSystem.createFolder.mockRejectedValueOnce(new Error("exists"));
    const existingFolder = new DaytonaSandbox({ sessionId: "s", apiKey: "key" });
    await existingFolder.setOutboundContext();
    await existingFolder.exec("x");
    expect(fileSystem.uploadFile).toHaveBeenCalled();
    await fs.unlink(caPath);
  });

  it("mounts a shared bucket once for memory and outputs, with writable and read-only links", async () => {
    const { process: { executeCommand: remote } } = fixture();
    remote.mockResolvedValue({ exitCode: 0, result: "" });
    const log = vi.fn();
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key", memoryBucket: bucket, logger: { warn: vi.fn(), log } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "memory's", storeId: "id-1", readOnly: false });
    await sandbox.mountMemoryStore({ storeName: "ro", storeId: "id-2", readOnly: true });
    await sandbox.mountSessionOutputs({ tenantId: "tenant", sessionId: "session" });
    expect(remote).toHaveBeenCalledTimes(4);
    expect(remote.mock.calls[0]?.[0]).toContain("s3fs 'bucket'");
    expect(remote.mock.calls[1]?.[0]).toContain("memory'\\''s");
    expect(remote.mock.calls[2]?.[0]).toContain("chmod -R a-w");
    expect(remote.mock.calls[3]?.[0]).toContain("/session-outputs/tenant/session");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("s3fs mounted bucket"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(ro)"));

    const fresh = fixture();
    fresh.process.executeCommand.mockResolvedValue({ exitCode: 0, result: "" });
    const outputFirst = new DaytonaSandbox({ sessionId: "output", apiKey: "key", memoryBucket: bucket });
    await outputFirst.mountSessionOutputs({ tenantId: "tenant", sessionId: "session" });
    expect(fresh.process.executeCommand).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported mounts and reports both s3fs failure payload shapes", async () => {
    const noBucket = new DaytonaSandbox({ sessionId: "s", apiKey: "key" });
    expect(noBucket.sessionOutputMountCapabilities()).toBeNull();
    await expect(noBucket.mountMemoryStore({ storeName: "m", storeId: "i", readOnly: false })).rejects.toThrow("no memoryBucket config");
    await expect(noBucket.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("no s3 bucket config");

    const { process: { executeCommand: remote } } = fixture();
    remote.mockResolvedValueOnce({ exitCode: 1, result: "fallback", artifacts: { stderr: "stderr" } });
    await expect(new DaytonaSandbox({ sessionId: "s", apiKey: "key", memoryBucket: bucket }).mountMemoryStore({ storeName: "m", storeId: "i", readOnly: false })).rejects.toThrow("stderr");

    fixture().process.executeCommand.mockResolvedValueOnce({ exitCode: 2, result: "result" });
    await expect(new DaytonaSandbox({ sessionId: "s", apiKey: "key", memoryBucket: bucket }).mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("result");
  });

  it("destroys idempotently and absorbs creation/deletion failures", async () => {
    const { client } = fixture();
    const warn = vi.fn();
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key", logger: { warn, log: vi.fn() } });
    await sandbox.destroy();
    await sandbox.exec("x");
    client.delete.mockRejectedValueOnce(new Error("delete failed"));
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("destroy failed: delete failed");
    await sandbox.exec("x");
    await sandbox.destroy();

    const failed = fixture();
    failed.client.create.mockRejectedValueOnce(new Error("create failed"));
    const createFailure = new DaytonaSandbox({ sessionId: "s", apiKey: "key", logger: { warn, log: vi.fn() } });
    await expect(createFailure.exec("x")).rejects.toThrow("create failed");
    await createFailure.destroy();
    expect(warn).toHaveBeenCalledWith("destroy failed: create failed");
  });

  it("factory reads credentials, image, and S3 settings", async () => {
    const instance = await sandboxFactory(
      { sessionId: "session-factory" } as never,
      {
        DAYTONA_API_KEY: "key",
        DAYTONA_API_URL: "https://daytona",
        SANDBOX_IMAGE: "image:2",
        MEMORY_S3_ENDPOINT: "https://s3",
        MEMORY_S3_ACCESS_KEY: "access",
        MEMORY_S3_SECRET_KEY: "secret",
        MEMORY_S3_BUCKET: "bucket",
      },
    );
    expect(instance).toBeInstanceOf(DaytonaSandbox);
  });

  it("default logger callbacks remain usable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fixture();
    client.delete.mockRejectedValueOnce(new Error("delete"));
    const sandbox = new DaytonaSandbox({ sessionId: "s", apiKey: "key" });
    await sandbox.exec("x");
    await sandbox.destroy();
    expect(log).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
