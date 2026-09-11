import { describe, expect, it, vi } from "vitest";

import {
  createBlaxelManagedRuntime,
  createBlaxelManagedRuntimeDriver,
  createBlaxelProvider,
  type BlaxelSandboxSdkPort,
  type BlaxelSdkPort,
} from "../src/blaxel";

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

class FakeBlaxelSandbox implements BlaxelSandboxSdkPort {
  status: string | undefined = "DEPLOYED";
  readonly fs = {
    mkdir: vi.fn(async () => ({})),
    write: vi.fn(async () => ({})),
    writeBinary: vi.fn(async () => ({})),
    read: vi.fn(async () => "content"),
    readBinary: vi.fn(async () => new Blob(["content"])),
  };
  readonly process = {
    exec: vi.fn(async (request: {
      name?: string;
      command: string;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }) => {
      request.onStdout?.("worker output");
      return {
        name: request.name ?? "probe",
        pid: "12",
        status: request.name === undefined ? "completed" : "running",
        exitCode: 0,
        stdout: "",
        stderr: "",
        logs: "",
        command: request.command,
        startedAt: "now",
        completedAt: "now",
        workingDir: "/workspace",
        close: vi.fn(),
      };
    }),
    wait: vi.fn(async (identifier: string) => ({
      name: identifier,
      pid: "12",
      status: "completed" as const,
      exitCode: 0,
      stdout: "",
      stderr: "",
      logs: "",
      command: "worker",
      startedAt: "now",
      completedAt: "now",
      workingDir: "/workspace",
    })),
    writeStdin: vi.fn(async () => {}),
    closeStdin: vi.fn(async () => {}),
    kill: vi.fn(async () => ({})),
  };
  readonly archive = vi.fn(async () => {
    this.status = "ARCHIVED";
    return this;
  });
  readonly unarchive = vi.fn(async () => {
    this.status = "DEPLOYED";
    return this;
  });
  readonly delete = vi.fn(async () => ({}));
  readonly wait = vi.fn(async () => this);

  constructor(
    readonly metadata: {
      name: string;
      labels?: Record<string, string>;
      externalId?: string;
    },
  ) {}
}

function sdk(sandbox: FakeBlaxelSandbox): BlaxelSdkPort {
  return {
    createIfNotExists: vi.fn(async () => sandbox),
    get: vi.fn(async () => sandbox),
    delete: vi.fn(async () => ({})),
    updateNetwork: vi.fn(async () => sandbox),
  };
}

describe("Blaxel managed runtime provider", () => {
  it("maps stable ownership, ready-before-publish, stdio, archive resume, and reap", async () => {
    const expectedLabels = {
      "openma.environment_id": scope.environmentId,
      "openma.session_id": scope.sessionId,
      "openma.mode": "managed",
    };
    const sandbox = new FakeBlaxelSandbox({
      name: "placeholder",
      labels: expectedLabels,
    });
    const client = sdk(sandbox);
    const allocationOptions = vi.fn(async (input: { name: string }) => {
      sandbox.metadata.name = input.name;
      return {
        memory: 2048,
        network: { firewall: { rulesets: ["proxy"] } },
        volumes: [{ name: "session-volume", mountPath: "/workspace" }],
      };
    });
    const runtime = createBlaxelManagedRuntime({
      client,
      image: "sandbox/cma-worker:latest",
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
    let lease = await runtime.sandbox.acquire({
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

    expect(allocationOptions).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      fence,
      workspace,
    }));
    expect(client.createIfNotExists).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      externalId: expect.stringMatching(/^openma:/),
      image: "sandbox/cma-worker:latest",
      memory: 2048,
      labels: expectedLabels,
      network: { firewall: { rulesets: ["proxy"] } },
      volumes: [{ name: "session-volume", mountPath: "/workspace" }],
    }));
    expect(sandbox.fs.mkdir).toHaveBeenCalledWith("/workspace");
    expect(sandbox.process.exec).toHaveBeenCalledWith(expect.objectContaining({
      command: "true",
      waitForCompletion: true,
      workingDir: "/",
    }));

    await expect(runtime.harness.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      signal,
    })).resolves.toEqual({ type: "completed" });
    expect(sandbox.process.exec).toHaveBeenCalledWith(expect.objectContaining({
      command: "exec 'worker' '--poll'",
      stdin: true,
      keepAlive: true,
      waitForCompletion: false,
    }));

    lease = await runtime.sandbox.suspend({ scope, fence, lease, signal });
    const candidate = await runtime.workspace.checkpoint({
      scope,
      fence,
      strategy: "retained_runtime",
      binding: workspace,
      sandbox: lease,
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
    lease = await runtime.sandbox.acquire({
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
    expect(sandbox.archive).toHaveBeenCalledOnce();
    expect(sandbox.unarchive).toHaveBeenCalledOnce();

    await runtime.sandbox.reap({ scope, lease, reason: "completed" });
    expect(client.delete).toHaveBeenCalledWith(sandbox.metadata.name);
  });

  it("refuses a sandbox whose ownership labels do not match", async () => {
    const sandbox = new FakeBlaxelSandbox({
      name: "oma-owned-name",
      labels: { "openma.session_id": "somebody_else" },
    });
    const provider = createBlaxelProvider({
      client: sdk(sandbox),
      image: "sandbox/cma-worker:latest",
    });
    await expect(provider.resume(
      { provider: "blaxel", runtimeId: sandbox.metadata.name },
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
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("ownership labels");
  });

  it("advertises only the capabilities actually implemented", () => {
    const driver = createBlaxelManagedRuntimeDriver({
      client: sdk(new FakeBlaxelSandbox({ name: "unused" })),
      image: "sandbox/cma-worker:latest",
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "blaxel",
      placements: ["in_process"],
      capabilities: {
        sandbox: { suspendResume: "supported", hardTerminate: "supported" },
        workspace: { strategies: ["retained_runtime"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
    });
  });
});
