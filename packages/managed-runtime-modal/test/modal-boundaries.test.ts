import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { describe, expect, it, vi } from "vitest";

import {
  ModalRuntime,
  createModalManagedRuntime,
  createModalManagedRuntimeDriver,
  createModalProvider,
  type ModalProcessPort,
  type ModalSandboxSdkPort,
  type ModalSdkPort,
} from "../src/modal";
import { failNextModalFixtureFind, modalFixtureCalls } from "./fixtures/modal-sdk";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" };

function stream(...chunks: string[]) {
  return new ReadableStream<string>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
}

function process(input: {
  code?: number;
  stdout?: string[];
  stderr?: string[];
  sink?: {
    write?: (chunk: string) => void | PromiseLike<void>;
    close?: () => void | PromiseLike<void>;
    abort?: (reason?: unknown) => void | PromiseLike<void>;
  };
} = {}): ModalProcessPort {
  return {
    stdin: new WritableStream<string>(input.sink),
    stdout: stream(...(input.stdout ?? [])),
    stderr: stream(...(input.stderr ?? [])),
    wait: vi.fn(async () => input.code ?? 0),
  };
}

function sandbox(input: {
  id?: string;
  tags?: Record<string, string>;
  poll?: number | null;
  pollError?: unknown;
  process?: ModalProcessPort;
} = {}) {
  const requiredTags = {
    openma: "managed",
    oma_env: "ba5285161ba6eed0085fb137",
    oma_session: "3f3af1ecebbd1410ab417ec0",
  };
  let tags = input.tags ?? requiredTags;
  const value: ModalSandboxSdkPort = {
    sandboxId: input.id ?? "sandbox",
    filesystem: {
      makeDirectory: vi.fn(async () => undefined),
      readText: vi.fn(async () => "text"),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      writeText: vi.fn(async () => undefined),
      writeBytes: vi.fn(async () => undefined),
    },
    exec: vi.fn(async () => input.process ?? process()),
    poll: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "pollError")) throw input.pollError;
      return input.poll ?? null;
    }),
    getTags: vi.fn(async () => tags),
    setTags: vi.fn(async (next) => { tags = next; }),
    updateNetworkPolicy: vi.fn(async () => undefined),
    detach: vi.fn(),
    terminate: vi.fn(async () => undefined),
  };
  return value;
}

