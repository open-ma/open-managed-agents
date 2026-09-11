import {
  createManagedEnvironmentWorkerInstallation,
  type ManagedEnvironmentWorkerOptions,
} from "@open-managed-agents/managed-runtime-host";

import {
  createNodeManagedRuntime,
  type CreateNodeManagedRuntimeOptions,
} from "./create-runtime";

export interface CreateNodeManagedEnvironmentWorkerOptions {
  runtime: CreateNodeManagedRuntimeOptions;
  worker: Omit<ManagedEnvironmentWorkerOptions, "host">;
}

/** Preinstalled Node composition: official WorkPoller + fenced Docker host. */
export async function createNodeManagedEnvironmentWorker(
  options: CreateNodeManagedEnvironmentWorkerOptions,
) {
  const runtime = await createNodeManagedRuntime(options.runtime);
  const installation = await createManagedEnvironmentWorkerInstallation({
    mode: "runtime_host",
    worker: {
      ...options.worker,
      host: runtime.host,
    },
  });
  return {
    ...runtime,
    ...installation,
  };
}
