import { describe, expect, it, vi } from "vitest";
import type { Env } from "@open-managed-agents/shared";

import {
  createCloudflareManagedEnvironmentWorker,
  createCloudflareManagedRuntime,
  createCloudflareManagedRuntimeDriver,
  createCloudflareManagedRuntimeHost,
  createCloudflareSandboxProvider,
  createManagedRuntimeProviderDriver,
  type CloudflareManagedRuntimeSandbox,
} from "../src/index";

class FakeSandbox implements CloudflareManagedRuntimeSandbox {
  readonly runtimeHandle = () => ({ provider: "cloudflare", runtimeId: "session_1" });
  readonly runtimeCapabilities = () => ({
    lease: true,
    suspend: ["filesystem" as const],
    checkpoint: ["filesystem" as const],
  });
  readonly status = vi.fn(async () => "running" as const);
  readonly renewLease = vi.fn(async () => {});
  readonly checkpoint = vi.fn(async () => ({
    provider: "cloudflare",
    checkpointId: "checkpoint_1",
    sourceRuntimeId: "session_1",
    kind: "filesystem" as const,
    scope: "portable" as const,
  }));
  readonly suspend = this.checkpoint;
  readonly resume = vi.fn(async () => {});
  readonly destroy = vi.fn(async () => {});
  readonly exec = vi.fn(async () => "");
  readonly readFile = vi.fn(async () => "");
  readonly readFileBytes = vi.fn(async () => new Uint8Array());
  readonly writeFile = vi.fn(async (path: string) => path);
  readonly writeFileBytes = vi.fn(async (path: string) => path);
  readonly spawnDuplexProcess = vi.fn();
  readonly setOutboundContext = vi.fn(async () => {});
  readonly revokeOutboundContext = vi.fn(async () => {});
  readonly sessionOutputMountCapabilities = () => ({ durability: "durable" as const });
  readonly mountSessionOutputs = vi.fn(async () => {});
}

const env = { MAIN_DB: {}, SANDBOX: {} } as unknown as Env;

