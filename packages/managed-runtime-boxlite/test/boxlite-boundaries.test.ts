import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  BoxLiteManagedRuntime,
  createBoxLiteManagedRuntime,
  createBoxLiteManagedRuntimeDriver,
  createBoxLiteProvider,
  type BoxLiteBoxSdkPort,
  type BoxLiteClientPort,
  type BoxLiteExecutionPort,
  type BoxLiteInputPort,
  type BoxLiteOutputPort,
} from "../src/boxlite";
import { fixtureCalls } from "./fixtures/boxlite-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = {
  ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z",
};

function expectedName(providerId: "litebox" | "boxrun" = "litebox") {
  return `oma-${createHash("sha256").update(`${providerId}:${scope.sessionId}`).digest("hex").slice(0, 32)}`;
}

function stream(...chunks: string[]): BoxLiteOutputPort {
  let index = 0;
  return { async next() { return chunks[index++] ?? null; } };
}

function execution(input: {
  exitCode?: number;
  stdout?: BoxLiteOutputPort;
  stderr?: BoxLiteOutputPort;
  stdin?: BoxLiteInputPort;
  signal?: ((signal: number) => Promise<void>) | undefined;
} = {}): BoxLiteExecutionPort {
  return {
    id: vi.fn(async () => "execution"),
    stdin: vi.fn(async () => input.stdin ?? {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }),
    stdout: vi.fn(async () => input.stdout ?? stream()),
    stderr: vi.fn(async () => input.stderr ?? stream()),
    wait: vi.fn(async () => ({ exitCode: input.exitCode ?? 0 })),
    kill: vi.fn(async () => undefined),
    ...(input.signal === undefined ? {} : { signal: vi.fn(input.signal) }),
  };
}

function box(input: {
  id?: string;
  name?: string | null;
  running?: boolean;
  status?: string;
  execution?: BoxLiteExecutionPort;
} = {}) {
  let running = input.running ?? true;
  const nextExecution = input.execution ?? execution();
  const value: BoxLiteBoxSdkPort = {
    id: input.id ?? "box",
    name: input.name === undefined ? expectedName() : input.name,
    info: () => ({
      id: input.id ?? "box",
      ...(value.name === null ? {} : { name: value.name }),
      state: { status: input.status ?? (running ? "Running" : "Stopped"), running },
    }),
    exec: vi.fn(async () => nextExecution),
    start: vi.fn(async () => { running = true; }),
    stop: vi.fn(async () => { running = false; }),
    copyIn: vi.fn(async () => undefined),
    copyOut: vi.fn(async (_source: string, target: string) => { await writeFile(target, new Uint8Array([1, 2, 3])); }),
  };
  return value;
}

function client(value: BoxLiteBoxSdkPort, created = true, assignName = true): BoxLiteClientPort {
  return {
    getOrCreate: vi.fn(async (_options, name) => {
      if (assignName) {
        Object.defineProperty(value, "name", { value: name ?? null, configurable: true });
      }
      return { created, box: value };
    }),
    get: vi.fn(async () => value),
    remove: vi.fn(async () => undefined),
  };
}

function acquisition(signal = new AbortController().signal) {
  return {
    scope,
    fence,
    plan: {
      workspaceStrategy: "retained_runtime" as const,
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: { type: "ama_worker" as const, process: { command: "worker" } },
    },
    workspace: { bindingId: "workspace", mountPath: "/workspace" as const },
    outputs: null,
    credentialEgress: null,
    signal,
  };
}

function direct(input: Parameters<typeof box>[0] = {}, sdk?: BoxLiteClientPort) {
  const value = box(input);
  const actualClient = sdk ?? client(value);
  return {
    value,
    client: actualClient,
    runtime: new BoxLiteManagedRuntime({
      providerId: "litebox", client: actualClient, box: value, expectedName: expectedName(),
    }),
  };
}

