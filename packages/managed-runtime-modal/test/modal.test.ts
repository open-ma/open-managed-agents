import { describe, expect, it, vi } from "vitest";

import {
  createModalManagedRuntime,
  createModalManagedRuntimeDriver,
  type ModalCreateInput,
  type ModalProcessPort,
  type ModalSandboxSdkPort,
  type ModalSdkPort,
} from "../src/modal";

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

function textStream(value = ""): ReadableStream<string> {
  return new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } });
}

class FakeProcess implements ModalProcessPort {
  readonly stdin = new WritableStream<string>();
  readonly stdout = textStream("worker output");
  readonly stderr = textStream();
  readonly wait = vi.fn(async () => 0);
}

class FakeSandbox implements ModalSandboxSdkPort {
  readonly sandboxId = "sb-1";
  tags: Record<string, string> = {};
  readonly filesystem = {
    makeDirectory: vi.fn(async () => {}),
    readText: vi.fn(async () => "content"),
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeText: vi.fn(async () => {}),
    writeBytes: vi.fn(async () => {}),
  };
  readonly poll = vi.fn(async () => null);
  readonly exec = vi.fn(async () => new FakeProcess());
  readonly getTags = vi.fn(async () => this.tags);
  readonly setTags = vi.fn(async (tags: Record<string, string>) => { this.tags = tags; });
  readonly updateNetworkPolicy = vi.fn(async () => {});
  readonly detach = vi.fn();
  readonly terminate = vi.fn(async () => {});
}

function sdk(sandbox: FakeSandbox): ModalSdkPort & { create: ReturnType<typeof vi.fn> } {
  return {
    findByName: vi.fn(async () => null),
    create: vi.fn(async (input: ModalCreateInput) => {
      sandbox.tags = input.tags;
      return sandbox;
    }),
    fromId: vi.fn(async () => sandbox),
  };
}

describe("Modal managed runtime provider", () => {
  it("mounts a Session-scoped Volume, defaults to blocked networking, and preserves native duplex stdio", async () => {
    const sandbox = new FakeSandbox();
    const client = sdk(sandbox);
    const runtime = createModalManagedRuntime({
      client,
      appName: "openma",
      image: "node:22-slim",
      workspaceVolumeName: "openma-workspaces-v2",
      leaseTtlMs: 90_000,
      outputStore: null,
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
      appName: "openma",
      image: "node:22-slim",
      name: expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      tags: expect.objectContaining({ openma: "managed" }),
      workspace: {
        volumeName: "openma-workspaces-v2",
        mountPath: "/workspace",
        subPath: expect.stringMatching(/^sessions\/[a-f0-9]{48}$/),
      },
      options: expect.objectContaining({ blockNetwork: true, workdir: "/workspace" }),
    }));
    expect(sandbox.updateNetworkPolicy).toHaveBeenCalledWith({
      outboundDomainAllowlist: [],
      outboundCidrAllowlist: [],
    });
    expect(sandbox.filesystem.makeDirectory).toHaveBeenCalledWith("/workspace", { createParents: true });
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
    expect(sandbox.detach).toHaveBeenCalledOnce();
  });

  it("supports native allowlist updates for a fenced egress binding", async () => {
    const sandbox = new FakeSandbox();
    const runtime = createModalManagedRuntime({
      client: sdk(sandbox),
      appName: "openma",
      image: "node:22-slim",
      workspaceVolumeName: "openma-workspaces-v2",
      leaseTtlMs: 90_000,
      outputStore: null,
      credentialEgress: {
        capabilities: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
        attach: async ({ runtime: acquired }) => acquired.updateNetworkPolicy({
          outboundDomainAllowlist: ["mcp.openma.internal"],
          outboundCidrAllowlist: [],
        }),
        revoke: async ({ runtime: acquired }) => acquired.updateNetworkPolicy({
          outboundDomainAllowlist: [],
          outboundCidrAllowlist: [],
        }),
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
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(1, {
      outboundDomainAllowlist: [],
      outboundCidrAllowlist: [],
    });
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(2, {
      outboundDomainAllowlist: ["mcp.openma.internal"],
      outboundCidrAllowlist: [],
    });
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(3, {
      outboundDomainAllowlist: [],
      outboundCidrAllowlist: [],
    });
  });

  it("declares provider-retained workspace without inventing process checkpoint support", () => {
    const driver = createModalManagedRuntimeDriver({
      client: sdk(new FakeSandbox()),
      appName: "openma",
      image: "node:22-slim",
      workspaceVolumeName: "openma-workspaces-v2",
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "modal",
      placements: ["in_process"],
      capabilities: {
        sandbox: { suspendResume: "supported", hardTerminate: "supported", runtimeCheckpoints: [] },
        workspace: { strategies: ["retained_runtime"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
      credentialEgress: { enforcement: "unsupported" },
    });
  });
});
