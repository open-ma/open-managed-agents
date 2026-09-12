import { createManagedEnvironmentWorkDispatchPort } from "@open-managed-agents/environment-dispatch-vercel";
import {
  createDispatchedManagedEnvironmentWorker,
  type DispatchedManagedEnvironmentWorkerClient,
  type ManagedEnvironmentWorker,
} from "@open-managed-agents/managed-runtime-host";
import type { VercelSdkPort } from "@open-managed-agents/vercel-sandbox-contract";

import type { VercelControlPlaneConfig } from "./config.js";

export interface VercelEnvironmentWorkerDependencies {
  controlClient: DispatchedManagedEnvironmentWorkerClient;
  sandboxClient: VercelSdkPort;
  now?: () => number;
  onError?(error: unknown): void | Promise<void>;
}

/** Compose OpenMA's official Work consumer with the Vercel lifecycle driver. */
export function createVercelEnvironmentWorker(
  config: VercelControlPlaneConfig,
  dependencies: VercelEnvironmentWorkerDependencies,
): ManagedEnvironmentWorker {
  const dispatch = createManagedEnvironmentWorkDispatchPort({
    client: dependencies.sandboxClient,
    snapshotId: config.snapshotId,
    worker: config.sandbox.worker,
    timeoutMs: config.sandbox.timeoutMs,
    region: config.sandbox.region,
    resources: config.sandbox.resources,
    now: dependencies.now,
  });
  return createDispatchedManagedEnvironmentWorker({
    client: dependencies.controlClient,
    environmentId: config.environmentId,
    environmentKey: config.environmentKey,
    workspaceId: config.workspaceId,
    webhookKey: config.webhookSecret,
    sandboxApiBaseUrl: config.apiBaseUrl,
    maxWorkItemsPerDrain: config.sandbox.maxWorkItemsPerDrain,
    dispatch,
    onError: dependencies.onError,
  });
}