describe("BoxLite provider boundary contracts", () => {
  it("loads each official SDK connection mode lazily", async () => {
    fixtureCalls.length = 0;
    for (const connection of [
      undefined,
      { type: "embedded" as const, homeDir: "/tmp/boxlite" },
      { type: "rest" as const, url: "https://boxrun", clientId: "id", clientSecret: "secret", prefix: "/api" },
      { type: "rest" as const, url: "https://minimal" },
    ]) {
      const provider = createBoxLiteProvider({
        providerId: "litebox", image: "image", ...(connection === undefined ? {} : { connection }),
      });
      await expect(provider.create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).resolves.toBeInstanceOf(BoxLiteManagedRuntime);
    }
    expect(fixtureCalls).toEqual(expect.arrayContaining([
      { type: "default" },
      { type: "constructor", input: { homeDir: "/tmp/boxlite" } },
      { type: "rest", input: { url: "https://boxrun", clientId: "id", clientSecret: "secret", prefix: "/api" } },
      { type: "rest", input: { url: "https://minimal" } },
    ]));
  });

  it("maps runtime identity, every status, and renewal", async () => {
    const running = direct({ running: true });
    expect(running.runtime.runtimeHandle()).toEqual({ provider: "litebox", runtimeId: "box" });
    expect(running.runtime.runtimeCapabilities()).toEqual({ lease: false, suspend: ["filesystem"], checkpoint: [] });
    await expect(running.runtime.status()).resolves.toBe("running");
    for (const status of ["Stopped", "Exited"]) {
      const stopped = direct({ running: false, status });
      await expect(stopped.runtime.status()).resolves.toBe("suspended");
    }
    await expect(direct({ running: false, status: "Created" }).runtime.status()).resolves.toBe("unknown");
    await expect(running.runtime.renewLease()).resolves.toBeUndefined();

    await running.runtime.destroy();
    await expect(running.runtime.status()).resolves.toBe("stopped");
    await expect(running.runtime.renewLease()).rejects.toThrow("has been removed");
  });

  it("supports retained suspension and validates every resume field", async () => {
    const { value, runtime } = direct();
    await expect(runtime.suspend({ kind: "memory" })).rejects.toThrow("filesystem suspension only");
    const handle = await runtime.suspend({ kind: "filesystem" });
    expect(handle).toMatchObject({ provider: "litebox", sourceRuntimeId: "box", scope: "runtime" });
    expect(value.stop).toHaveBeenCalledOnce();
    for (const invalid of [
      { ...handle, provider: "boxrun" },
      { ...handle, scope: "portable" },
      { ...handle, sourceRuntimeId: "other" },
    ]) {
      await expect(runtime.resume(invalid as never)).rejects.toThrow("only resume its own");
    }
    await expect(runtime.resume(handle)).resolves.toBeUndefined();
    expect(value.start).toHaveBeenCalledOnce();
    await expect(runtime.checkpoint()).rejects.toThrow("not advertised as portable");
  });

  it("collects command streams, trims output, and reports nonzero exits", async () => {
    const success = direct({ execution: execution({ stdout: stream("a", "b"), stderr: stream("warn ") }) });
    await expect(success.runtime.exec("echo", 1)).resolves.toBe("ab\nwarn");
    expect(success.value.exec).toHaveBeenCalledWith(
      "/bin/sh", ["-lc", "echo"], [], false, null, 1, "/workspace",
    );
    const failed = direct({ execution: execution({ exitCode: 9, stdout: stream(), stderr: stream() }) });
    await expect(failed.runtime.exec("false")).resolves.toBe("\n[exit 9]");
  });

  it("copies text and binary files through cleaned temporary staging", async () => {
    const { value, runtime } = direct({ execution: execution() });
    await expect(runtime.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(runtime.readFile("/workspace/a")).resolves.toBe("\u0001\u0002\u0003");
    await expect(runtime.writeFile("/workspace/a/b.txt", "hello")).resolves.toBe("/workspace/a/b.txt");
    await expect(runtime.writeFileBytes("/workspace/a/c.bin", new Uint8Array([4]))).resolves.toBe("/workspace/a/c.bin");
    expect(value.copyOut).toHaveBeenCalled();
    expect(value.copyIn).toHaveBeenCalled();

    const mkdirFailure = direct({ execution: execution({ exitCode: 1, stderr: stream("denied") }) });
    await expect(mkdirFailure.runtime.writeFileBytes("/workspace/a", new Uint8Array()))
      .rejects.toThrow("failed to create /workspace: denied");
  });

  it("streams duplex IO and maps graceful and forced termination", async () => {
    const input = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const graceful = execution({ stdout: stream("a", "b"), stderr: stream("e"), stdin: input, signal: async () => undefined });
    const { value, runtime } = direct({ execution: graceful });
    const process = await runtime.spawnDuplexProcess({
      command: "worker", args: ["--poll"], cwd: "/workspace/project",
      env: { B: "2", OMIT: undefined },
    });
    const writer = process.stdin.getWriter();
    await writer.write(new Uint8Array([1, 2]));
    await writer.close();
    await expect(Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ])).resolves.toEqual(["ab", "e", { code: 0, signal: null }]);
    expect(value.exec).toHaveBeenCalledWith("worker", ["--poll"], [["B", "2"]], false, null, 0, "/workspace/project");
    await process.kill();
    expect(graceful.signal).toHaveBeenCalledWith(15);
    await process.kill("SIGKILL");
    expect(graceful.kill).toHaveBeenCalledOnce();

    const forced = execution();
    const second = await direct({ execution: forced }).runtime.spawnDuplexProcess({ command: "worker" });
    const secondWriter = second.stdin.getWriter();
    await secondWriter.abort();
    await second.kill();
    expect(forced.kill).toHaveBeenCalledTimes(2);
  });

  it("turns output-source failures into stream errors", async () => {
    const badSource = { async next(): Promise<string | null> { throw new Error("stream failed"); } };
    const process = await direct({ execution: execution({ stdout: badSource }) }).runtime
      .spawnDuplexProcess({ command: "worker" });
    await expect(new Response(process.stdout).text()).rejects.toThrow("stream failed");
    await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("retries destruction after provider failure and removes only once after success", async () => {
    const value = box();
    const sdk = client(value);
    sdk.remove = vi.fn()
      .mockRejectedValueOnce(new Error("remove failed"))
      .mockResolvedValue(undefined);
    const runtime = new BoxLiteManagedRuntime({ providerId: "litebox", client: sdk, box: value, expectedName: expectedName() });
    await expect(runtime.destroy()).rejects.toThrow("remove failed");
    await expect(runtime.destroy()).resolves.toBeUndefined();
    await runtime.destroy();
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });

  it("validates allocation context, aborts, options, ownership, and workspace readiness", async () => {
    const value = box({ running: false });
    const sdk = client(value);
    const provider = createBoxLiteProvider({
      providerId: "litebox", client: sdk, image: "image", cpus: 2, memoryMib: 512, diskSizeGb: 8,
    });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined))
      .rejects.toThrow("requires acquisition context");
    const before = new AbortController(); before.abort();
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(before.signal))).rejects.toThrow();
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .resolves.toBeInstanceOf(BoxLiteManagedRuntime);
    expect(value.start).toHaveBeenCalledOnce();
    expect(sdk.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ cpus: 2, memoryMib: 512, diskSizeGb: 8 }), expectedName());

    const during = new AbortController();
    const aborting = createBoxLiteProvider({
      providerId: "litebox", client: sdk, image: "image",
      allocationOptions: () => { during.abort(); return {}; },
    });
    await expect(aborting.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(during.signal))).rejects.toThrow();

    for (const invalid of [box({ id: "", name: expectedName() }), box({ name: "foreign" })]) {
      const invalidClient = client(invalid, true, false);
      await expect(createBoxLiteProvider({ providerId: "litebox", client: invalidClient, image: "image" })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toThrow("ownership name mismatch");
      expect(invalidClient.remove).toHaveBeenCalled();
    }

    for (const output of [{ stderr: stream("stderr"), stdout: stream() }, { stderr: stream(), stdout: stream("stdout") }]) {
      const bad = box({ execution: execution({ exitCode: 1, ...output }) });
      await expect(createBoxLiteProvider({ providerId: "litebox", client: client(bad), image: "image" })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toThrow(/stderr|stdout/);
    }
  });

  it("does not delete a pre-existing runtime when create validation fails", async () => {
    const value = box({ name: "foreign" });
    const sdk = client(value, false, false);
    await expect(createBoxLiteProvider({ providerId: "litebox", client: sdk, image: "image" })
      .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .rejects.toThrow("ownership name mismatch");
    expect(sdk.remove).not.toHaveBeenCalled();
  });

  it("validates resume, absent runtimes, optional acquisition, and restore", async () => {
    const value = box({ running: false });
    const sdk = client(value);
    const provider = createBoxLiteProvider({ providerId: "litebox", client: sdk, image: "image" });
    await expect(provider.resume({ provider: "boxrun", runtimeId: "box" }, {} as never, {}, undefined))
      .rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "litebox", runtimeId: "" }, {} as never, {}, undefined))
      .rejects.toThrow("incompatible runtime handle");
    sdk.get = vi.fn(async () => null);
    await expect(provider.resume(
      { provider: "litebox", runtimeId: "missing" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined,
    )).rejects.toThrow("runtime not found");
    sdk.get = vi.fn(async () => value);
    await expect(provider.resume(
      { provider: "litebox", runtimeId: "box" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined,
    )).resolves.toBeInstanceOf(BoxLiteManagedRuntime);
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.resume(
      { provider: "litebox", runtimeId: "box" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal),
    )).rejects.toThrow();
    await expect(provider.restore({} as never, {} as never, {}, undefined)).rejects
      .toThrow("does not advertise portable workspace restore");
  });

  it("projects optional resources and driver placement", async () => {
    const value = box();
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined,
      revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn() };
    const driver = createBoxLiteManagedRuntimeDriver({
      providerId: "boxrun", client: client(value), image: "image", leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(), credentialEgress: egress, sessionInputs,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "boxrun",
      capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } },
      credentialEgress: egress.capabilities,
    });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects.toThrow("does not support");
    const resources = await driver.create({ placement: "in_process" } as never);
    expect(resources).toMatchObject({ sessionInputs });
    await expect(resources.credentialEgress?.capabilities(scope)).resolves.toEqual(egress.capabilities);

    const plain = createBoxLiteManagedRuntimeDriver({
      providerId: "litebox", client: client(value), image: "image", leaseTtlMs: 100, outputStore: null,
    });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    const plainResources = await plain.create({ placement: "in_process" } as never);
    expect(plainResources).not.toHaveProperty("credentialEgress");
    expect(plainResources).not.toHaveProperty("sessionInputs");

    const defaultPrefix = createBoxLiteManagedRuntime({
      providerId: "litebox", client: client(value), image: "image", leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(), outputKeyPrefix: undefined,
    });
    await expect(defaultPrefix.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });
  });

  it("reaps present runtimes and treats absent runtimes as already complete", async () => {
    const lease = {
      leaseId: "lease", runtimeId: "box", provider: "litebox", expiresAt: "2026-09-01T00:00:00.000Z",
      handle: { provider: "litebox", runtimeId: "box" }, sandbox: {} as never,
    };
    for (const present of [true, false]) {
      const value = box();
      const sdk = client(value);
      sdk.get = vi.fn(async () => present ? value : null);
      const runtime = createBoxLiteManagedRuntime({ providerId: "litebox", client: sdk, image: "image", leaseTtlMs: 100 });
      await runtime.sandbox.reap({ scope, lease, reason: "orphan" } as never);
      expect(sdk.remove).toHaveBeenCalledTimes(present ? 1 : 0);
    }
  });
});
