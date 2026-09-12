import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  BlaxelRuntime,
  createBlaxelManagedRuntime,
  createBlaxelManagedRuntimeDriver,
  createBlaxelProvider,
  type BlaxelProcessRequest,
  type BlaxelProcessResponse,
  type BlaxelSandboxSdkPort,
  type BlaxelSdkPort,
} from "../src/blaxel";

const scope = {
  workspaceId: "workspace",
  environmentId: "environment",
  sessionId: "session",
  workId: "work",
};
const fence = {
  ...scope,
  ownerId: "owner",
  generation: 1,
  token: "fence",
  expiresAt: "2026-09-01T00:00:00.000Z",
};
const expectedName = `oma-${createHash("sha256").update(scope.sessionId).digest("hex").slice(0, 32)}`;
const labels = {
  "openma.environment_id": scope.environmentId,
  "openma.session_id": scope.sessionId,
  "openma.mode": "managed",
};

function processResult(input: Partial<BlaxelProcessResponse> = {}): BlaxelProcessResponse {
  return {
    name: "process",
    pid: "42",
    status: "completed",
    exitCode: 0,
    stdout: "out",
    stderr: "",
    ...input,
  };
}

function sandbox(input: {
  name?: string;
  labels?: Record<string, string>;
  status?: string;
  probe?: Partial<BlaxelProcessResponse>;
} = {}) {
  const value: BlaxelSandboxSdkPort = {
    metadata: {
      name: input.name ?? expectedName,
      labels: Object.prototype.hasOwnProperty.call(input, "labels") ? input.labels : labels,
    },
    status: input.status ?? "DEPLOYED",
    fs: {
      mkdir: vi.fn(async () => ({})),
      write: vi.fn(async () => ({})),
      writeBinary: vi.fn(async () => ({})),
      read: vi.fn(async () => "text"),
      readBinary: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
    },
    process: {
      exec: vi.fn(async (request: BlaxelProcessRequest) => {
        if (request.name === undefined) return processResult(input.probe);
        request.onStdout?.("stdout");
        request.onStderr?.("stderr");
        return processResult({ name: request.name, status: "running", stdout: "", stderr: "" });
      }),
      wait: vi.fn(async (identifier: string) => processResult({ name: identifier, exitCode: 4 })),
      writeStdin: vi.fn(async () => undefined),
      closeStdin: vi.fn(async () => undefined),
      kill: vi.fn(async () => ({})),
    },
    wait: vi.fn(async () => value),
    archive: vi.fn(async () => value),
    unarchive: vi.fn(async () => value),
    delete: vi.fn(async () => ({})),
  };
  return value;
}

function client(value: BlaxelSandboxSdkPort): BlaxelSdkPort {
  return {
    createIfNotExists: vi.fn(async (input) => {
      value.metadata.name = input.name;
      value.metadata.labels = input.labels;
      return value;
    }),
    get: vi.fn(async () => value),
    delete: vi.fn(async () => ({})),
    updateNetwork: vi.fn(async () => value),
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
    environment: {
      type: "base" as const,
      identity: "image",
      artifact: { type: "image" as const, reference: "image" },
    },
    signal,
  };
}

function directRuntime(value = sandbox(), sdk = client(value)) {
  return { value, sdk, runtime: new BlaxelRuntime({ sdk, sandbox: value, name: expectedName }) };
}

async function consume(process: Awaited<ReturnType<BlaxelRuntime["spawnDuplexProcess"]>>) {
  return Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
}

