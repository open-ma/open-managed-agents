import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CredentialEgressPort,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

import * as nodeRuntime from "../src/create-runtime";
import { createNodeManagedEnvironmentWorker } from "../src/create-environment-worker";

const { createNodeManagedRuntime } = nodeRuntime;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("createNodeManagedRuntime", () => {
  it("wires every optional Node composition dependency without leaking provider details", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-node-complete-composition-"));
    roots.push(rootDir);
    const sql = {
      prepare: vi.fn(() => { throw new Error("not used during composition"); }),
      batch: vi.fn(async () => { throw new Error("not used during composition"); }),
      exec: vi.fn(async () => undefined),
    };
    const docker = {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    const scheduler = { sleep: vi.fn(async () => undefined) };
    const runtimeCheckpoint = {
      create: vi.fn(async () => ({
        provider: "fixture",
        checkpointId: "checkpoint",
        kind: "process",
        workspaceRevision: 1,
        harnessVersion: "1",
        runtimeIdentity: "runtime",
      })),
      restore: vi.fn(async () => ({ provider: "docker", runtimeId: "runtime" })),
    } as any;
    const credentialEgress: CredentialEgressPort = {
      capabilities: vi.fn(async () => ({
        enforcement: "enforced",
        credentialMode: "live",
        interceptedProtocols: ["https"],
      } as const)),
      prepare: vi.fn(async () => null),
      attach: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const sessionInputs: SessionInputMaterializerPort = {
      materialize: vi.fn(async () => undefined),
    };

    const options = {
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "node-worker-complete",
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      image: "node:24-alpine",
      network: "openma-network",
      docker,
      additionalMounts: [{ source: "/host/sdk", destination: "/runtime/sdk", readOnly: true }],
      extraHosts: [{ hostname: "host.docker.internal", address: "host-gateway" }],
      scheduler,
      runtimeCheckpoint,
      credentialEgress,
      sessionInputs,
    };
    const runtime = await createNodeManagedRuntime(options);

    expect(runtime).toMatchObject({
      runtimeCheckpoint,
      credentialEgress,
      sessionInputs,
      sandbox: expect.any(Object),
      orphanReconciler: expect.any(Object),
    });
    expect(sql.exec).toHaveBeenCalled();

    const driver = nodeRuntime.createNodeManagedRuntimeDriver({
      ...options,
      credentialEgressCapabilities: {
        enforcement: "enforced",
        credentialMode: "live",
        interceptedProtocols: ["https"],
      },
    });
    expect(driver.descriptor().credentialEgress).toEqual({
      enforcement: "enforced",
      credentialMode: "live",
      interceptedProtocols: ["https"],
    });
    await expect(driver.create({ placement: "external_worker" } as never)).rejects.toThrow(
      /does not support external_worker placement/i,
    );
    await expect(driver.create({ placement: "in_process" } as never)).resolves.toMatchObject({
      runtimeCheckpoint,
      credentialEgress,
      sessionInputs,
    });
  });

  it("projects Docker/filesystem through the swappable provider driver Port", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-node-provider-driver-"));
    roots.push(rootDir);
    const createDriver = Reflect.get(nodeRuntime, "createNodeManagedRuntimeDriver");
    expect(createDriver).toBeTypeOf("function");
    const driver = (createDriver as unknown as (input: unknown) => {
      descriptor(): unknown;
      create(input: unknown): Promise<Record<string, unknown>>;
    })({
      rootDir,
      sql: await createBetterSqlite3SqlClient(":memory:"),
      ownerId: "node-worker-1",
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      image: "node:24-alpine",
    });

    expect(driver.descriptor()).toEqual(expect.objectContaining({
      provider: "node-docker",
      placements: ["in_process"],
      capabilities: {
        sandbox: {
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: { strategies: ["checkpoint_restore"] },
        outputs: {
          strategies: [{ strategy: "final_collect", durability: "durable" }],
        },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
      credentialEgress: {
        enforcement: "unsupported",
        credentialMode: "snapshot",
        interceptedProtocols: [],
      },
    }));
    const resources = await driver.create({ placement: "in_process" });
    expect(resources).toEqual(expect.objectContaining({
      sandbox: expect.any(Object),
      workspace: expect.any(Object),
      outputs: expect.any(Object),
      harnessDriver: expect.any(Object),
      sessionInputs: expect.objectContaining({ materialize: expect.any(Function) }),
    }));
  });

  it("routes the preinstalled Docker composition through the common worker installation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-node-worker-installation-"));
    roots.push(rootDir);
    const cluster = await createNodeManagedEnvironmentWorker({
      runtime: {
        rootDir,
        sql: await createBetterSqlite3SqlClient(":memory:"),
        ownerId: "node-worker-1",
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        image: "node:24-alpine",
      },
      worker: {
        client: {
          baseURL: "https://api.openma.test",
          beta: { environments: { work: {} }, webhooks: {} },
          withOptions: vi.fn(() => ({})),
        } as never,
        environmentId: "environment_01",
        environmentKey: "environment-key",
        workspaceId: "workspace_01",
        profileFor: vi.fn(),
      },
    });

    expect(cluster).toMatchObject({
      mode: "runtime_host",
      strategy: "claim_then_acquire",
      environmentWorker: expect.objectContaining({
        drain: expect.any(Function),
        handleWebhook: expect.any(Function),
        run: expect.any(Function),
      }),
    });
  });

  it("exposes the operator Session metadata materializer to the Runtime Host", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-node-session-inputs-"));
    roots.push(rootDir);
    const sessionInputs: SessionInputMaterializerPort = {
      materialize: vi.fn(async () => undefined),
    };

    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql: await createBetterSqlite3SqlClient(":memory:"),
      ownerId: "node-worker-1",
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      image: "node:24-alpine",
      sessionInputs,
    });

    expect(runtime.sessionInputs).toBe(sessionInputs);
  });

  it("exposes an operator-supplied credential-egress Port without downgrading it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-node-egress-port-"));
    roots.push(rootDir);
    const credentialEgress: CredentialEgressPort = {
      capabilities: vi.fn(async () => ({
        enforcement: "enforced",
        credentialMode: "live",
        interceptedProtocols: ["http", "https"],
      } as const)),
      prepare: vi.fn(async () => null),
      attach: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql: await createBetterSqlite3SqlClient(":memory:"),
      ownerId: "node-worker-1",
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      image: "node:24-alpine",
      credentialEgress,
    });

    expect(runtime.credentialEgress).toBe(credentialEgress);
  });
});