describe("isolated Cloudflare managed runtime package", () => {
  it("preinstalls provider-runtime Session file/repository staging", async () => {
    const driver = createCloudflareManagedRuntimeDriver(env, {
      createSandbox: () => new FakeSandbox(),
    });

    await expect(driver.create({
      environmentId: "environment_1",
      placement: "in_process",
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "disabled" },
        runtimeCheckpoint: "disabled",
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      providerConfig: {},
    })).resolves.toMatchObject({
      sessionInputs: { materialize: expect.any(Function) },
    });
  });

  it("projects the direct binding through the standard provider factory", () => {
    const sandbox = new FakeSandbox();
    const options = {
      env,
      createSandbox: () => sandbox,
    };
    expect(createManagedRuntimeProviderDriver(options).descriptor()).toEqual(
      createCloudflareManagedRuntimeDriver(env, options).descriptor(),
    );
    expect(createManagedRuntimeProviderDriver(options).descriptor()).toMatchObject({
      provider: "cloudflare",
      placements: ["in_process"],
      credentialEgress: { enforcement: "enforced" },
    });
  });

  it("exposes create/restore and explicit unsupported resume on the Cloudflare provider Port", async () => {
    const sandboxes: FakeSandbox[] = [];
    const createSandbox = vi.fn((_env, runtimeId: string) => {
      const sandbox = new FakeSandbox();
      Object.defineProperty(sandbox, "runtimeHandle", { value: () => ({ provider: "cloudflare", runtimeId }) });
      sandboxes.push(sandbox);
      return sandbox;
    });
    const provider = createCloudflareSandboxProvider(env, createSandbox);
    const context = { sessionId: "session-provider", workdir: "/workspace" };
    await expect(provider.create(context, {})).resolves.toBe(sandboxes[0]);
    await expect(provider.resume({ provider: "cloudflare", runtimeId: "runtime" }, context, {})).rejects.toThrow("runtime-scoped resume is unsupported");
    const checkpoint = { provider: "cloudflare", checkpointId: "checkpoint", sourceRuntimeId: "source", kind: "filesystem", scope: "portable" } as const;
    await expect(provider.restore(checkpoint, context, {})).resolves.toBe(sandboxes[1]);
    expect(sandboxes[1]?.resume).toHaveBeenCalledWith(checkpoint);
  });

  it("wires credential egress, durable output mounts, acquisition, revocation, and reaping", async () => {
    const sandbox = new FakeSandbox();
    const createSandbox = vi.fn(() => sandbox);
    const runtime = createCloudflareManagedRuntime({
      ...env,
      FILES_BUCKET: {},
      R2_ENDPOINT: "https://r2",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
    } as never, {
      leaseTtlMs: 1234,
      controlPlaneBaseUrl: "https://control",
      createSandbox,
    });
    const scope = { workspaceId: "tenant", environmentId: "environment", sessionId: "session", workId: "work" };
    const fence = { ...scope, ownerId: "owner", generation: 3, token: "fence", expiresAt: "2026-09-07T12:00:00.000Z" };
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({ scope, fence, strategy: "checkpoint_restore", activeCheckpoint: null, idempotencyKey: "workspace", signal });
    const outputs = await runtime.outputs.prepare({ scope, fence, strategy: "durable_mount", idempotencyKey: "outputs", signal });
    const egress = await runtime.credentialEgress!.prepare({ scope, fence, requirement: "required", idempotencyKey: "egress", signal });
    const lease = await runtime.sandbox.acquire({
      scope,
      fence,
      plan: { workspaceStrategy: "checkpoint_restore", outputStrategy: "durable_mount", runtimeCheckpoint: null, driver: { type: "ama_worker", process: { command: "worker" } } },
      workspace,
      outputs,
      credentialEgress: egress,
      signal,
    });
    await runtime.outputs.attach({ scope, fence, strategy: "durable_mount", binding: outputs, sandbox: lease, signal });
    await runtime.credentialEgress!.attach({ scope, fence, binding: egress!, sandbox: lease, signal });
    await runtime.credentialEgress!.revoke({ scope, fence, binding: egress!, reason: "completed" });
    expect(sandbox.setOutboundContext).toHaveBeenCalledWith({
      tenantId: "tenant", environmentId: "environment", sessionId: "session", workId: "work", ownerId: "owner", generation: 3, fenceToken: "fence", required: true, controlPlaneBaseUrl: "https://control",
    });
    expect(sandbox.mountSessionOutputs).toHaveBeenCalledWith({ tenantId: "tenant", sessionId: "session" });
    expect(sandbox.revokeOutboundContext).toHaveBeenCalledWith({ workId: "work", generation: 3, reason: "completed" });
    await runtime.sandbox.terminate({ scope, fence, lease, reason: "completed" });
    await runtime.sandbox.reap({ scope, lease: { provider: "cloudflare", runtimeId: "orphan" }, reason: "lease_lost" });
    expect(createSandbox).toHaveBeenLastCalledWith(expect.anything(), "orphan");
  });

  it("omits optional egress URL and rejects a runtime without the durable output mount Port", async () => {
    const sandbox = new FakeSandbox();
    const runtime = createCloudflareManagedRuntime({ ...env, FILES_BUCKET: {}, R2_ENDPOINT: "r2", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s" } as never, { createSandbox: () => sandbox });
    const scope = { workspaceId: "tenant", environmentId: "environment", sessionId: "session", workId: "work" };
    const fence = { ...scope, ownerId: "owner", generation: 1, token: "fence", expiresAt: "2026-09-07T12:00:00.000Z" };
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({ scope, fence, strategy: "checkpoint_restore", activeCheckpoint: null, idempotencyKey: "workspace", signal });
    const egress = await runtime.credentialEgress!.prepare({ scope, fence, requirement: "best_effort", idempotencyKey: "egress", signal });
    const lease = await runtime.sandbox.acquire({ scope, fence, plan: { workspaceStrategy: "checkpoint_restore", outputStrategy: null, runtimeCheckpoint: null, driver: { type: "ama_worker", process: { command: "worker" } } }, workspace, outputs: null, credentialEgress: egress, signal });
    await runtime.credentialEgress!.attach({ scope, fence, binding: egress!, sandbox: lease, signal });
    expect(sandbox.setOutboundContext).toHaveBeenCalledWith(expect.not.objectContaining({ controlPlaneBaseUrl: expect.anything() }));
    expect(sandbox.setOutboundContext).toHaveBeenCalledWith(expect.objectContaining({ required: false }));

    const withoutMount = new FakeSandbox();
    Object.defineProperty(withoutMount, "mountSessionOutputs", { value: undefined });
    const noMountRuntime = createCloudflareManagedRuntime({ ...env, FILES_BUCKET: {}, R2_ENDPOINT: "r2", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s" } as never, { createSandbox: () => withoutMount });
    const ws = await noMountRuntime.workspace.materialize({ scope, fence, strategy: "checkpoint_restore", activeCheckpoint: null, idempotencyKey: "ws2", signal });
    const out = await noMountRuntime.outputs.prepare({ scope, fence, strategy: "durable_mount", idempotencyKey: "out2", signal });
    const noMountLease = await noMountRuntime.sandbox.acquire({ scope, fence, plan: { workspaceStrategy: "checkpoint_restore", outputStrategy: "durable_mount", runtimeCheckpoint: null, driver: { type: "ama_worker", process: { command: "worker" } } }, workspace: ws, outputs: out, signal });
    await expect(noMountRuntime.outputs.attach({ scope, fence, strategy: "durable_mount", binding: out, sandbox: noMountLease, signal })).rejects.toThrow("does not expose");
  });

  it("describes no output, final collection, and durable mount variants", async () => {
    const options = { createSandbox: () => new FakeSandbox() };
    expect(createCloudflareManagedRuntimeDriver(env, options).descriptor().capabilities.outputs.strategies).toEqual([]);
    expect(createCloudflareManagedRuntimeDriver({ ...env, FILES_BUCKET: {} } as never, options).descriptor().capabilities.outputs.strategies).toEqual([{ strategy: "final_collect", durability: "durable" }]);
    expect(createCloudflareManagedRuntimeDriver({ ...env, FILES_BUCKET: {}, R2_ENDPOINT: "r", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s" } as never, options).descriptor().capabilities.outputs.strategies).toEqual([
      { strategy: "durable_mount", durability: "durable" },
      { strategy: "final_collect", durability: "durable" },
    ]);
    const collectOnly = createCloudflareManagedRuntime({ ...env, FILES_BUCKET: {} } as never, options);
    await expect(collectOnly.outputs.capabilities({ workspaceId: "w", environmentId: "e", sessionId: "s", workId: "x" })).resolves.toEqual({ strategies: [{ strategy: "final_collect", durability: "durable" }] });
  });

  it("validates placement and preserves an explicit Session input materializer", async () => {
    const sessionInputs = {
      materialize: vi.fn(async () => {}),
      synchronize: vi.fn(async () => {}),
    };
    const driver = createCloudflareManagedRuntimeDriver(env, { createSandbox: () => new FakeSandbox(), sessionInputs });
    await expect(driver.create({ placement: "external_worker" } as never)).rejects.toThrow("does not support external_worker");
    await expect(driver.create({ placement: "in_process" } as never)).resolves.toMatchObject({ sessionInputs, credentialEgress: expect.any(Object) });
  });

  it("constructs host/orphan and environment-worker compositions with URL precedence", () => {
    const createSandbox = () => new FakeSandbox();
    const runtimeCheckpoint = { kind: "memory", create: vi.fn(), restore: vi.fn() } as never;
    const sessionInputs = {
      materialize: vi.fn(async () => {}),
      synchronize: vi.fn(async () => {}),
    };
    const host = createCloudflareManagedRuntimeHost(env, { ownerId: "owner", createSandbox, leaseTtlMs: 1000, heartbeatIntervalMs: 200, runtimeCheckpoint, sessionInputs });
    expect(host).toMatchObject({ fences: expect.any(Object), orphans: expect.any(Object), host: expect.any(Object), orphanReconciler: expect.any(Object), sessionInputs });
    expect(createCloudflareManagedRuntimeHost(env, { ownerId: "owner-defaults", createSandbox })).toMatchObject({ host: expect.any(Object) });

    const client: Record<string, unknown> = { baseURL: "https://client" };
    client.withOptions = vi.fn(() => client);
    const worker = { client, environmentId: "environment", environmentKey: "key" };
    for (const runtime of [
      { ownerId: "owner-a", createSandbox, controlPlaneBaseUrl: "https://explicit" },
      { ownerId: "owner-b", createSandbox },
    ]) {
      const composed = createCloudflareManagedEnvironmentWorker(env, { runtime, worker: runtime.controlPlaneBaseUrl ? worker : { ...worker, sandboxApiBaseUrl: "https://sandbox" } } as never);
      expect(composed.environmentWorker).toBeDefined();
    }
    expect(createCloudflareManagedEnvironmentWorker(env, { runtime: { ownerId: "owner-c", createSandbox }, worker } as never).environmentWorker).toBeDefined();
  });
});
