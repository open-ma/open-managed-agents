import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareBridgeManagedRuntime,
  createCloudflareBridgeProvider,
} from "../src/cloudflare-bridge";
import * as cloudflareBridge from "../src/cloudflare-bridge";

function sse(...events: Array<{ event: string; data: string }>): Response {
  return new Response(
    events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function bridgeFetch() {
  const files = new Map<string, Uint8Array>();
  let nextId = 0;
  const running = new Set<string>();
  const calls: Array<{ method: string; path: string; auth: string | null; body?: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    const url = new URL(request.url);
    let body: unknown;
    if (request.method === "POST" && url.pathname.endsWith("/exec")) {
      body = await request.json();
    }
    calls.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      auth: request.headers.get("authorization"),
      ...(body === undefined ? {} : { body }),
    });
    if (request.method === "POST" && url.pathname === "/v1/sandbox") {
      const id = `sandbox-${++nextId}`;
      running.add(id);
      return Response.json({ id });
    }
    const match = url.pathname.match(/^\/v1\/sandbox\/([^/]+)(\/.*)?$/);
    if (match === null) return new Response("not found", { status: 404 });
    const id = decodeURIComponent(match[1]!);
    const operation = match[2] ?? "";
    if (request.method === "GET" && operation === "/running") {
      return Response.json({ running: running.has(id) });
    }
    if (request.method === "DELETE" && operation === "") {
      running.delete(id);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && operation === "/exec") {
      const argv = (body as { argv?: string[] } | undefined)?.argv ?? [];
      const commandOutput = argv[0] === "base64" && argv[3] !== undefined
        ? Buffer.from(files.get(argv[3]) ?? new Uint8Array()).toString("base64")
        : argv[0] === "find"
          ? `${[...files.keys()].filter((path) => path.startsWith("/mnt/session/outputs/"))
            .join("\0")}\0`
          : "hello bridge";
      return sse(
        { event: "stdout", data: Buffer.from(commandOutput).toString("base64") },
        { event: "stderr", data: Buffer.from("warning").toString("base64") },
        { event: "exit", data: JSON.stringify({ exit_code: 0 }) },
      );
    }
    if (operation.startsWith("/file/")) {
      const path = decodeURIComponent(operation.slice("/file/".length));
      if (request.method === "PUT") {
        files.set(path, new Uint8Array(await request.arrayBuffer()));
        return Response.json({ ok: true });
      }
      const value = files.get(path);
      return value === undefined
        ? new Response("missing", { status: 404 })
        : new Response(value, { status: 200 });
    }
    if (request.method === "POST" && operation === "/persist") {
      return new Response(new TextEncoder().encode("workspace-tar"));
    }
    if (request.method === "POST" && operation === "/hydrate") {
      files.set("hydrated.tar", new Uint8Array(await request.arrayBuffer()));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, fetch, files, running };
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("Cloudflare Sandbox Bridge managed runtime provider package", () => {
  it("projects the bridge through the same swappable provider driver Port", async () => {
    const createDriver = Reflect.get(
      cloudflareBridge,
      "createCloudflareBridgeManagedRuntimeDriver",
    );
    expect(createDriver).toBeTypeOf("function");
    const store = new InMemoryBlobStore();
    const driver = (createDriver as unknown as (input: unknown) => {
      descriptor(): unknown;
      create(input: unknown): Promise<Record<string, unknown>>;
    })({
      baseUrl: "https://bridge.example.test",
      apiKey: "bridge-secret",
      checkpointStore: store,
      outputStore: store,
      leaseTtlMs: 90_000,
      fetch: bridgeFetch().fetch,
    });

    expect(driver.descriptor()).toEqual(expect.objectContaining({
      provider: "cloudflare-bridge",
      placements: ["driver_service"],
      capabilities: expect.objectContaining({
        workspace: { strategies: ["checkpoint_restore"] },
        outputs: {
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        },
        harness: { drivers: ["ama_worker"] },
      }),
    }));
    const resources = await driver.create({ placement: "driver_service" });
    expect(resources).toEqual(expect.objectContaining({
      sandbox: expect.any(Object),
      workspace: expect.any(Object),
      outputs: expect.any(Object),
      harnessDriver: expect.any(Object),
    }));
    expect(resources).not.toHaveProperty("supervisorTransport");
  });

  it("exposes the operator Session resource materializer through the driver package", async () => {
    const store = new InMemoryBlobStore();
    const sessionInputs = { materialize: async () => undefined };
    const driver = cloudflareBridge.createCloudflareBridgeManagedRuntimeDriver({
      baseUrl: "https://bridge.example.test",
      apiKey: "bridge-secret",
      checkpointStore: store,
      outputStore: store,
      leaseTtlMs: 90_000,
      fetch: bridgeFetch().fetch,
      sessionInputs,
    });

    await expect(driver.create({ placement: "driver_service" } as never)).resolves
      .toMatchObject({ sessionInputs });
  });

  it("rejects an existing checkpoint blob whose bytes do not match its content address", async () => {
    const fake = bridgeFetch();
    const store = new InMemoryBlobStore();
    const provider = createCloudflareBridgeProvider({
      baseUrl: "https://bridge.example.test",
      apiKey: "bridge-secret",
      checkpointStore: store,
      fetch: fake.fetch,
    });
    const runtime = await provider.create(
      { sessionId: "session-1", workdir: "/workspace" },
      {},
    );
    const archive = new TextEncoder().encode("workspace-tar");
    const digest = await crypto.subtle.digest("SHA-256", archive);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await store.put(
      `cloudflare-bridge-workspaces/sandbox-1/turn-1-${hash}.tar`,
      new TextEncoder().encode("corrupted-tar"),
    );

    await expect(
      runtime.checkpoint({ kind: "filesystem", name: "turn-1" }),
    ).rejects.toThrow("checkpoint storage collision");
  });

  it("turns an aborted SSE command into a terminated process instead of leaking a rejection", async () => {
    const fake = bridgeFetch();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      if (!new URL(request.url).pathname.endsWith("/exec")) {
        return fake.fetch(request);
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => {
            controller.error(request.signal.reason);
          }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const provider = createCloudflareBridgeProvider({
      baseUrl: "https://bridge.example.test",
      apiKey: "bridge-secret",
      checkpointStore: new InMemoryBlobStore(),
      fetch,
    });
    const runtime = await provider.create({ sessionId: "session-1", workdir: "/workspace" }, {});
    const process = await runtime.spawnDuplexProcess({ command: "worker" });

    await process.kill("SIGKILL");
    await expect(process.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("uses the official authenticated lifecycle, argv SSE, and workspace file routes", async () => {
    const fake = bridgeFetch();
    const store = new InMemoryBlobStore();
    const provider = createCloudflareBridgeProvider({
      baseUrl: "https://bridge.example.test/",
      apiKey: "bridge-secret",
      checkpointStore: store,
      fetch: fake.fetch,
    });
    const context = { sessionId: "session/one", workdir: "/workspace" };
    const runtime = await provider.create(context, {});

    expect(runtime.runtimeHandle()).toEqual({
      provider: "cloudflare-sandbox-bridge",
      runtimeId: "sandbox-1",
    });
    expect(runtime.runtimeCapabilities()).toEqual({
      lease: false,
      suspend: [],
      checkpoint: ["filesystem"],
    });
    expect(await runtime.exec("printf '%s' hello", 2_000)).toBe("hello bridge");
    const process = await runtime.spawnDuplexProcess({
      command: "worker",
      args: ["--once"],
      env: { Z_LAST: "z", A_FIRST: "a", OMITTED: undefined },
      cwd: "/workspace/project",
    });
    const [stdout, stderr, exit] = await Promise.all([
      streamText(process.stdout),
      streamText(process.stderr),
      process.exited,
    ]);
    expect({ stdout, stderr, exit }).toEqual({
      stdout: "hello bridge",
      stderr: "warning",
      exit: { code: 0, signal: null },
    });
    await runtime.writeFileBytes?.("/workspace/a b.bin", new Uint8Array([0, 1, 255]));
    expect(await runtime.readFileBytes?.("/workspace/a b.bin")).toEqual(
      new Uint8Array([0, 1, 255]),
    );
    await expect(runtime.readFile("/etc/passwd")).rejects.toThrow("within /workspace");
    fake.files.set("/mnt/session/outputs/result.bin", new Uint8Array([4, 5, 6]));
    expect(await runtime.readFileBytes?.("/mnt/session/outputs/result.bin")).toEqual(
      new Uint8Array([4, 5, 6]),
    );

    const checkpoint = await runtime.checkpoint({ kind: "filesystem", name: "turn-1" });
    expect(checkpoint).toMatchObject({
      provider: "cloudflare-sandbox-bridge",
      sourceRuntimeId: "sandbox-1",
      kind: "filesystem",
      scope: "portable",
      metadata: { blobKey: expect.stringContaining("turn-1") },
    });
    expect(store.size()).toBe(1);
    const restored = await provider.restore(checkpoint, context, {});
    expect(restored.runtimeHandle().runtimeId).toBe("sandbox-2");
    expect(new TextDecoder().decode(fake.files.get("hydrated.tar"))).toBe("workspace-tar");

    await Promise.all([
      restored.destroy?.(),
      restored.destroy?.(),
      restored.destroy?.(),
    ]);
    await restored.destroy?.();
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.calls.every((call) => call.auth === "Bearer bridge-secret")).toBe(true);
    const execCalls = fake.calls.filter((call) => call.path.endsWith("/exec"));
    expect(execCalls[0]?.body).toEqual({
      argv: ["sh", "-lc", "printf '%s' hello"],
      timeout_ms: 2_000,
      cwd: "/workspace",
    });
    expect(execCalls[1]?.body).toEqual({
      argv: ["env", "A_FIRST=a", "Z_LAST=z", "worker", "--once"],
      cwd: "/workspace/project",
    });
  });

  it("composes the Bridge as an ama worker with the canonical output mount", async () => {
    const fake = bridgeFetch();
    const store = new InMemoryBlobStore();
    const composition = createCloudflareBridgeManagedRuntime({
      baseUrl: "https://bridge.example.test",
      apiKey: "bridge-secret",
      checkpointStore: store,
      outputStore: store,
      fetch: fake.fetch,
      leaseTtlMs: 90_000,
    });
    const scope = {
      workspaceId: "workspace-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      workId: "work-1",
    };
    const fence = {
      ...scope,
      ownerId: "worker-1",
      generation: 1,
      token: "fence-1",
      expiresAt: "2026-09-06T00:00:00.000Z",
    };
    const output = await composition.outputs.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "outputs-1",
      signal: new AbortController().signal,
    });
    expect(output.mountPath).toBe("/mnt/session/outputs");
    expect(await composition.harness.driverCapabilities(scope)).toEqual({ drivers: ["ama_worker"] });

    const workspace = await composition.workspace.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "workspace-1",
      signal: new AbortController().signal,
    });
    const sandbox = await composition.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "final_collect",
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: output,
      signal: new AbortController().signal,
    });
    await composition.outputs.attach({
      scope,
      fence,
      strategy: "final_collect",
      binding: output,
      sandbox,
      signal: new AbortController().signal,
    });
    fake.files.set("/mnt/session/outputs/result.bin", new Uint8Array([9, 8, 7]));
    const entries = await composition.outputs.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding: output,
      signal: new AbortController().signal,
    });
    expect(entries).toMatchObject([{ logicalPath: "result.bin", size: 3 }]);
    const manifest = await composition.outputs.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding: output,
      entries,
      idempotencyKey: "finalize-1",
      signal: new AbortController().signal,
    });
    expect(manifest.entries).toBe(1);
    expect(store.keys().some((key) => key.includes("cloudflare-bridge-output-candidates")))
      .toBe(true);
  });
});
