import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { describe, expect, it } from "vitest";

import * as daytonaRuntime from "../src/daytona";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

const fence = {
  ...scope,
  ownerId: "environment-worker_1",
  generation: 1,
  token: "fence-token",
  expiresAt: "2026-09-08T00:00:00.000Z",
};

class FakeDaytonaSandbox {
  readonly id: string;
  readonly name: string;
  state = "started";
  labels: Record<string, string>;
  refreshes = 0;
  readonly commands: string[] = [];
  readonly deletedSessions: string[] = [];
  readonly files = new Map<string, Uint8Array>();

  readonly fs = {
    uploadFile: async (bytes: Uint8Array, path: string) => {
      this.files.set(path, new Uint8Array(bytes));
    },
    downloadFile: async (path: string) => {
      const bytes = this.files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes;
    },
    createFolder: async () => undefined,
  };

  readonly process = {
    executeCommand: async (command: string) => {
      this.commands.push(command);
      return { exitCode: 0, result: "", artifacts: { stdout: "", stderr: "" } };
    },
    createSession: async () => undefined,
    executeSessionCommand: async (_sessionId: string, input: { command: string }) => {
      this.commands.push(input.command);
      return { cmdId: "command_1" };
    },
    getSessionCommandLogs: async (
      _sessionId: string,
      _commandId: string,
      onStdout: (chunk: string) => void,
      _onStderr: (chunk: string) => void,
    ) => {
      onStdout("worker complete\n");
    },
    getSessionCommand: async () => ({
      id: "command_1",
      command: "worker",
      exitCode: 0,
    }),
    sendSessionCommandInput: async () => undefined,
    deleteSession: async (sessionId: string) => {
      this.deletedSessions.push(sessionId);
    },
  };

  constructor(id: string, name: string, labels: Record<string, string>) {
    this.id = id;
    this.name = name;
    this.labels = labels;
  }

  async refreshData() {}
  async refreshActivity() { this.refreshes += 1; }
  async start() { this.state = "started"; }
  async stop() { this.state = "stopped"; }
  async delete() { this.state = "destroyed"; }
  async setLabels(labels: Record<string, string>) { this.labels = { ...labels }; }
  async createSnapshot() {}
}

class FakeDaytonaClient {
  readonly sandboxes = new Map<string, FakeDaytonaSandbox>();
  nextId = 0;