function sdk(value: ModalSandboxSdkPort, input: {
  found?: ModalSandboxSdkPort | null;
  winner?: ModalSandboxSdkPort | null;
  findError?: unknown;
  createError?: unknown;
  fromIdError?: unknown;
} = {}): ModalSdkPort {
  let findAttempt = 0;
  return {
    findByName: vi.fn(async () => {
      const attempt = findAttempt++;
      if (Object.prototype.hasOwnProperty.call(input, "findError") && attempt === 0) throw input.findError;
      if (Object.prototype.hasOwnProperty.call(input, "winner") && attempt > 0) return input.winner!;
      return Object.prototype.hasOwnProperty.call(input, "found") ? input.found! : null;
    }),
    create: vi.fn(async (request) => {
      if (Object.prototype.hasOwnProperty.call(input, "createError")) throw input.createError;
      await value.setTags(request.tags);
      return value;
    }),
    fromId: vi.fn(async () => {
      if (Object.prototype.hasOwnProperty.call(input, "fromIdError")) throw input.fromIdError;
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
      identity: "image",
      artifact: { type: "image" as const, reference: "image" },
    },
    signal,
  };
}

const providerOptions = {
  appName: "app",
  image: "image",
  workspaceVolumeName: "volume",
};

describe("Modal provider boundary contracts", () => {
  it("adapts every official Modal client operation and credential option", async () => {
    modalFixtureCalls.length = 0;
    const provider = createModalProvider({
      ...providerOptions,
      credentials: { tokenId: "id", tokenSecret: "secret", environment: "dev", endpoint: "https://modal" },
    });
    const instance = await provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    );
    expect(instance).toBeInstanceOf(ModalRuntime);
    expect(modalFixtureCalls).toEqual(expect.arrayContaining([
      { type: "credentials", input: { tokenId: "id", tokenSecret: "secret", environment: "dev", endpoint: "https://modal" } },
      { type: "image", input: "image" },
      { type: "volume", input: expect.objectContaining({ name: "volume", mount: { subPath: expect.stringMatching(/^sessions\//) } }) },
      { type: "create", input: expect.objectContaining({ name: expect.stringMatching(/^oma-/) }) },
    ]));
    await provider.resume(instance.runtimeHandle(), { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());

    const lookupFailure = new Error("lookup unavailable");
    failNextModalFixtureFind(lookupFailure);
    await expect(provider.create(
      { sessionId: "other-session", workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toBe(lookupFailure);
  });

  it("maps runtime status, provider absence, and renewal", async () => {
    await expect(new ModalRuntime(sandbox({ poll: null })).status()).resolves.toBe("running");
    await expect(new ModalRuntime(sandbox({ poll: 0 })).status()).resolves.toBe("stopped");
    await expect(new ModalRuntime(sandbox({ pollError: Object.assign(new Error(), { name: "NotFoundError" }) })).status())
      .resolves.toBe("stopped");
    await expect(new ModalRuntime(sandbox({ pollError: new Error("network") })).status()).resolves.toBe("unknown");
    await expect(new ModalRuntime(sandbox({ pollError: new Error("404") })).status()).resolves.toBe("stopped");
    const running = new ModalRuntime(sandbox());
    expect(running.runtimeHandle()).toEqual({ provider: "modal", runtimeId: "sandbox" });
    expect(running.runtimeCapabilities()).toEqual({ lease: false, suspend: ["filesystem"], checkpoint: [] });
    await expect(running.renewLease()).resolves.toBeUndefined();
    await expect(new ModalRuntime(sandbox({ poll: 1 })).renewLease()).rejects.toThrow("no longer running");
  });

  it("syncs and detaches retained workspaces and validates resume", async () => {
    const value = sandbox({ process: process({ stdout: ["sync"], stderr: [] }) });
    const instance = new ModalRuntime(value);
    await expect(instance.suspend({ kind: "memory" })).rejects.toThrow("mounted workspace Volume");
    const handle = await instance.suspend({ kind: "filesystem" });
    await expect(instance.status()).resolves.toBe("suspended");
    for (const invalid of [
      { ...handle, provider: "other" },
      { ...handle, scope: "portable" },
      { ...handle, sourceRuntimeId: "other" },
    ]) {
      await expect(instance.resume(invalid as never)).rejects.toThrow("only resume its own");
    }
    await expect(instance.resume(handle)).resolves.toBeUndefined();
    await expect(instance.status()).resolves.toBe("running");
    await expect(instance.checkpoint()).rejects.toThrow("not promoted to a portable");

    const failed = new ModalRuntime(sandbox({ process: process({ code: 1, stderr: ["sync failed"] }) }));
    await expect(failed.suspend({ kind: "filesystem" })).rejects.toThrow("Volume sync failed: sync failed");
  });

  it("executes commands, drains text chunks, and exposes file/network methods", async () => {
    const value = sandbox({ process: process({ stdout: ["a", "b "], stderr: ["warn "] }) });
    const instance = new ModalRuntime(value);
    await expect(instance.exec("echo")).resolves.toBe("ab \nwarn");
    const failedValue = sandbox({ process: process({ code: 7 }) });
    await expect(new ModalRuntime(failedValue).exec("false", 5)).resolves.toBe("\n[exit 7]");
    await expect(instance.readFile("/workspace/a")).resolves.toBe("text");
    await expect(instance.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(instance.writeFile("/workspace/a", "content")).resolves.toBe("/workspace/a");
    await expect(instance.writeFileBytes("/workspace/a", new Uint8Array([4]))).resolves.toBe("/workspace/a");
    await instance.updateNetworkPolicy({ outboundDomainAllowlist: ["example.com"], outboundCidrAllowlist: [] });
    expect(value.updateNetworkPolicy).toHaveBeenLastCalledWith({ outboundDomainAllowlist: ["example.com"], outboundCidrAllowlist: [] });
  });

  it("preserves native duplex streams, UTF-8 tails, abort, and termination", async () => {
    const writes: string[] = [];
    const abort = vi.fn();
    const value = sandbox({
      process: process({
        code: 4, stdout: ["out"], stderr: ["err"],
        sink: { write: (chunk) => { writes.push(chunk); }, abort },
      }),
    });
    const instance = new ModalRuntime(value);
    const child = await instance.spawnDuplexProcess({
      command: "worker", args: ["--poll"], cwd: "/workspace/project", env: { KEY: "value", OMIT: undefined },
    });
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("input"));
    await writer.close();
    await expect(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])).resolves.toEqual(["out", "err", { code: 4, signal: null }]);
    expect(value.exec).toHaveBeenCalledWith(["worker", "--poll"], expect.objectContaining({
      workdir: "/workspace/project", env: { KEY: "value" },
    }));
    expect(writes).toEqual(["input"]);
    await child.kill();
    await expect(instance.status()).resolves.toBe("stopped");

    const tailValue = sandbox({ process: process({ sink: { write: (chunk) => { writes.push(chunk); }, abort } }) });
    const tail = await new ModalRuntime(tailValue).spawnDuplexProcess({ command: "worker" });
    const tailWriter = tail.stdin.getWriter();
    await tailWriter.write(new Uint8Array([0xc3]));
    await tailWriter.close();
    expect(writes.at(-1)).toBe("�");

    const abortValue = sandbox({ process: process({ sink: { abort } }) });
    const aborted = await new ModalRuntime(abortValue).spawnDuplexProcess({ command: "worker" });
    await aborted.stdin.getWriter().abort("stop");
    expect(abort).toHaveBeenCalledWith("stop");
  });

  it("retries failed termination and makes successful destruction idempotent", async () => {
    const value = sandbox();
    value.terminate = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined);
    const instance = new ModalRuntime(value);
    await expect(instance.destroy()).rejects.toThrow("failed");
    await instance.destroy();
    await instance.destroy();
    expect(value.terminate).toHaveBeenCalledTimes(2);
    await expect(instance.status()).resolves.toBe("stopped");
  });

  it("requires acquisition, honors aborts, validates ownership, and fences network before readiness", async () => {
    const value = sandbox();
    const provider = createModalProvider({ ...providerOptions, client: sdk(value) });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined))
      .rejects.toThrow("requires acquisition context");
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal),
    )).rejects.toThrow();
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(ModalRuntime);
    expect(value.updateNetworkPolicy).toHaveBeenCalledWith({ outboundDomainAllowlist: [], outboundCidrAllowlist: [] });

    const invalidTags: Record<string, string>[] = [
      {},
      { openma: "wrong", oma_env: "ba5285161ba6eed0085fb137", oma_session: "3f3af1ecebbd1410ab417ec0" },
      { openma: "managed", oma_env: "wrong", oma_session: "3f3af1ecebbd1410ab417ec0" },
      { openma: "managed", oma_env: "ba5285161ba6eed0085fb137", oma_session: "wrong" },
    ];
    for (const tags of invalidTags) {
      await expect(createModalProvider({ ...providerOptions, client: sdk(sandbox({ tags }), { found: sandbox({ tags }) }) })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toThrow("ownership tags");
    }
  });

  it("applies network defaults and custom creation options, including conflict recovery", async () => {
    const value = sandbox();
    const client = sdk(value);
    const createOptions = vi.fn(() => ({
      cpu: 2,
      outboundDomainAllowlist: ["example.com"],
    }));
    await createModalProvider({ ...providerOptions, client, createOptions })
      .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ cpu: 2, blockNetwork: false }),
    }));
    expect(createOptions).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-/),
      ownershipTags: expect.any(Object),
      workspaceSubPath: expect.stringMatching(/^sessions\//),
    }));

    const cidr = sdk(value);
    await createModalProvider({
      ...providerOptions, client: cidr, createOptions: () => ({ outboundCidrAllowlist: ["10.0.0.0/8"] }),
    }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(cidr.create).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ blockNetwork: false }) }));

    for (const conflict of [
      Object.assign(new Error("exists"), { name: "AlreadyExistsError" }),
      Object.assign(new Error("conflict"), { name: "ConflictError" }),
      new Error("already exists"),
      new Error("conflict"),
    ]) {
      const winner = sandbox();
      const raced = sdk(winner, { createError: conflict, winner });
      await expect(createModalProvider({ ...providerOptions, client: raced })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .resolves.toBeInstanceOf(ModalRuntime);
      expect(raced.create).toHaveBeenCalledOnce();
    }
    const raceLost = new Error("already exists");
    const missingWinner = sdk(value, { createError: raceLost, found: null });
    await expect(createModalProvider({ ...providerOptions, client: missingWinner })
      .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .rejects.toBe(raceLost);
    const createFailure = new Error("create failed");
    await expect(createModalProvider({ ...providerOptions, client: sdk(value, { createError: createFailure }) })
      .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .rejects.toBe(createFailure);

    for (const createError of ["create failed", {}]) {
      await expect(createModalProvider({ ...providerOptions, client: sdk(value, { createError }) })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toBe(createError);
    }
    const namedConflict = Object.assign(new Error("opaque"), { name: "ConflictError" });
    const namedConflictClient = sdk(value, { createError: namedConflict, winner: value });
    await expect(createModalProvider({
      ...providerOptions,
      client: namedConflictClient,
    }).create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
      .resolves.toBeInstanceOf(ModalRuntime);
    expect(namedConflictClient.create).toHaveBeenCalledOnce();
  });

  it("fails readiness with stderr or stdout and catches aborts around network fencing", async () => {
    for (const processValue of [
      process({ code: 1, stderr: ["stderr"] }),
      process({ code: 1, stdout: ["stdout"] }),
    ]) {
      const value = sandbox({ process: processValue });
      await expect(createModalProvider({ ...providerOptions, client: sdk(value) })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition()))
        .rejects.toThrow(/stderr|stdout/);
    }
    for (const phase of ["network", "ready"] as const) {
      const controller = new AbortController();
      const value = sandbox();
      if (phase === "network") value.updateNetworkPolicy = vi.fn(async () => { controller.abort(); });
      else value.filesystem.makeDirectory = vi.fn(async () => { controller.abort(); });
      await expect(createModalProvider({ ...providerOptions, client: sdk(value) })
        .create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(controller.signal)))
        .rejects.toThrow();
    }
  });

  it("validates resume and recreates expired compute from the retained Volume", async () => {
    const value = sandbox();
    const provider = createModalProvider({ ...providerOptions, client: sdk(value) });
    await expect(provider.resume({ provider: "other", runtimeId: "sandbox" }, {} as never, {}, acquisition()))
      .rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume({ provider: "modal", runtimeId: "" }, {} as never, {}, acquisition()))
      .rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume(
      { provider: "modal", runtimeId: "sandbox" }, {} as never, {}, undefined,
    )).rejects.toThrow("requires acquisition context");
    await expect(provider.resume(
      { provider: "modal", runtimeId: "sandbox" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(ModalRuntime);

    for (const notFound of [
      Object.assign(new Error(), { name: "NotFoundError" }),
      new Error("not found"),
      new Error("not_found"),
      new Error("not-found"),
      new Error("404"),
    ]) {
      const replacement = sandbox();
      const expired = createModalProvider({ ...providerOptions, client: sdk(replacement, { fromIdError: notFound }) });
      await expect(expired.resume(
        { provider: "modal", runtimeId: "expired" },
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).resolves.toBeInstanceOf(ModalRuntime);
    }
    const failure = new Error("network");
    await expect(createModalProvider({ ...providerOptions, client: sdk(value, { fromIdError: failure }) }).resume(
      { provider: "modal", runtimeId: "sandbox" },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toBe(failure);
    for (const lookupError of ["network", {}]) {
      await expect(createModalProvider({ ...providerOptions, client: sdk(value, { fromIdError: lookupError }) }).resume(
        { provider: "modal", runtimeId: "sandbox" },
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toBe(lookupError);
    }
    await expect(provider.restore({} as never, {} as never, {}, acquisition())).rejects
      .toThrow("does not advertise portable workspace restore");
  });

  it("projects outputs, credentials, session inputs, readiness, placement, and reap", async () => {
    const value = sandbox();
    const egress = {
      capabilities: { enforcement: "enforced" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
      attach: async () => undefined,
      revoke: async () => undefined,
    };
    const sessionInputs = { materialize: vi.fn(), synchronize: vi.fn() };
    const driver = createModalManagedRuntimeDriver({
      ...providerOptions, client: sdk(value), leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(), credentialEgress: egress, sessionInputs,
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

    const plain = createModalManagedRuntimeDriver({ ...providerOptions, client: sdk(value), leaseTtlMs: 100, outputStore: null });
    expect(plain.descriptor().capabilities.outputs.strategies).toEqual([]);
    const plainResources = await plain.create({ placement: "in_process" } as never);
    expect(plainResources).not.toHaveProperty("credentialEgress");
    expect(plainResources).not.toHaveProperty("sessionInputs");

    const defaultOutput = createModalManagedRuntime({
      ...providerOptions, client: sdk(value), leaseTtlMs: 100, outputStore: new InMemoryBlobStore(),
    });
    await expect(defaultOutput.outputs.capabilities(scope)).resolves.toMatchObject({ strategies: [expect.any(Object)] });

    const { sandbox: port } = createModalManagedRuntime({ ...providerOptions, client: sdk(value), leaseTtlMs: 100 });
    const lease = {
      leaseId: "lease", runtimeId: "sandbox", provider: "modal", expiresAt: "2026-09-01T00:00:00.000Z",
      handle: { provider: "modal", runtimeId: "sandbox" }, sandbox: {} as never,
    };
    await port.reap({ scope, lease, reason: "orphan" } as never);
    expect(value.terminate).toHaveBeenCalled();
    for (const error of [Object.assign(new Error(), { name: "NotFoundError" }), new Error("not found")]) {
      const absent = createModalManagedRuntime({ ...providerOptions, client: sdk(value, { fromIdError: error }), leaseTtlMs: 100 });
      await expect(absent.sandbox.reap({ scope, lease, reason: "orphan" } as never)).resolves.toBeUndefined();
    }
    const reapFailure = new Error("network");
    const broken = createModalManagedRuntime({ ...providerOptions, client: sdk(value, { fromIdError: reapFailure }), leaseTtlMs: 100 });
    await expect(broken.sandbox.reap({ scope, lease, reason: "orphan" } as never)).rejects.toBe(reapFailure);
  });
});
