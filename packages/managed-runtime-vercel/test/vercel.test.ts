import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createVercelManagedRuntime,
  createVercelManagedRuntimeDriver,
  type VercelCommandPort,
  type VercelNetworkPolicy,
  type VercelSandboxSdkPort,
  type VercelSdkPort,
} from "../src/vercel";

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

class FakeCommand implements VercelCommandPort {
  readonly kill = vi.fn(async () => {});
  async wait() {
    return { exitCode: 0 };
  }
}

class FakeSandbox implements VercelSandboxSdkPort {
  readonly name = "oma-3a1d7b6848ba4816d72ee2f2d98b95b4";
  status = "running";
  persistent = true;
  tags: Record<string, string> = {};
  currentSnapshotId: string | undefined = "snapshot_1";
  readonly updateNetworkPolicy = vi.fn(async (
    policy: VercelNetworkPolicy,
    _options?: { signal?: AbortSignal },
  ) => policy);
  readonly stop = vi.fn(async () => ({ snapshot: { id: "snapshot_1" } }));
  readonly delete = vi.fn(async () => {});
  readonly mkDir = vi.fn(async (_path: string, _options?: { signal?: AbortSignal }) => {});
  readonly readFileToBuffer = vi.fn(async () => Buffer.from("content"));
  readonly writeFiles = vi.fn(async () => {});
  readonly runCommandMock = vi.fn(async (input: {
    cmd: string;
    args?: string[];
    detached?: boolean;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  }): Promise<VercelCommandPort | {
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }> => {
    if (input.detached) {
      input.stdout?.end("worker output");
      input.stderr?.end();
      return new FakeCommand();
    }
    return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
  });

  runCommand(input: Parameters<VercelSandboxSdkPort["runCommand"]>[0] & { detached: true }): Promise<VercelCommandPort>;
  runCommand(input: Parameters<VercelSandboxSdkPort["runCommand"]>[0]): ReturnType<VercelSandboxSdkPort["runCommand"]>;
  async runCommand(input: Parameters<VercelSandboxSdkPort["runCommand"]>[0]) {
    return this.runCommandMock(input);
  }
}

function sdk(sandbox: FakeSandbox): VercelSdkPort {
  return {
    getOrCreate: vi.fn(async (options) => {
      sandbox.tags = options.tags;
      return sandbox;
    }),
    get: vi.fn(async () => sandbox),
  };
}

describe("Vercel managed runtime provider", () => {
  it("uses a persistent named sandbox, owner tags, deny-by-default networking, and real command streams", async () => {
    const sandbox = new FakeSandbox();
    const client = sdk(sandbox);
    const runtime = createVercelManagedRuntime({
      client,
      leaseTtlMs: 90_000,
      outputStore: null,
      createOptions: async ({ scope: acquiredScope }) => {
        expect(acquiredScope).toEqual(scope);
        return { image: "vercel/sandbox/node:24", timeout: 600_000 };
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
        driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      },
      workspace,
      outputs: null,
      signal,
    });

    expect(client.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      persistent: true,
      resume: true,
      image: "vercel/sandbox/node:24",
      networkPolicy: "deny-all",
      tags: expect.objectContaining({
        openma: "managed",
        oma_env: expect.stringMatching(/^[a-f0-9]{24}$/),
        oma_session: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    expect(sandbox.mkDir).toHaveBeenCalledOnce();
    expect(sandbox.mkDir.mock.calls[0]?.[0]).toBe("/workspace");
    expect(sandbox.mkDir.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(sandbox.mkDir.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

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
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });

  it("wires native live credential brokering and revokes to deny-all", async () => {
    const sandbox = new FakeSandbox();
    const client = sdk(sandbox);
    const allowPolicy: VercelNetworkPolicy = {
      allow: {
        "api.openai.com": [{
          transform: [{ headers: { authorization: "Bearer provider-side-value" } }],
        }],
      },
    };
    const runtime = createVercelManagedRuntime({
      client,
      leaseTtlMs: 90_000,
      outputStore: null,
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
        attach: async ({ runtime: acquired }) => acquired.updateNetworkPolicy(allowPolicy),
        revoke: async ({ runtime: acquired }) => acquired.updateNetworkPolicy("deny-all"),
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

    expect(sandbox.updateNetworkPolicy.mock.calls[0]?.[0]).toBe("deny-all");
    expect(sandbox.updateNetworkPolicy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(sandbox.updateNetworkPolicy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(2, allowPolicy, undefined);
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(3, "deny-all", undefined);
  });

  it("declares only the guarantees implemented by the provider package", () => {
    const driver = createVercelManagedRuntimeDriver({
      client: sdk(new FakeSandbox()),
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "vercel",
      placements: ["in_process"],
      capabilities: {
        sandbox: { suspendResume: "supported", hardTerminate: "supported", runtimeCheckpoints: [] },
        workspace: { strategies: ["retained_runtime"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker"] },
      },
      credentialEgress: { enforcement: "unsupported" },
    });
  });

  it("does not expose a supervisor transport without streaming stdin", async () => {
    const driver = createVercelManagedRuntimeDriver({
      client: sdk(new FakeSandbox()),
      leaseTtlMs: 90_000,
      outputStore: null,
    });

    const resources = await driver.create({ placement: "in_process" } as never);

    expect(resources).not.toHaveProperty("supervisorTransport");
  });
});
