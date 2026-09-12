import { describe, expect, it, vi } from "vitest";

import {
  createBoxLiteManagedRuntime,
  createBoxLiteManagedRuntimeDriver,
  createBoxLiteProvider,
  type BoxLiteBoxSdkPort,
  type BoxLiteClientPort,
  type BoxLiteExecutionPort,
} from "../src/boxlite";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "owner_1",
  generation: 1,
  token: "secret",
  expiresAt: "2026-09-07T12:00:00.000Z",
};

function source(...chunks: string[]) {
  let index = 0;
  return { async next() { return chunks[index++] ?? null; } };
}

function execution(exitCode = 0, output = "worker output"): BoxLiteExecutionPort {
  return {
    id: vi.fn(async () => "exec_1"),
    stdin: vi.fn(async () => ({
      write: vi.fn(async () => {}),
      writeString: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    stdout: vi.fn(async () => source(output)),
    stderr: vi.fn(async () => source()),
    wait: vi.fn(async () => ({ exitCode })),
    kill: vi.fn(async () => {}),
    signal: vi.fn(async () => {}),
  };
}

class FakeBox implements BoxLiteBoxSdkPort {
  readonly id = "box_1";
  running = false;
  readonly exec = vi.fn(async (_command: string, args?: string[]) =>
    execution(
      0,
      args?.some((argument) => argument.includes("__OPENMA_RUNTIME_READY__")) === true
        ? "__OPENMA_RUNTIME_READY__"
        : "worker output",
    ));
  readonly copyIn = vi.fn(async () => {});
  readonly copyOut = vi.fn(async () => {});
  readonly start = vi.fn(async () => { this.running = true; });
  readonly stop = vi.fn(async () => { this.running = false; });

  constructor(readonly name: string | null) {}

  info() {
    return { id: this.id, name: this.name ?? undefined, state: {
      status: this.running ? "Running" : "Stopped",
      running: this.running,
    } };
  }
}

function client(box: FakeBox) {
  return {
    getOrCreate: vi.fn(async () => ({ created: true, box })),
    get: vi.fn(async (id: string) => id === box.id ? box : null),
    remove: vi.fn(async () => {}),
  } satisfies BoxLiteClientPort;
}

describe("BoxLite managed runtime provider", () => {
  it("maps the official get-or-create, streaming execution, stop/start, and reap lifecycle", async () => {
    let expectedName = "";
    const box = new FakeBox(null);
    const sdk = client(box);
    const allocationOptions = vi.fn(async (input: { name: string }) => {
      expectedName = input.name;
      Object.defineProperty(box, "name", { value: input.name });
      return { network: { mode: "disabled" as const } };
    });
    const runtime = createBoxLiteManagedRuntime({
      providerId: "litebox",
      client: sdk,
      image: "node:22-slim",
      runtimeEnvironment: {
        type: "custom",
        identity: "custom-boxlite-image",
        artifact: { type: "image", reference: "registry.example/openma-custom:sha256-test" },
        prepare: async () => {},
      },
      leaseTtlMs: 90_000,
      outputStore: null,
      allocationOptions,
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "materialize-1",
      signal,
    });
    const lease = await runtime.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      },
      workspace,
      outputs: null,
      signal,
    });

    expect(expectedName).toMatch(/^oma-[a-f0-9]{32}$/);
    expect(allocationOptions).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      fence,
      workspace,
    }));
    expect(sdk.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      image: "registry.example/openma-custom:sha256-test",
      autoRemove: false,
      detach: true,
      workingDir: "/workspace",
      network: { mode: "disabled" },
    }), expectedName);
    await expect(runtime.harness.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      signal,
    })).resolves.toEqual({ type: "completed" });
    expect(box.exec).toHaveBeenCalledWith(
      "worker",
      ["--poll"],
      [],
      false,
      null,
      0,
      "/workspace",
    );

    const suspended = await runtime.sandbox.suspend({ scope, fence, lease, signal });
    const candidate = await runtime.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: workspace,
      sandbox: suspended,
      idempotencyKey: "checkpoint-1",
      signal,
    });
    const nextFence = { ...fence, generation: 2, token: "next" };
    const nextWorkspace = await runtime.workspace.materialize({
      scope,
      fence: nextFence,
      strategy: "retained_runtime",
      activeCheckpoint: candidate,
      idempotencyKey: "materialize-2",
      signal,
    });
    await runtime.sandbox.acquire({
      scope,
      fence: nextFence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: nextWorkspace,
      outputs: null,
      signal,
    });
    expect(sdk.get).toHaveBeenCalledWith("box_1");
    expect(box.stop).toHaveBeenCalledOnce();
    expect(box.start).toHaveBeenCalledTimes(2);

    await runtime.sandbox.reap({ scope, lease, reason: "completed" });
    expect(sdk.remove).toHaveBeenCalledWith("box_1", true);
  });

  it("refuses to attach a runtime whose stable ownership name does not match", async () => {
    const foreign = new FakeBox("somebody-elses-box");
    const sdk = client(foreign);
    const provider = createBoxLiteProvider({
      providerId: "boxrun",
      client: sdk,
      image: "node:22-slim",
    });

    await expect(provider.resume(
      { provider: "boxrun", runtimeId: foreign.id },
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
      {
        scope,
        fence,
        plan: {
          workspaceStrategy: "retained_runtime",
          outputStrategy: null,
          runtimeCheckpoint: null,
          driver: { type: "ama_worker", process: { command: "worker" } },
        },
        workspace: { bindingId: "binding", mountPath: "/workspace" },
        outputs: null,
        credentialEgress: null,
        environment: {
          type: "base",
          identity: "node:22-slim",
          artifact: { type: "image", reference: "node:22-slim" },
        },
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("ownership name");
  });

  it("advertises the same managed lifecycle for embedded and REST BoxLite clients", () => {
    const embedded = createBoxLiteManagedRuntimeDriver({
      providerId: "litebox",
      client: client(new FakeBox("unused")),
      image: "node:22-slim",
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    const remote = createBoxLiteManagedRuntimeDriver({
      providerId: "boxrun",
      client: client(new FakeBox("unused")),
      image: "node:22-slim",
      leaseTtlMs: 90_000,
      outputStore: null,
    });

    for (const driver of [embedded, remote]) {
      expect(driver.descriptor()).toMatchObject({
        placements: ["in_process"],
        capabilities: {
          sandbox: { suspendResume: "supported", hardTerminate: "supported" },
          workspace: { strategies: ["retained_runtime"] },
          outputs: { strategies: [] },
          harness: { drivers: ["ama_worker", "openma_supervised"] },
        },
      });
    }
    expect(embedded.descriptor().provider).toBe("litebox");
    expect(remote.descriptor().provider).toBe("boxrun");
  });
});
