import type {
  ManagedRuntimePlan,
  ManagedRuntimeProfile,
  ManagedRuntimeResourceCapabilities,
  OutputStrategy,
  RuntimeCheckpointKind,
  WorkspaceStrategy,
} from "@open-managed-agents/runtime-resource-contract";

export class ManagedRuntimeCapabilityError extends Error {
  readonly name = "ManagedRuntimeCapabilityError";
}

const durableWorkspace: readonly WorkspaceStrategy[] = [
  "durable_mount",
  "checkpoint_restore",
];
const continuableWorkspace: readonly WorkspaceStrategy[] = [
  ...durableWorkspace,
  "retained_runtime",
];
const ephemeralWorkspace: readonly WorkspaceStrategy[] = [
  ...continuableWorkspace,
  "ephemeral",
];
const outputPreference: readonly OutputStrategy[] = [
  "durable_mount",
  "watch_and_upload",
  "final_collect",
];
const checkpointPreference: readonly RuntimeCheckpointKind[] = [
  "process",
  "filesystem",
];

function firstAvailable<T extends string>(
  preferred: readonly T[],
  available: readonly T[],
): T | null {
  return preferred.find((candidate) => available.includes(candidate)) ?? null;
}

export function resolveManagedRuntimePlan(
  profile: ManagedRuntimeProfile,
  capabilities: ManagedRuntimeResourceCapabilities,
): ManagedRuntimePlan {
  const eligibleWorkspace =
    profile.workspace.requirement === "durable"
      ? durableWorkspace
      : profile.workspace.requirement === "continuable"
        ? continuableWorkspace
        : ephemeralWorkspace;
  const workspacePreference =
    profile.workspace.preferredStrategies === undefined
      ? eligibleWorkspace
      : profile.workspace.preferredStrategies.filter((strategy) =>
          eligibleWorkspace.includes(strategy),
        );
  const workspaceStrategy = firstAvailable(
    workspacePreference,
    capabilities.workspace.strategies,
  );
  if (workspaceStrategy === null) {
    throw new ManagedRuntimeCapabilityError(
      profile.workspace.requirement === "durable"
        ? "The selected composition cannot provide a durable workspace"
        : `The selected composition cannot provide a ${profile.workspace.requirement} workspace`,
    );
  }

  let outputStrategy: OutputStrategy | null = null;
  if (profile.outputs.requirement !== "disabled") {
    const eligibleOutputCapabilities = capabilities.outputs.strategies
      .filter(
        (capability) =>
          profile.outputs.requirement === "best_effort" ||
          capability.durability === "durable",
      )
      .map((capability) => capability.strategy);
    outputStrategy = firstAvailable(
      profile.outputs.preferredStrategies ?? outputPreference,
      eligibleOutputCapabilities,
    );
    if (outputStrategy === null) {
      throw new ManagedRuntimeCapabilityError(
        `The selected composition cannot provide ${profile.outputs.requirement} Session outputs`,
      );
    }
  }

  const runtimeCheckpoint =
    profile.runtimeCheckpoint === "disabled"
      ? null
      : firstAvailable(
          checkpointPreference,
          capabilities.sandbox.runtimeCheckpoints,
        );
  if (profile.runtimeCheckpoint === "required" && runtimeCheckpoint === null) {
    throw new ManagedRuntimeCapabilityError(
      "The selected composition cannot provide a runtime checkpoint",
    );
  }

  if (!capabilities.harness.drivers.includes(profile.driver.type)) {
    throw new ManagedRuntimeCapabilityError(
      `The selected composition cannot run the ${profile.driver.type} harness driver`,
    );
  }

  return {
    workspaceStrategy,
    outputStrategy,
    runtimeCheckpoint,
    driver: profile.driver,
  };
}
