import {
  composeSandboxHarnessDrivers,
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
  SupervisedSandboxHarnessDriver,
  type RuntimeSchedulerPort,
} from "@open-managed-agents/managed-runtime-host";
import {
  ensureRuntimeResourceFenceSchema,
  SqlRuntimeResourceFencePort,
  SqlRuntimeOrphanPort,
  type SqlRuntimeResourceFenceOptions,
} from "@open-managed-agents/runtime-resource-fence-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";

import {
  DockerManagedRuntimeAdapter,
  type DockerCommandPort,
} from "./docker";
import { NodeFilesystemSessionOutputPort } from "./outputs";
import { NodeFilesystemWorkspacePort } from "./workspace";

export interface CreateNodeManagedRuntimeOptions {
  rootDir: string;
  sql: SqlClient;
  /** Explicit because production schema migration should remain operator-owned. */
  initializeFenceSchema?: boolean;
  ownerId: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  image: string;
  network?: string;
  docker?: DockerCommandPort;
  additionalMounts?: readonly {
    source: string;
    destination: string;
    readOnly?: boolean;
  }[];
  extraHosts?: readonly { hostname: string; address: string }[];
  scheduler?: RuntimeSchedulerPort;
  fence?: SqlRuntimeResourceFenceOptions;
}

/** Preinstalled Node reference composition: SQL fence + filesystem + Docker. */
export async function createNodeManagedRuntime(
  options: CreateNodeManagedRuntimeOptions,
) {
  if (options.initializeFenceSchema === true) {
    await ensureRuntimeResourceFenceSchema(options.sql);
  }
  const fences = new SqlRuntimeResourceFencePort(options.sql, options.fence);
  const orphans = new SqlRuntimeOrphanPort(options.sql);
  const workspace = new NodeFilesystemWorkspacePort({ rootDir: options.rootDir });
  const outputs = new NodeFilesystemSessionOutputPort({ rootDir: options.rootDir });
  const sandbox = new DockerManagedRuntimeAdapter({
    image: options.image,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.docker === undefined ? {} : { docker: options.docker }),
    ...(options.additionalMounts === undefined
      ? {}
      : { additionalMounts: options.additionalMounts }),
    ...(options.extraHosts === undefined ? {} : { extraHosts: options.extraHosts }),
  });
  const supervisedHarness = new SupervisedSandboxHarnessDriver({
    transport: sandbox,
  });
  const harnessDriver = composeSandboxHarnessDrivers(
    sandbox,
    supervisedHarness,
  );
  const host = createManagedRuntimeHost({
    ownerId: options.ownerId,
    leaseTtlMs: options.leaseTtlMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    fences,
    sandbox,
    workspace,
    outputs,
    harnessDriver,
    orphans,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  const orphanReconciler = createManagedRuntimeOrphanReconciler({ orphans, sandbox });
  return {
    host,
    fences,
    orphans,
    orphanReconciler,
    sandbox,
    workspace,
    outputs,
    harnessDriver,
  };
}
