import type {
  ManagedRuntimeProviderDriverPort,
  ManagedRuntimeProviderPlacement,
} from "@open-managed-agents/runtime-resource-contract";

import {
  createManagedRuntimeHost,
  type ManagedRuntimeHost,
  type ManagedRuntimeHostDependencies,
} from "./host";
import { createManagedRuntimeProviderRegistry } from "./provider-driver-registry";

export interface ManagedRuntimeProviderHostOptions
  extends Pick<
    ManagedRuntimeHostDependencies,
    | "ownerId"
    | "leaseTtlMs"
    | "heartbeatIntervalMs"
    | "fences"
    | "orphans"
    | "scheduler"
  > {
  driver: ManagedRuntimeProviderDriverPort;
  placement: ManagedRuntimeProviderPlacement;
  /** Environment/operator values interpreted only by the selected driver.
   * SDK clients and installation-level constructor options remain inside the
   * adapter factory that created `driver`. */
  providerConfig: Readonly<Record<string, unknown>>;
}

/** Project one dynamically selected provider driver into the ordinary
 * ManagedRuntimeHost state machine. Capability admission happens before the
 * driver's create hook; provider resources are then fenced and published by
 * exactly the same host logic as preinstalled Node/Cloudflare compositions. */
export function createManagedRuntimeProviderHost(
  options: ManagedRuntimeProviderHostOptions,
): ManagedRuntimeHost {
  const registry = createManagedRuntimeProviderRegistry({
    drivers: [options.driver],
  });
  const provider = options.driver.descriptor().provider;

  return {
    async run(input) {
      const admissionProfile = input.session?.resources.some(
        (resource) => resource.type === "github_repository",
      )
        ? {
            ...input.profile,
            credentialEgress: { requirement: "required" as const },
          }
        : input.profile;
      const selection = await registry.prepare({
        provider,
        placement: options.placement,
        scope: input.scope,
        profile: admissionProfile,
        providerConfig: options.providerConfig,
      });
      const resources = selection.resources;
      const host = createManagedRuntimeHost({
        ownerId: options.ownerId,
        leaseTtlMs: options.leaseTtlMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        fences: options.fences,
        orphans: options.orphans,
        sandbox: resources.sandbox,
        workspace: resources.workspace,
        outputs: resources.outputs,
        harnessDriver: resources.harnessDriver,
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
        ...(resources.runtimeCheckpoint === undefined
          ? {}
          : { runtimeCheckpoint: resources.runtimeCheckpoint }),
        ...(resources.credentialEgress === undefined
          ? {}
          : { credentialEgress: resources.credentialEgress }),
        ...(resources.sessionInputs === undefined
          ? {}
          : { sessionInputs: resources.sessionInputs }),
      });
      return host.run(input);
    },
  };
}