describe("Blaxel provider boundary contracts", () => {
  it("loads and delegates to the optional SDK lazily when no client is injected", async () => {
    const provider = createBlaxelProvider({ image: "image" });
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
      acquisition(),
    )).resolves.toBeInstanceOf(BlaxelRuntime);
  });

  it("maps every runtime status and renewal boundary", async () => {
    const { value, runtime } = directRuntime();
    expect(runtime.runtimeHandle()).toEqual({ provider: "blaxel", runtimeId: expectedName });
    expect(runtime.runtimeCapabilities()).toEqual({ lease: false, suspend: ["filesystem"], checkpoint: [] });
    for (const [status, expected] of [
      ["ARCHIVED", "suspended"],
      ["TERMINATED", "stopped"],
      ["FAILED", "stopped"],
      ["DELETING", "stopped"],
      ["DEPLOYED", "running"],
      ["DEACTIVATED", "running"],
      ["starting", "unknown"],
      [undefined, "unknown"],
    ] as const) {
      Object.defineProperty(value, "status", { value: status, writable: true, configurable: true });
      await expect(runtime.status()).resolves.toBe(expected);
    }
    Object.defineProperty(value, "status", { value: "FAILED", writable: true, configurable: true });
    await expect(runtime.renewLease()).rejects.toThrow("no longer available");
    Object.defineProperty(value, "status", { value: "ARCHIVED", writable: true, configurable: true });
    await expect(runtime.renewLease()).resolves.toBeUndefined();
  });

  it("implements retained suspension and rejects incompatible resume handles", async () => {
    const { value, runtime } = directRuntime();
    await expect(runtime.suspend({ kind: "memory" })).rejects.toThrow("filesystem suspension only");
    await expect(runtime.suspend({ kind: "filesystem" })).resolves.toMatchObject({
      provider: "blaxel",
      sourceRuntimeId: expectedName,
      scope: "runtime",
    });
    expect(value.archive).toHaveBeenCalledWith({ wait: true, maxWait: 1_800_000, interval: 2_000 });
    for (const invalid of [
      { provider: "other", sourceRuntimeId: expectedName, scope: "runtime" },
      { provider: "blaxel", sourceRuntimeId: expectedName, scope: "portable" },
      { provider: "blaxel", sourceRuntimeId: "other", scope: "runtime" },
    ]) {
      await expect(runtime.resume(invalid as never)).rejects.toThrow("only resume its own");
    }
    await expect(runtime.resume({
      provider: "blaxel",
      checkpointId: "id",
      sourceRuntimeId: expectedName,
      kind: "filesystem",
      scope: "runtime",
    })).resolves.toBeUndefined();
    expect(value.unarchive).toHaveBeenCalledOnce();
    await expect(runtime.checkpoint()).rejects
      .toThrow("not advertised as portable");
  });

  it("preserves command output, timeout, files, bytes, and network settings", async () => {
    const { value, sdk, runtime } = directRuntime();
    await expect(runtime.exec("command")).resolves.toBe("out");
    value.process.exec = vi.fn(async () => processResult({
      exitCode: 7,
      status: "failed",
      stdout: "out ",
      stderr: "problem ",
    }));
    await expect(runtime.exec("bad", 1)).resolves.toBe("out \nproblem\n[exit 7]");
    expect(value.process.exec).toHaveBeenLastCalledWith(expect.objectContaining({ timeout: 1 }));
    value.process.exec = vi.fn(async () => processResult({ exitCode: 0, status: "killed", stdout: "" }));
    await expect(runtime.exec("odd")).resolves.toBe("\n[exit 0]");
    await expect(runtime.readFile("/workspace/a")).resolves.toBe("text");
    await expect(runtime.readFileBytes("/workspace/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(runtime.writeFile("/workspace/a", "content")).resolves.toBe("/workspace/a");
    await expect(runtime.writeFileBytes("/workspace/a", new Uint8Array([4]))).resolves.toBe("/workspace/a");
    await runtime.updateNetwork({ allowedDomains: ["example.com"] });
    expect(sdk.updateNetwork).toHaveBeenCalledWith(expectedName, {
      network: { allowedDomains: ["example.com"] },
    });
  });

  it("supports duplex stdio, deterministic names, quoting, close, abort, and kill", async () => {
    const { value, runtime } = directRuntime();
    const process = await runtime.spawnDuplexProcess({
      command: "it's",
      args: ["arg"],
      cwd: "/workspace/project",
      env: { ANTHROPIC_WORK_ID: "work", OMIT: undefined },
    });
    const writer = process.stdin.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();
    await expect(consume(process)).resolves.toEqual(["stdout", "stderr", { code: 4, signal: null }]);
    expect(value.process.exec).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-run-/),
      command: "exec 'it'\\''s' 'arg'",
      env: { ANTHROPIC_WORK_ID: "work" },
      workingDir: "/workspace/project",
    }));
    await process.kill();

    const openma = await runtime.spawnDuplexProcess({
      command: "worker",
      env: { OPENMA_WORK_ID: "openma" },
    });
    await consume(openma);
    const random = await runtime.spawnDuplexProcess({ command: "worker" });
    const randomWriter = random.stdin.getWriter();
    await randomWriter.abort();
    await consume(random);
    expect(value.process.kill).toHaveBeenCalled();
  });

  it("falls back to pid and propagates process start and wait failures", async () => {
    const startFailure = directRuntime();
    startFailure.value.process.exec = vi.fn(async () => { throw new Error("start failed"); });
    await expect(startFailure.runtime.spawnDuplexProcess({ command: "worker" })).rejects
      .toThrow("start failed");

    const waitFailure = directRuntime();
    const close = vi.fn();
    waitFailure.value.process.exec = vi.fn(async () => processResult({ name: "", pid: "pid-only", close }));
    waitFailure.value.process.wait = vi.fn(async () => { throw new Error("wait failed"); });
    const process = await waitFailure.runtime.spawnDuplexProcess({ command: "worker" });
    await expect(process.exited).rejects.toThrow("wait failed");
    expect(waitFailure.value.process.wait).toHaveBeenCalledWith("pid-only", expect.any(Object));
    expect(close).toHaveBeenCalledOnce();
  });

  it("destroys once and reports stopped afterwards", async () => {
    const { sdk, runtime } = directRuntime();
    await runtime.destroy();
    await runtime.destroy();
    expect(sdk.delete).toHaveBeenCalledOnce();
    await expect(runtime.status()).resolves.toBe("stopped");
  });

  it("requires acquisition context, honors aborts, and applies all allocation options", async () => {
    const value = sandbox();
    const sdk = client(value);
    const provider = createBlaxelProvider({
      client: sdk,
      image: "image",
      region: "us-west",
      ttl: "1h",
      lifecycle: { terminatedRetention: "1d" },
    });
    await expect(provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, undefined))
      .rejects.toThrow("requires acquisition context");
    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(aborted.signal),
    )).rejects.toThrow();
    await provider.create({ sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition());
    expect(sdk.createIfNotExists).toHaveBeenCalledWith(expect.objectContaining({
      memory: 4_096,
      region: "us-west",
      ttl: "1h",
      lifecycle: { terminatedRetention: "1d" },
    }));

    const duringAllocation = new AbortController();
    const allocationProvider = createBlaxelProvider({
      client: sdk,
      image: "image",
      allocationOptions: () => {
        duringAllocation.abort();
        return {};
      },
    });
    await expect(allocationProvider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(duringAllocation.signal),
    )).rejects.toThrow();

    const afterReady = new AbortController();
    value.process.exec = vi.fn(async () => {
      afterReady.abort();
      return processResult();
    });
    await expect(provider.create(
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(afterReady.signal),
    )).rejects.toThrow();
  });

  it("fails readiness with stderr or stdout and validates each ownership label", async () => {
    for (const probe of [
      { exitCode: 1, status: "failed", stderr: "probe stderr", stdout: "" },
      { exitCode: 1, status: "failed", stderr: "", stdout: "probe stdout" },
    ]) {
      const provider = createBlaxelProvider({ client: client(sandbox({ probe })), image: "image" });
      await expect(provider.create(
        { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
      )).rejects.toThrow(probe.stderr || probe.stdout);
    }

    const variants = [
      { name: "wrong", labels },
      { name: expectedName, labels: { ...labels, "openma.environment_id": "wrong" } },
      { name: expectedName, labels: { ...labels, "openma.session_id": "wrong" } },
      { name: expectedName, labels: { ...labels, "openma.mode": "wrong" } },
      { name: expectedName, labels: undefined },
    ];
    for (const variant of variants) {
      const value = sandbox(variant);
      const provider = createBlaxelProvider({ client: client(value), image: "image" });
      await expect(provider.resume(
        { provider: "blaxel", runtimeId: expectedName },
        { sessionId: scope.sessionId, workdir: "/workspace" },
        {},
        acquisition(),
      )).rejects.toThrow("ownership labels");
    }
  });

  it("validates resume context and wakes archived sandboxes", async () => {
    const value = sandbox({ status: "ARCHIVED" });
    const provider = createBlaxelProvider({ client: client(value), image: "image" });
    await expect(provider.resume(
      { provider: "other", runtimeId: expectedName }, {} as never, {}, acquisition(),
    )).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: "" }, {} as never, {}, acquisition(),
    )).rejects.toThrow("incompatible runtime handle");
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: expectedName }, {} as never, {}, undefined,
    )).rejects.toThrow("requires acquisition context");
    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: expectedName }, {} as never, {}, acquisition(aborted.signal),
    )).rejects.toThrow();
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: expectedName },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(BlaxelRuntime);
    expect(value.unarchive).toHaveBeenCalledOnce();
    Object.defineProperty(value, "status", { value: undefined, writable: true, configurable: true });
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: expectedName },
      { sessionId: scope.sessionId, workdir: "/workspace" }, {}, acquisition(),
    )).resolves.toBeInstanceOf(BlaxelRuntime);
    expect(value.unarchive).toHaveBeenCalledOnce();
    await expect(provider.restore({} as never, {} as never, {}, acquisition())).rejects
      .toThrow("does not advertise portable workspace restore");
  });

  it("projects outputs, readiness, credentials, session inputs, and driver placement", async () => {
    const value = sandbox();
    const egress = {
      capabilities: {
        enforcement: "enforced" as const,
        credentialMode: "live" as const,
        interceptedProtocols: ["https" as const],
      },
      attach: vi.fn(),
      revoke: vi.fn(),
    };
    const sessionInputs = { materialize: vi.fn(), synchronize: vi.fn() };
    const driver = createBlaxelManagedRuntimeDriver({
      client: client(value),
      image: "image",
      leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(),
      outputKeyPrefix: "outputs",
      credentialEgress: egress as never,
      sessionInputs,
      readiness: { timeoutMs: 500 },
    });
    expect(driver.descriptor()).toMatchObject({
      capabilities: { outputs: { strategies: [{ strategy: "final_collect", durability: "durable" }] } },
      credentialEgress: egress.capabilities,
    });
    await expect(driver.create({ placement: "driver_service" } as never)).rejects
      .toThrow("does not support driver_service placement");
    const resources = await driver.create({ placement: "in_process" } as never);
    expect(resources).toMatchObject({ sessionInputs });
    expect(resources.credentialEgress).toBeDefined();
    await expect(resources.credentialEgress?.capabilities(scope)).resolves.toEqual(egress.capabilities);

    const noOutput = createBlaxelManagedRuntime({
      client: client(value), image: "image", leaseTtlMs: 100, outputStore: undefined,
    });
    expect(noOutput.outputs).toBeDefined();

    const defaultOutput = createBlaxelManagedRuntime({
      client: client(value), image: "image", leaseTtlMs: 100,
      outputStore: new InMemoryBlobStore(),
    });
    await expect(defaultOutput.outputs.capabilities(scope)).resolves.toMatchObject({
      strategies: [{ strategy: "final_collect" }],
    });

    const plainDriver = createBlaxelManagedRuntimeDriver({
      client: client(value), image: "image", leaseTtlMs: 100,
    });
    const plainResources = await plainDriver.create({ placement: "in_process" } as never);
    expect(plainResources).not.toHaveProperty("credentialEgress");
    expect(plainResources).not.toHaveProperty("sessionInputs");
  });

  it("reaps only owned runtimes and recognizes every provider not-found shape", async () => {
    const lease = {
      leaseId: "lease",
      runtimeId: expectedName,
      provider: "blaxel",
      expiresAt: "2026-09-01T00:00:00.000Z",
      handle: { provider: "blaxel", runtimeId: expectedName },
      sandbox: {} as never,
    };
    for (const error of [
      { status: 404 },
      { statusCode: 404 },
      new Error("not found"),
      new Error("not-found"),
    ]) {
      const sdk = client(sandbox());
      sdk.get = vi.fn(async () => { throw error; });
      const runtime = createBlaxelManagedRuntime({ client: sdk, image: "image", leaseTtlMs: 100 });
      await expect(runtime.sandbox.reap({ scope, lease, reason: "orphan" } as never)).resolves
        .toBeUndefined();
    }
    for (const error of ["failure", null, { status: 500 }, { statusCode: 500 }, new Error("boom")]) {
      const sdk = client(sandbox());
      sdk.get = vi.fn(async () => { throw error; });
      const runtime = createBlaxelManagedRuntime({ client: sdk, image: "image", leaseTtlMs: 100 });
      await expect(runtime.sandbox.reap({ scope, lease, reason: "orphan" } as never)).rejects.toBe(error);
    }
  });
});
