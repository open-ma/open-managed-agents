import type {
  ManagedRuntimePlan,
  ManagedRuntimeProfile,
  ManagedRuntimeProviderDriverDescriptor,
  ManagedRuntimeProviderDriverPort,
  ManagedRuntimeProviderPlacement,
  ManagedRuntimeProviderResources,
  RuntimeResourceScope,
} from "@open-managed-agents/runtime-resource-contract";

import {
  ManagedRuntimeCapabilityError,
  resolveManagedRuntimePlan,
} from "./plan";
import { composeSandboxHarnessDrivers } from "./driver-router";
import { SupervisedSandboxHarnessDriver } from "./supervisor-driver";

export interface ManagedRuntimeProviderSelection {
  descriptor: ManagedRuntimeProviderDriverDescriptor;
  plan: ManagedRuntimePlan;
  resources: ManagedRuntimeProviderResources;
}

export interface ManagedRuntimeProviderRegistry {
  descriptors(): readonly ManagedRuntimeProviderDriverDescriptor[];
  prepare(input: {
    provider: string;
    placement: ManagedRuntimeProviderPlacement;
    scope: RuntimeResourceScope;
    profile: ManagedRuntimeProfile;
    providerConfig: Readonly<Record<string, unknown>>;
  }): Promise<ManagedRuntimeProviderSelection>;
}

export function createManagedRuntimeProviderRegistry(input: {
  drivers: readonly ManagedRuntimeProviderDriverPort[];
}): ManagedRuntimeProviderRegistry {
  const drivers = new Map<string, ManagedRuntimeProviderDriverPort>();
  for (const driver of input.drivers) {
    const descriptor = driver.descriptor();
    if (descriptor.provider.length === 0) {
      throw new TypeError("Managed Runtime provider id must not be empty");
    }
    if (drivers.has(descriptor.provider)) {
      throw new Error(`Duplicate Managed Runtime provider: ${descriptor.provider}`);
    }
    drivers.set(descriptor.provider, driver);
  }

  return {
    descriptors() {
      return [...drivers.values()].map((driver) => driver.descriptor());
    },

    async prepare(selection) {
      const driver = drivers.get(selection.provider);
      if (driver === undefined) {
        throw new Error(`Unknown Managed Runtime provider: ${selection.provider}`);
      }
      const descriptor = driver.descriptor();
      if (!descriptor.placements.includes(selection.placement)) {
        throw new ManagedRuntimeCapabilityError(
          `${descriptor.provider} does not support ${selection.placement} placement`,
        );
      }

      const advertisedPlan = resolveManagedRuntimePlan(
        selection.profile,
        descriptor.capabilities,
      );
      if (
        selection.profile.credentialEgress?.requirement === "required"
        && descriptor.credentialEgress.enforcement !== "enforced"
      ) {
        throw new ManagedRuntimeCapabilityError(
          `The selected composition cannot enforce credential egress`,
        );
      }

      const createdResources = await driver.create({
        environmentId: selection.scope.environmentId,
        placement: selection.placement,
        profile: selection.profile,
        plan: advertisedPlan,
        providerConfig: selection.providerConfig,
      });
      const createdHarnessCapabilities = await createdResources.harnessDriver
        .driverCapabilities(selection.scope);
      if (
        descriptor.capabilities.harness.drivers.includes("openma_supervised")
        && !createdHarnessCapabilities.drivers.includes("openma_supervised")
        && createdResources.supervisorTransport === undefined
      ) {
        throw new ManagedRuntimeCapabilityError(
          `${descriptor.provider} advertises openma_supervised without a HarnessSupervisorTransportPort`,
        );
      }
      const resources = createdResources.supervisorTransport === undefined
        || createdHarnessCapabilities.drivers.includes("openma_supervised")
        ? createdResources
        : {
            ...createdResources,
            harnessDriver: composeSandboxHarnessDrivers(
              createdResources.harnessDriver,
              new SupervisedSandboxHarnessDriver({
                transport: createdResources.supervisorTransport,
              }),
            ),
          };
      const [sandbox, workspace, outputs, harness] = await Promise.all([
        resources.sandbox.capabilities(selection.scope),
        resources.workspace.capabilities(selection.scope),
        resources.outputs.capabilities(selection.scope),
        resources.harnessDriver.driverCapabilities(selection.scope),
      ]);
      const plan = resolveManagedRuntimePlan(selection.profile, {
        sandbox,
        workspace,
        outputs,
        harness,
      });
      if (
        plan.workspaceStrategy !== advertisedPlan.workspaceStrategy
        || plan.outputStrategy !== advertisedPlan.outputStrategy
        || plan.runtimeCheckpoint !== advertisedPlan.runtimeCheckpoint
      ) {
        throw new ManagedRuntimeCapabilityError(
          `${descriptor.provider} resource Ports drifted from the advertised capability plan`,
        );
      }
      if (plan.runtimeCheckpoint !== null && resources.runtimeCheckpoint === undefined) {
        throw new ManagedRuntimeCapabilityError(
          `${descriptor.provider} advertises runtime checkpoints without a RuntimeCheckpointPort`,
        );
      }
      if (selection.profile.credentialEgress?.requirement === "required") {
        if (resources.credentialEgress === undefined) {
          throw new ManagedRuntimeCapabilityError(
            `${descriptor.provider} advertises enforced credential egress without a CredentialEgressPort`,
          );
        }
        const actualEgress = await resources.credentialEgress.capabilities(
          selection.scope,
        );
        if (actualEgress.enforcement !== "enforced") {
          throw new ManagedRuntimeCapabilityError(
            `${descriptor.provider} resource Port cannot enforce credential egress`,
          );
        }
      }
      return { descriptor, plan, resources };
    },
  };
}
