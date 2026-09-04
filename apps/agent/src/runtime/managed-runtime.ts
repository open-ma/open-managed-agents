import { createProviderManagedRuntime } from "@open-managed-agents/managed-runtime-sandbox";
import {
  composeSandboxHarnessDrivers,
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
  SupervisedSandboxHarnessDriver,
  type RuntimeCheckpointPort,
} from "@open-managed-agents/managed-runtime-host";
import {
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "@open-managed-agents/runtime-resource-fence-sql";
import { CfR2BlobStore } from "@open-managed-agents/blob-store/adapters/cf-r2";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type {
  SandboxCheckpointHandle,
  SandboxProviderPort,
} from "@open-managed-agents/sandbox";
import { supportsSessionOutputMount } from "@open-managed-agents/sandbox";
import type { Env } from "@open-managed-agents/shared";

import { CloudflareSandbox } from "./sandbox";

export interface CloudflareManagedRuntimeOptions {
  leaseTtlMs?: number;
  createSandbox?: (env: Env, runtimeId: string) => CloudflareSandbox;
}

export interface CloudflareManagedRuntimeHostOptions
  extends CloudflareManagedRuntimeOptions {
  /** Stable identity of this SessionDO/worker instance; never a user token. */
  ownerId: string;
  heartbeatIntervalMs?: number;
  /** Optional provider-owned process checkpoint adapter. */
  runtimeCheckpoint?: RuntimeCheckpointPort;
}

/**
 * Cloudflare preset for the provider-neutral Runtime Host. Cloudflare's
 * createBackup/restoreBackup is a portable filesystem checkpoint, not a warm
 * process resume, so this preset intentionally does not advertise retained
 * runtime or process checkpoint semantics.
 */
export function createCloudflareManagedRuntime(
  env: Env,
  options: CloudflareManagedRuntimeOptions = {},
) {
  const hasDurableOutputMount = Boolean(
    env.FILES_BUCKET
      && env.R2_ENDPOINT
      && env.R2_ACCESS_KEY_ID
      && env.R2_SECRET_ACCESS_KEY,
  );
  const instantiate = options.createSandbox
    ?? ((runtimeEnv: Env, runtimeId: string) =>
      new CloudflareSandbox(runtimeEnv, runtimeId));
  const provider: SandboxProviderPort<CloudflareSandbox> = {
    create: async (context) => instantiate(env, context.sessionId),
    resume: async () => {
      throw new Error(
        "Cloudflare runtime-scoped resume is unsupported; use a portable filesystem checkpoint",
      );
    },
    restore: async (
      checkpoint: SandboxCheckpointHandle,
      context,
    ) => {
      const sandbox = instantiate(env, context.sessionId);
      await sandbox.resume(checkpoint);
      return sandbox;
    },
  };

  return createProviderManagedRuntime({
    providerName: "cloudflare",
    provider,
    context: (scope) => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: () => ({}),
    leaseTtlMs: options.leaseTtlMs ?? 90_000,
    sandboxCapabilities: {
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["checkpoint_restore"],
      portableCheckpointKind: "filesystem",
    },
    reapRuntime: async ({ lease }) => {
      await instantiate(env, lease.runtimeId).destroy();
    },
    ...(env.FILES_BUCKET === undefined
      ? {}
      : {
          outputs: {
            store: new CfR2BlobStore(env.FILES_BUCKET),
            keyPrefix: "managed-runtime-output-candidates",
            durability: "durable" as const,
            ...(hasDurableOutputMount
              ? {
                  durableMount: {
                    durability: "durable" as const,
                    async attach({ runtime, scope, signal }) {
                      signal.throwIfAborted();
                      if (!supportsSessionOutputMount(runtime)) {
                        throw new Error(
                          "Cloudflare runtime does not expose the Session output mount Port",
                        );
                      }
                      await runtime.mountSessionOutputs({
                        tenantId: scope.workspaceId,
                        sessionId: scope.sessionId,
                      });
                      signal.throwIfAborted();
                    },
                  },
                }
              : {}),
          },
        }),
    drivers: ["ama_worker"],
  });
}

/**
 * Preinstalled Cloudflare host: D1 fencing/orphans, Sandbox DO transport,
 * R2 output candidates, direct AMA workers, and the optional OpenMA
 * supervisor lane. Schema migration remains deployment-owned.
 */
export function createCloudflareManagedRuntimeHost(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
) {
  const runtime = createCloudflareManagedRuntime(env, options);
  const sql = new CfD1SqlClient(env.MAIN_DB);
  const fences = new SqlRuntimeResourceFencePort(sql);
  const orphans = new SqlRuntimeOrphanPort(sql);
  const harnessDriver = composeSandboxHarnessDrivers(
    runtime.harness,
    new SupervisedSandboxHarnessDriver({
      transport: runtime.supervisorTransport,
    }),
  );
  const leaseTtlMs = options.leaseTtlMs ?? 90_000;
  const host = createManagedRuntimeHost({
    ownerId: options.ownerId,
    leaseTtlMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    fences,
    sandbox: runtime.sandbox,
    workspace: runtime.workspace,
    outputs: runtime.outputs,
    harnessDriver,
    orphans,
    ...(options.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: options.runtimeCheckpoint }),
  });
  const orphanReconciler = createManagedRuntimeOrphanReconciler({
    orphans,
    sandbox: runtime.sandbox,
  });
  return {
    ...runtime,
    fences,
    orphans,
    harnessDriver,
    host,
    orphanReconciler,
  };
}