  async get(idOrName: string) {
    const sandbox = [...this.sandboxes.values()].find((candidate) =>
      candidate.id === idOrName || candidate.name === idOrName
    );
    if (sandbox === undefined) {
      const error = new Error("not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    return sandbox;
  }

  async create(input: { name?: string; labels?: Record<string, string> }) {
    const sandbox = new FakeDaytonaSandbox(
      `sandbox_${++this.nextId}`,
      input.name ?? `sandbox_${this.nextId}`,
      { ...input.labels },
    );
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }
}

async function acquireRetainedRuntime(
  driver: { create(input: unknown): Promise<any> },
) {
  const resources = await driver.create({
    environmentId: scope.environmentId,
    placement: "in_process",
    providerConfig: {},
  });
  const signal = new AbortController().signal;
  const workspace = await resources.workspace.materialize({
    scope,
    fence,
    strategy: "retained_runtime",
    activeCheckpoint: null,
    idempotencyKey: "workspace",
    signal,
  });
  const lease = await resources.sandbox.acquire({
    scope,
    fence,
    plan: {
      workspaceStrategy: "retained_runtime",
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: {
        type: "ama_worker",
        process: { command: "python3", args: ["/runner.py"] },
      },
    },
    workspace,
    outputs: null,
    signal,
  });
  return { resources, lease };
}

describe("Daytona managed runtime provider package", () => {
  it("runs an AMA worker through the swappable lifecycle and resource Ports", async () => {
    const createDriver = Reflect.get(
      daytonaRuntime,
      "createDaytonaManagedRuntimeDriver",
    );
    expect(createDriver).toBeTypeOf("function");
    const client = new FakeDaytonaClient();
    const driver = (createDriver as (input: unknown) => {
      descriptor(): any;
      create(input: unknown): Promise<any>;
    })({
      client,
      snapshot: "openma-base",
      leaseTtlMs: 90_000,
      outputStore: new InMemoryBlobStore(),
    });

    expect(driver.descriptor()).toMatchObject({
      provider: "daytona",
      placements: ["in_process"],
      capabilities: {
        sandbox: {
          suspendResume: "supported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: {
          strategies: ["retained_runtime", "checkpoint_restore"],
        },
        outputs: {
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
    });

    const resources = await driver.create({
      environmentId: scope.environmentId,
      placement: "in_process",
      providerConfig: {},
    });
    const signal = new AbortController().signal;
    const workspace = await resources.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "workspace",
      signal,
    });
    const outputs = await resources.outputs.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "outputs",
      signal,
    });
    const lease = await resources.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: "final_collect",
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: { command: "python3", args: ["/runner.py"] },
        },
      },
      workspace,
      outputs,
      signal,
    });
    await resources.outputs.attach({
      scope,
      fence,
      strategy: "final_collect",
      binding: outputs,
      sandbox: lease,
      signal,
    });

    await expect(resources.harnessDriver.run({
      scope,
      fence,
      sandbox: lease,
      driver: {
        type: "ama_worker",
        process: { command: "python3", args: ["/runner.py"] },
      },
      signal,
    })).resolves.toEqual({ type: "completed" });
    await expect(resources.sandbox.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "alive",
    });
    await expect(resources.sandbox.suspend({
      scope,
      fence,
      lease,
      signal,
    })).resolves.toMatchObject({ provider: "daytona", runtimeId: "sandbox_1" });

    const sandbox = await client.get("sandbox_1");
    expect(sandbox.labels).toEqual({
      "openma.environment_id": "environment_1",
      "openma.session_id": "session_1",
      "openma.mode": "managed",
    });
    expect(sandbox.commands).toContain("python3 /runner.py");
    expect(sandbox.deletedSessions).toHaveLength(2);
    // Acquire renews the provider lease before readiness; the explicit heartbeat
    // renews it once more.
    expect(sandbox.refreshes).toBe(2);
    expect(sandbox.state).toBe("stopped");
  });

  it("refuses to attach a stable-name sandbox owned by another Environment", async () => {
    const client = new FakeDaytonaClient();
    const foreign = new FakeDaytonaSandbox(
      "sandbox_foreign",
      "openma-session_1",
      {
        "openma.environment_id": "environment_foreign",
        "openma.session_id": scope.sessionId,
        "openma.mode": "managed",
      },
    );
    client.sandboxes.set(foreign.id, foreign);
    const driver = daytonaRuntime.createDaytonaManagedRuntimeDriver({
      client,
      leaseTtlMs: 90_000,
    });

    await expect(acquireRetainedRuntime(driver)).rejects.toThrow(
      "ownership labels do not match",
    );
    expect(client.sandboxes).toHaveLength(1);
    expect(foreign.state).toBe("started");
  });

  it("resolves concurrent create conflicts by validating and attaching the winner", async () => {
    const client = new FakeDaytonaClient();
    const winner = new FakeDaytonaSandbox(
      "sandbox_winner",
      "openma-session_1",
      {
        "openma.environment_id": scope.environmentId,
        "openma.session_id": scope.sessionId,
        "openma.mode": "managed",
      },
    );
    let raced = false;
    client.create = async () => {
      raced = true;
      client.sandboxes.set(winner.id, winner);
      const error = new Error("conflict") as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    };
    const driver = daytonaRuntime.createDaytonaManagedRuntimeDriver({
      client,
      leaseTtlMs: 90_000,
    });

    const { lease } = await acquireRetainedRuntime(driver);

    expect(raced).toBe(true);
    expect(lease.runtimeId).toBe("sandbox_winner");
  });
});
