import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoxRunSandbox, sandboxFactory } from "../src/boxrun";

const originalFetch = globalThis.fetch;
const originalProxy = process.env.OMA_VAULT_PROXY_URL;
const originalCa = process.env.OMA_VAULT_CA_CERT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalProxy === undefined) delete process.env.OMA_VAULT_PROXY_URL;
  else process.env.OMA_VAULT_PROXY_URL = originalProxy;
  if (originalCa === undefined) delete process.env.OMA_VAULT_CA_CERT;
  else process.env.OMA_VAULT_CA_CERT = originalCa;
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(...blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => handler(String(input), init));
  globalThis.fetch = mock as typeof fetch;
  return mock;
}

describe("BoxRunSandbox", () => {
  it("validates configuration and the factory maps provider settings", async () => {
    expect(() => new BoxRunSandbox({ baseUrl: "" })).toThrow("baseUrl required");
    await expect(sandboxFactory({ sessionId: "session-abcdefghijklmnopqrstuvwxyz12345" } as never, {})).rejects.toThrow("BOXRUN_URL");

    const instance = await sandboxFactory(
      { sessionId: "session-abcdefghijklmnopqrstuvwxyz12345" } as never,
      {
        BOXRUN_URL: "http://boxrun/v1/default/",
        SANDBOX_IMAGE: "custom:1",
        BOXRUN_CPUS: "4",
        BOXRUN_MEMORY_MIB: "1024",
        BOXRUN_TOKEN: "token",
      },
    );
    expect(instance).toBeInstanceOf(BoxRunSandbox);
    await expect(sandboxFactory({ sessionId: "short" } as never, { BOXRUN_URL: "http://boxrun" })).resolves.toBeInstanceOf(BoxRunSandbox);
  });

  it("creates once, forwards auth/env/resources, and decodes streamed output", async () => {
    const calls = installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      if (url.endsWith("/output")) {
        return sse(
          "event: stdout\ndata: {\"data\":\"aGVs\"}\n\n",
          "event: stdout\ndata: {\"data\":\"bG8=\"}\n\n"
          + "event: stderr\ndata: {\"data\":\"YmFk\"}\n\n"
          + "event: ignored\ndata: {}\n\n"
          + "event: exit\ndata: {\"exit_code\":3}\n\n",
        );
      }
      throw new Error(`unexpected ${url} ${String(init.method)}`);
    });
    const logs: string[] = [];
    const sandbox = new BoxRunSandbox({
      baseUrl: "http://boxrun/v1/default/",
      bearerToken: "secret",
      image: "image:1",
      cpus: 2,
      memoryMib: 512,
      sessionId: "abcdefghijklmnopqrstuvwxyz1234567890",
      defaultTimeoutSecs: 9,
      logger: { log: (message) => logs.push(message), warn: vi.fn() },
    });
    await sandbox.setEnvVars({ A: "1" });
    await sandbox.setEnvVars({ B: "2" });
    await expect(sandbox.exec("echo hi")).resolves.toBe("exit=3\nhello[stderr:bad]");
    await expect(sandbox.exec("echo again", 4)).resolves.toBe("exit=3\nhello[stderr:bad]");

    expect(logs).toEqual(["box created box-1 (image:1)"]);
    const create = calls.mock.calls.find(([url]) => String(url).endsWith("/boxes"));
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({
      image: "image:1",
      name: "oma-abcdefghijklmnopqrstuvwxyz1234",
      cpus: 2,
      memory_mib: 512,
    });
    expect(new Headers(create?.[1]?.headers).get("authorization")).toBe("Bearer secret");
    const execs = calls.mock.calls.filter(([url]) => String(url).endsWith("/exec"));
    expect(JSON.parse(String(execs[0]?.[1]?.body))).toMatchObject({ env: { A: "1", B: "2" }, timeout_seconds: 9 });
    expect(JSON.parse(String(execs[1]?.[1]?.body))).toMatchObject({ timeout_seconds: 4 });
  });

  it("handles malformed/empty SSE events and unknown exit codes", async () => {
    installFetch((url) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      return sse(
        "event: stdout\n\n",
        ": keepalive\ndata: nope\n\n",
        "event: exit\ndata: {}\n\n",
        "event: stdout\ndata: {}\n\n",
        "event: stdout\ndata: {\"data\":\"eA==\"}\n\n",
      );
    });
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).resolves.toBe("exit=?\nx");
  });

  it("reports create, exec-start, and stream failures", async () => {
    installFetch(() => new Response("create-error", { status: 500 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("create failed: 500 create-error");

    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-1" }) : new Response("exec-error", { status: 409 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("exec start failed: 409 exec-error");

    installFetch((url) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (url.endsWith("/exec")) return json({ execution_id: "exec-1" });
      return new Response(null, { status: 200 });
    });
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).exec("x")).rejects.toThrow("exec stream failed: 200");
  });

  it("round-trips text and binary files through tar and covers path shapes", async () => {
    let uploaded: Uint8Array | undefined;
    const calls = installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") {
        uploaded = init.body as Uint8Array;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/files?")) return new Response(uploaded, { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.writeFile("/workspace/a.txt", "hello")).resolves.toBe("/workspace/a.txt");
    await expect(sandbox.readFile("/workspace/a.txt")).resolves.toBe("hello");
    await expect(sandbox.readFileBytes("/workspace/a.txt")).resolves.toEqual(new TextEncoder().encode("hello"));
    await expect(sandbox.writeFileBytes("name", new Uint8Array())).resolves.toBe("name");
    expect(calls.mock.calls.some(([url]) => String(url).includes("path=%2F&overwrite=true"))).toBe(true);
  });

  it("reports file transport and invalid archive failures", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") return new Response("no", { status: 500 });
      return new Response("no", { status: 404 });
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.writeFile("/a", "x")).rejects.toThrow("writeFile /a failed: 500 no");
    await expect(sandbox.readFile("/a")).rejects.toThrow("readFile /a failed: 404");
    await expect(sandbox.readFileBytes("/a")).rejects.toThrow("readFileBytes /a failed: 404");

    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-2" }) : new Response(new Uint8Array(512), { status: 200 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).readFile("/a")).rejects.toThrow("no regular file");

    const nonRegular = new Uint8Array(1536);
    nonRegular[0] = 97;
    nonRegular[156] = 53;
    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-3" }) : new Response(nonRegular, { status: 200 }));
    await expect(new BoxRunSandbox({ baseUrl: "http://boxrun" }).readFileBytes("/a")).rejects.toThrow("no regular file");
  });

  it("configures outbound proxy lazily and uploads its CA before first command", async () => {
    const caPath = join(tmpdir(), `openma-boxrun-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    process.env.OMA_VAULT_CA_CERT = caPath;
    let uploaded = false;
    const calls = installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") { uploaded = true; return new Response(null, { status: 204 }); }
      if (url.endsWith("/exec")) {
        expect(uploaded).toBe(true);
        expect(JSON.parse(String(init.body)).env).toMatchObject({ HTTPS_PROXY: "http://proxy", NODE_EXTRA_CA_CERTS: "/etc/ssl/oma-vault-ca.crt" });
        return json({ execution_id: "exec-1" });
      }
      return sse("event: exit\ndata: {\"exit_code\":0}\n\n");
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await sandbox.exec("true");
    expect(calls.mock.calls.some(([url]) => String(url).includes("path=%2Fetc%2Fssl"))).toBe(true);
    await fs.unlink(caPath);
  });

  it("skips absent proxy settings and logs deferred CA upload failures", async () => {
    delete process.env.OMA_VAULT_PROXY_URL;
    delete process.env.OMA_VAULT_CA_CERT;
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();

    process.env.OMA_VAULT_CA_CERT = "/missing/ca.pem";
    const warn = vi.fn();
    installFetch((url) => url.endsWith("/boxes") ? json({ box_id: "box-1" }) : new Response(null, { status: 204 }));
    const failing = new BoxRunSandbox({ baseUrl: "http://boxrun", logger: { log: vi.fn(), warn } });
    await failing.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await failing.writeFile("/a", "x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vault CA upload failed"));

    const caPath = join(tmpdir(), `openma-boxrun-upload-failure-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_CA_CERT = caPath;
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-upload-failure" });
      if (init.method === "PUT") return new Response("no", { status: 500 });
      throw new Error("unexpected");
    });
    const uploadFailure = new BoxRunSandbox({ baseUrl: "http://boxrun", logger: { log: vi.fn(), warn } });
    await uploadFailure.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await expect(uploadFailure.writeFile("/a", "x")).rejects.toThrow("writeFile /a failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("uploadFileBytes"));
    await fs.unlink(caPath);
  });

  it("states unsupported mount semantics", async () => {
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await expect(sandbox.mountMemoryStore({ storeName: "m", storeId: "1", readOnly: true })).rejects.toThrow("no mount primitive");
    await expect(sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("no host-bind primitive");
  });

  it("destroys idempotently and tolerates already-gone, create, HTTP, and transport failures", async () => {
    const warn = vi.fn();
    const logger = { log: vi.fn(), warn };
    const never = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await expect(never.destroy()).resolves.toBeUndefined();

    let deleteStatus = 404;
    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-1" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "DELETE") return new Response(deleteStatus === 500 ? "bad" : null, { status: deleteStatus });
      throw new Error("unexpected");
    });
    const sandbox = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await sandbox.writeFile("/a", "x");
    await sandbox.destroy();
    expect(warn).not.toHaveBeenCalled();
    deleteStatus = 500;
    await sandbox.writeFile("/a", "x");
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("boxrun destroy non-OK: 500 bad");

    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-2" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      throw new Error("offline");
    });
    await sandbox.writeFile("/a", "x");
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("boxrun destroy error: offline");

    installFetch((url, init) => {
      if (url.endsWith("/boxes")) return json({ box_id: "box-default-logger" });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "DELETE") return new Response("bad", { status: 500 });
      throw new Error("unexpected");
    });
    const defaultLogger = new BoxRunSandbox({ baseUrl: "http://boxrun" });
    await defaultLogger.writeFile("/a", "x");
    await defaultLogger.destroy();

    installFetch(() => new Response("bad", { status: 500 }));
    const failedCreate = new BoxRunSandbox({ baseUrl: "http://boxrun", logger });
    await expect(failedCreate.exec("x")).rejects.toThrow();
    await expect(failedCreate.destroy()).resolves.toBeUndefined();
  });
});
