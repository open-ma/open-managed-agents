import { describe, expect, it, vi } from "vitest";

import {
  createSuperserveManagedRuntime,
  createSuperserveManagedRuntimeDriver,
  type SuperserveCommandSessionPort,
  type SuperserveSandboxSdkPort,
  type SuperserveSdkPort,
} from "../src/superserve";

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

class FakeCommand implements SuperserveCommandSessionPort {
  readonly stdin = { write: vi.fn(), close: vi.fn() };
  readonly kill = vi.fn();
  readonly close = vi.fn(async () => {});
  readonly wait = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false }));
}

class FakeSandbox implements SuperserveSandboxSdkPort {
  readonly id = "sandbox-1";
  readonly name = "oma-3a1d7b6848ba4816d72ee2f2d98b95b4";
  readonly metadata: Record<string, string> = {};
  status = "active";
  readonly files = {
    write: vi.fn(async () => {}),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    readText: vi.fn(async () => "content"),
  };
  readonly commands = {
    run: vi.fn(async (command: string) => ({
      stdout: command.includes("__OPENMA_RUNTIME_READY__")
        ? "__OPENMA_RUNTIME_READY__"
        : "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    })),
    spawn: vi.fn(async (_command: string, options?: {
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    }) => {
      const command = new FakeCommand();
      queueMicrotask(() => { options?.onStdout?.("worker output"); });
      return command;
    }),
  };
  readonly getInfo = vi.fn(async () => ({
    id: this.id,
    name: this.name,
    status: this.status,
    metadata: this.metadata,
  }));
  readonly pause = vi.fn(async () => { this.status = "paused"; });
  readonly resume = vi.fn(async () => { this.status = "active"; });
  readonly kill = vi.fn(async () => { this.status = "failed"; });
  readonly update = vi.fn(async () => {});
  readonly attachSecret = vi.fn(async () => {});
  readonly detachSecret = vi.fn(async () => {});
}

function sdk(sandbox: FakeSandbox): SuperserveSdkPort {
  return {
    create: vi.fn(async (options) => {
      Object.assign(sandbox.metadata, options.metadata);
      return sandbox;
    }),
    connect: vi.fn(async () => sandbox),
    list: vi.fn(async () => []),
    killById: vi.fn(async () => {}),
  };
}

describe("Superserve managed runtime provider", () => {
  it("uses stable ownership, strict egress defaults, pause/resume, and full-duplex commands", async () => {
    const sandbox = new FakeSandbox();
    const client = sdk(sandbox);
    const runtime = createSuperserveManagedRuntime({
      client,
      leaseTtlMs: 90_000,
      outputStore: null,
      fromTemplate: "openma-worker",
      runtimeEnvironment: {
        type: "custom",
        identity: "custom-superserve-template",
        artifact: { type: "template", reference: "openma-worker-v2" },
        prepare: async () => {},
      },
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
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal,
    });

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      fromTemplate: "openma-worker-v2",
      metadata: expect.objectContaining({ openma: "managed" }),
      network: {
        allowOut: ["*.superserve.ai"],
        denyOut: ["0.0.0.0/0"],
      },
    }));
    await expect(runtime.harness.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
      signal,
    })).resolves.toEqual({ type: "completed" });
    await runtime.sandbox.suspend({ scope, fence, lease, signal });
    expect(sandbox.pause).toHaveBeenCalledOnce();
  });

  it("binds and revokes provider-side proxy secrets before compute release", async () => {
    const sandbox = new FakeSandbox();
    const runtime = createSuperserveManagedRuntime({
      client: sdk(sandbox),
      leaseTtlMs: 90_000,
      outputStore: null,
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
        attach: async ({ runtime: acquired }) => acquired.attachSecret("OPENAI_API_KEY", "openma-openai"),
        revoke: async ({ runtime: acquired }) => acquired.detachSecret("OPENAI_API_KEY"),
      },
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "materialize-2",
      signal,
    });
    const binding = await runtime.credentialEgress!.prepare({
      scope,
      fence,
      requirement: "required",
      idempotencyKey: "egress-1",
      signal,
    });
    const lease = await runtime.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      credentialEgress: binding,
      signal,
    });
    await runtime.credentialEgress!.attach({ scope, fence, binding: binding!, sandbox: lease, signal });
    await runtime.credentialEgress!.revoke({ scope, fence, binding: binding!, reason: "completed" });
    expect(sandbox.attachSecret).toHaveBeenCalledWith("OPENAI_API_KEY", "openma-openai");
    expect(sandbox.detachSecret).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("declares provider persistence without a portable process checkpoint", () => {
    const driver = createSuperserveManagedRuntimeDriver({
      client: sdk(new FakeSandbox()),
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "superserve",
      placements: ["in_process"],
      capabilities: {
        sandbox: { suspendResume: "supported", hardTerminate: "supported", runtimeCheckpoints: [] },
        workspace: { strategies: ["retained_runtime"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
    });
  });
});
