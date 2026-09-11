import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import type { SandboxCheckpointHandle } from "@open-managed-agents/sandbox";
import { describe, expect, it, vi } from "vitest";

import {
  CloudflareBridgeRuntime,
  createCloudflareBridgeManagedRuntime,
  createCloudflareBridgeManagedRuntimeDriver,
  createCloudflareBridgeProvider,
} from "../src/cloudflare-bridge";

const encoder = new TextEncoder();

function runtime(
  fetch: typeof globalThis.fetch,
  input: Partial<ConstructorParameters<typeof CloudflareBridgeRuntime>[0]> = {},
) {
  return new CloudflareBridgeRuntime({
    baseUrl: "https://bridge.example.test/",
    apiKey: "secret",
    runtimeId: "runtime/one",
    checkpointStore: new InMemoryBlobStore(),
    fetch,
    ...input,
  });
}

function sseText(text: string, status = 200, contentType = "text/event-stream") {
  return new Response(text, { status, headers: { "content-type": contentType } });
}

async function digest(bytes: Uint8Array) {
  return `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function checkpoint(
  store: InMemoryBlobStore,
  bytes = encoder.encode("archive"),
): Promise<SandboxCheckpointHandle> {
  const blobKey = "checkpoints/archive.tar";
  await store.put(blobKey, bytes);
  return {
    provider: "cloudflare-sandbox-bridge",
    checkpointId: await digest(bytes),
    sourceRuntimeId: "old-runtime",
    kind: "filesystem",
    scope: "portable",
    metadata: { blobKey, contentHash: await digest(bytes), size: bytes.byteLength },
  };
}

async function consumeProcess(process: Awaited<ReturnType<CloudflareBridgeRuntime["spawnDuplexProcess"]>>) {
  return Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
}

describe("Cloudflare Sandbox Bridge boundary contracts", () => {
  it("validates constructor, checkpoint prefix, and hydrate limits", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const required = { checkpointStore: new InMemoryBlobStore(), fetch };
    for (const fields of [
      { baseUrl: "", apiKey: "secret", runtimeId: "runtime" },
      { baseUrl: "https://bridge", apiKey: "", runtimeId: "runtime" },
      { baseUrl: "https://bridge", apiKey: "secret", runtimeId: "" },
    ]) {
      expect(() => new CloudflareBridgeRuntime({ ...required, ...fields })).toThrow("required");
    }
    for (const checkpointKeyPrefix of ["/", ".", "safe/../unsafe"]) {
      expect(() => runtime(fetch, { checkpointKeyPrefix })).toThrow("prefix must be safe");
    }
    expect(() => runtime(fetch, { maxHydrateBytes: 1.5 })).toThrow("positive integer");
    expect(() => runtime(fetch, { maxHydrateBytes: 0 })).toThrow("positive integer");
    expect(() => new CloudflareBridgeRuntime({
      baseUrl: "https://bridge",
      apiKey: "secret",
      runtimeId: "runtime",
      checkpointStore: new InMemoryBlobStore(),
    })).not.toThrow();
  });

  it("validates workspace, output, and working-directory paths", async () => {
    const ok = sseText("event: exit\ndata: {\"exit_code\":0}\n\n");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => ok.clone());
    const instance = runtime(fetch);

    await expect(instance.readFile("/workspace/")).rejects.toThrow("file path is unsafe");
    await expect(instance.readFile("/workspace/a/../b")).rejects.toThrow("file path is unsafe");
    await expect(instance.readFileBytes("/mnt/other/file")).rejects.toThrow("limited to Session outputs");
    await expect(instance.readFileBytes("/mnt/session/outputs/")).rejects.toThrow("output path is unsafe");
    await expect(instance.readFileBytes("/mnt/session/outputs/a/../b")).rejects.toThrow("output path is unsafe");
    await expect(instance.spawnDuplexProcess({ command: "x", cwd: "/tmp" })).rejects
      .toThrow("cwd must resolve within /workspace");
    await expect(instance.spawnDuplexProcess({ command: "x", cwd: "/workspace/../tmp" })).rejects
      .toThrow("cwd is unsafe");

    const process = await instance.spawnDuplexProcess({ command: "x" });
    await expect(consumeProcess(process)).resolves.toEqual(["", "", { code: 0, signal: null }]);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      argv: ["x"],
      cwd: "/workspace",
    });
    const processWithEnv = await instance.spawnDuplexProcess({ command: "x", env: { KEY: "value" } });
    await consumeProcess(processWithEnv);
  });

  it("reports lifecycle status, renewal, suspension, and response failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ running: false }))
      .mockResolvedValueOnce(Response.json({ running: true }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.error(new Error("unreadable")); },
      }), { status: 503 }));
    const instance = runtime(fetch);
    await expect(instance.renewLease()).rejects.toThrow("not running");
    await expect(instance.renewLease()).resolves.toBeUndefined();
    await expect(instance.status()).rejects.toThrow("Cloudflare Sandbox Bridge 503");
    await expect(instance.suspend()).rejects.toThrow("does not expose runtime suspension");

    const notFound = runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("gone", { status: 404 })));
    await expect(notFound.status()).rejects.toThrow("404: gone");
  });

  it("validates every portable checkpoint field before creating a replacement runtime", async () => {
    const store = new InMemoryBlobStore();
    const valid = await checkpoint(store);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createCloudflareBridgeProvider({
      baseUrl: "https://bridge",
      apiKey: "secret",
      checkpointStore: store,
      fetch,
    });
    const variants: unknown[] = [
      { ...valid, provider: "other" },
      { ...valid, kind: "memory" },
      { ...valid, scope: "runtime" },
      { ...valid, metadata: undefined },
      { ...valid, metadata: { ...valid.metadata, blobKey: "" } },
      { ...valid, metadata: { ...valid.metadata, contentHash: 1 } },
      { ...valid, metadata: { ...valid.metadata, contentHash: "md5:no" } },
      { ...valid, metadata: { ...valid.metadata, size: "7" } },
      { ...valid, metadata: { ...valid.metadata, size: 1.5 } },
      { ...valid, metadata: { ...valid.metadata, size: -1 } },
    ];
    for (const variant of variants) {
      await expect(provider.restore(variant as never, {} as never, {})).rejects
        .toThrow("Incompatible Cloudflare Bridge workspace checkpoint");
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(provider.resume({ provider: "other", runtimeId: "runtime" }, {} as never, {}))
      .rejects.toThrow("Incompatible Cloudflare Bridge runtime handle");
    await expect(provider.resume({ provider: "cloudflare-sandbox-bridge", runtimeId: "" }, {} as never, {}))
      .rejects.toThrow("Incompatible Cloudflare Bridge runtime handle");
  });

  it("covers checkpoint storage identity, exclusions, names, and archive limits", async () => {
    const archive = encoder.encode("archive");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response(archive, { status: 200 }),
    );
    const store = new InMemoryBlobStore();
    const instance = runtime(fetch, {
      checkpointStore: store,
      checkpointKeyPrefix: "/safe/prefix/",
      checkpointExcludes: ["node_modules", ".git"],
      maxHydrateBytes: archive.byteLength,
    });
    await expect(instance.checkpoint({ kind: "memory" })).rejects.toThrow("only supports filesystem");
    const first = await instance.checkpoint({ kind: "filesystem", name: "turn / one" });
    const second = await instance.checkpoint({ kind: "filesystem", name: "turn / one" });
    expect(second).toEqual(first);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("?excludes=node_modules%2C.git");
    expect(first.metadata?.blobKey).toContain("turn---one");

    const defaultName = await runtime(fetch, { checkpointStore: new InMemoryBlobStore() })
      .checkpoint({ kind: "filesystem" });
    expect(defaultName.checkpointId).toMatch(/^sha256:/);

    const tooLarge = runtime(fetch, { maxHydrateBytes: archive.byteLength - 1 });
    await expect(tooLarge.checkpoint({ kind: "filesystem" })).rejects.toThrow("exceeds hydrate limit");
    const failed = runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("bad", { status: 500 })));
    await expect(failed.checkpoint({ kind: "filesystem" })).rejects.toThrow("500: bad");
  });

  it("rejects each checkpoint collision and hydration corruption mode", async () => {
    const archive = encoder.encode("archive");
    const hash = (await digest(archive)).slice("sha256:".length);
    const key = `cloudflare-bridge-workspaces/runtime%2Fone/turn-${hash}.tar`;
    const collisionStore = (existing: unknown) => ({
      put: vi.fn(async () => null),
      get: vi.fn(async () => existing),
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response(archive),
    );
    for (const existing of [
      null,
      { size: archive.byteLength + 1, bytes: async () => archive },
      { size: archive.byteLength, bytes: async () => encoder.encode("xxxxxxx") },
    ]) {
      const store = collisionStore(existing);
      await expect(runtime(fetch, { checkpointStore: store as never })
        .checkpoint({ kind: "filesystem", name: "turn" }))
        .rejects.toThrow("checkpoint storage collision");
      expect(store.get).toHaveBeenCalledWith(key);
    }

    const store = new InMemoryBlobStore();
    const valid = await checkpoint(store, archive);
    await expect(runtime(fetch, { checkpointStore: store, maxHydrateBytes: archive.byteLength - 1 }).resume(valid))
      .rejects.toThrow("checkpoint exceeds hydrate limit");
    await expect(runtime(fetch).resume(valid)).rejects.toThrow("archive is missing");

    const wrongSize = { ...valid, metadata: { ...valid.metadata, size: archive.byteLength + 1 } };
    await expect(runtime(fetch, { checkpointStore: store }).resume(wrongSize)).rejects
      .toThrow("wrong size");
    const wrongHash = { ...valid, metadata: { ...valid.metadata, contentHash: "sha256:bad" } };
    await expect(runtime(fetch, { checkpointStore: store }).resume(wrongHash)).rejects
      .toThrow("hash mismatch");
    const hydrateFailure = runtime(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("no", { status: 502 })),
      { checkpointStore: store },
    );
    await expect(hydrateFailure.resume(valid)).rejects.toThrow("502: no");
  });

  it("handles all duplex terminal events and stream framing", async () => {
    const cases: Array<{ response: Response; error: string }> = [
      { response: new Response("bad", { status: 500 }), error: "500: bad" },
      { response: new Response(null), error: "200" },
      { response: sseText("", 200, "text/plain"), error: "did not return an SSE" },
      { response: sseText("event: exit\ndata: {}\n\n"), error: "invalid exit event" },
      { response: sseText("event: error\ndata: {\"code\":\"E_FAIL\",\"error\":\"failed\"}\n\n"), error: "(E_FAIL): failed" },
      { response: sseText("event: error\ndata: {}\n\n"), error: ": unknown" },
      { response: sseText("event: progress\ndata: ignored\n\n"), error: "without a terminal event" },
    ];
    for (const entry of cases) {
      const instance = runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(entry.response));
      if (!entry.response.ok || entry.response.body === null || !entry.response.headers.get("content-type")?.includes("text/event-stream")) {
        await expect(instance.spawnDuplexProcess({ command: "x" })).rejects.toThrow(entry.error);
      } else {
        const process = await instance.spawnDuplexProcess({ command: "x" });
        await expect(consumeProcess(process)).rejects.toThrow(entry.error);
      }
    }

    const framed = sseText(
      "\r\nevent: stdout\r\ndata: YQ==\r\n\r\nevent: exit\r\ndata: {\"exit_code\":0}",
    );
    const process = await runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(framed))
      .spawnDuplexProcess({ command: "x" });
    await expect(consumeProcess(process)).resolves.toEqual(["a", "", { code: 0, signal: null }]);

    const stdinProcess = await runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseText("event: exit\ndata: {\"exit_code\":0}\n\n"),
    )).spawnDuplexProcess({ command: "x" });
    const writer = stdinProcess.stdin.getWriter();
    await expect(writer.write(encoder.encode("input"))).rejects.toThrow("has no stdin");
    await consumeProcess(stdinProcess);
  });

  it("uses SIGTERM by default when a duplex request is cancelled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) =>
      new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    );
    const process = await runtime(fetch).spawnDuplexProcess({ command: "x" });
    await process.kill();
    await expect(process.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    const closesOnAbort = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) =>
      new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    );
    const closing = await runtime(closesOnAbort).spawnDuplexProcess({ command: "x" });
    await closing.kill("SIGKILL");
    await expect(closing.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("handles command and output failures without hiding stderr", async () => {
    const response = (body: string) => runtime(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(sseText(body)),
    );
    await expect(response("event: exit\ndata: {}\n\n").exec("x")).rejects.toThrow("invalid exit event");
    await expect(response("event: error\ndata: {\"code\":\"E\",\"error\":\"bad\"}\n\n").exec("x"))
      .rejects.toThrow("failed (E): bad");
    await expect(response("event: error\ndata: {}\n\n").exec("x")).rejects.toThrow("failed: unknown");
    await expect(response("event: stdout\ndata: YQ==\n\n").exec("x")).rejects
      .toThrow("without an exit event");
    await expect(response("event: stderr\ndata: YmFk\n\nevent: exit\ndata: {\"exit_code\":7}\n\n").exec("x"))
      .rejects.toThrow("exited with 7: bad");
    await expect(response("event: stderr\ndata: YmFk\n\nevent: exit\ndata: {\"exit_code\":8}\n\n")
      .readFileBytes("/mnt/session/outputs/result.bin"))
      .rejects.toThrow("output read exited with 8: bad");
    const joined = await response(
      "event: stdout\ndata: YQ==\n\nevent: stdout\ndata: Yg==\n\nevent: exit\ndata: {\"exit_code\":0}\n\n",
    ).exec("x");
    expect(joined).toBe("ab");

    await expect(runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("gateway", { status: 502 }),
    )).exec("x")).rejects.toThrow("502: gateway");
    await expect(runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null),
    )).exec("x")).rejects.toThrow("Cloudflare Sandbox Bridge 200");
    await expect(runtime(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseText("", 200, "application/json"),
    )).exec("x")).rejects.toThrow("did not return an SSE stream");
  });

  it("propagates workspace file failures and supports the text convenience methods", async () => {
    const failed = runtime(vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response("denied", { status: 403 }),
    ));
    await expect(failed.readFile("/workspace/file")).rejects.toThrow("403: denied");
    await expect(failed.writeFileBytes("/workspace/file", new Uint8Array())).rejects.toThrow("403: denied");

    const calls: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return request.method === "GET"
        ? new Response("hello")
        : new Response(null, { status: 204 });
    });
    const instance = runtime(fetch);
    await expect(instance.writeFile("/workspace/a b.txt", "hello")).resolves.toBe("/workspace/a b.txt");
    await expect(instance.readFile("/workspace/a b.txt")).resolves.toBe("hello");
    expect(new Uint8Array(await calls[0]!.arrayBuffer())).toEqual(encoder.encode("hello"));
  });

  it("makes destruction idempotent, accepts absence, and permits retry after failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const instance = runtime(fetch);
    await expect(instance.destroy()).rejects.toThrow("503: busy");
    await expect(instance.destroy()).resolves.toBeUndefined();
    await expect(instance.status()).resolves.toBe("stopped");
    await expect(instance.destroy()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates provider creation, resume, and cleans up failed restores", async () => {
    const store = new InMemoryBlobStore();
    const valid = await checkpoint(store);
    for (const response of [
      new Response("unavailable", { status: 503 }),
      Response.json({}),
      Response.json({ id: "" }),
    ]) {
      const provider = createCloudflareBridgeProvider({
        baseUrl: "https://bridge/",
        apiKey: "secret",
        checkpointStore: store,
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
      });
      await expect(provider.create({} as never, {})).rejects.toThrow();
    }

    const resumed = await createCloudflareBridgeProvider({
      baseUrl: "https://bridge",
      apiKey: "secret",
      checkpointStore: store,
      fetch: vi.fn<typeof globalThis.fetch>(),
    }).resume({ provider: "cloudflare-sandbox-bridge", runtimeId: "existing" }, {} as never, {});
    expect(resumed.runtimeHandle().runtimeId).toBe("existing");

    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: "replacement" }))
      .mockResolvedValueOnce(new Response("hydrate failed", { status: 500 }))
      .mockResolvedValueOnce(new Response("destroy failed", { status: 500 }));
    const provider = createCloudflareBridgeProvider({
      baseUrl: "https://bridge",
      apiKey: "secret",
      checkpointStore: store,
      fetch,
    });
    await expect(provider.restore(valid, {} as never, {})).rejects.toThrow("hydrate failed");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("projects optional composition settings and rejects unsupported driver placement", async () => {
    const base = {
      baseUrl: "https://bridge",
      apiKey: "secret",
      checkpointStore: new InMemoryBlobStore(),
      leaseTtlMs: 100,
      fetch: vi.fn<typeof globalThis.fetch>(),
    };
    const withoutOutput = createCloudflareBridgeManagedRuntimeDriver({ ...base, outputStore: null });
    expect(withoutOutput.descriptor().capabilities.outputs.strategies).toEqual([]);
    await expect(withoutOutput.create({ placement: "sandbox" } as never)).rejects
      .toThrow("does not support sandbox placement");
    const resources = await withoutOutput.create({ placement: "driver_service" } as never);
    expect(resources).not.toHaveProperty("sessionInputs");

    const readiness = { timeoutMs: 500, pollIntervalMs: 10 };
    const composition = createCloudflareBridgeManagedRuntime({ ...base, readiness });
    expect(composition.outputs).toBeDefined();

    const withUndefinedOutput = createCloudflareBridgeManagedRuntimeDriver({ ...base });
    expect(withUndefinedOutput.descriptor().capabilities.outputs.strategies).toEqual([]);
    expect(createCloudflareBridgeProvider({
      baseUrl: "https://bridge",
      apiKey: "secret",
      checkpointStore: new InMemoryBlobStore(),
    })).toBeDefined();
  });
});
