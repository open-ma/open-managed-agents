import type {
  ManagedRuntimeProfile,
  ManagedRuntimePlan,
  ManagedSandboxLease,
  ManagedSandboxPort,
  SandboxHarnessDriverPort,
  RuntimeResourceFence,
  RuntimeResourceFencePort,
  RuntimeOrphanPort,
  RuntimeResourceScope,
  RuntimeCheckpointPort,
  RuntimeCheckpointRef,
  SessionOutputBinding,
  SessionOutputManifestCandidate,
  SessionOutputPort,
  WorkspaceBinding,
  WorkspaceCheckpointCandidate,
  WorkspacePersistencePort,
} from "@open-managed-agents/runtime-resource-contract";

import { resolveManagedRuntimePlan } from "./plan";

export interface RuntimeSchedulerPort {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ManagedRuntimeHostDependencies {
  ownerId: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  fences: RuntimeResourceFencePort;
  sandbox: ManagedSandboxPort;
  workspace: WorkspacePersistencePort;
  outputs: SessionOutputPort;
  harnessDriver: SandboxHarnessDriverPort;
  orphans: RuntimeOrphanPort;
  scheduler?: RuntimeSchedulerPort;
  /** Optional provider-owned process/runtime checkpoint implementation. */
  runtimeCheckpoint?: RuntimeCheckpointPort;
}

export type ManagedRuntimeRunResult =
  | { type: "completed"; revision: number }
  | { type: "conflict"; expiresAt: string | null }
  | { type: "lease_lost" }
  | { type: "failed"; error: unknown };

export interface ManagedRuntimeHost {
  run(input: {
    scope: RuntimeResourceScope;
    profile: ManagedRuntimeProfile;
  }): Promise<ManagedRuntimeRunResult>;
}

const defaultScheduler: RuntimeSchedulerPort = {
  sleep(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  },
};

function idempotencyKey(
  scope: RuntimeResourceScope,
  generation: number,
  stage: string,
): string {
  return `${scope.workId}:${generation}:${stage}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkpointIdentity(profile: ManagedRuntimeProfile): {
  harnessVersion: string;
  runtimeIdentity: string;
} {
  if (profile.driver.type === "openma_supervised") {
    return {
      harnessVersion: profile.driver.harness.version,
      runtimeIdentity: stableJson({
        type: profile.driver.type,
        id: profile.driver.harness.id,
        version: profile.driver.harness.version,
        supervisor: profile.driver.supervisor,
      }),
    };
  }
  return {
    harnessVersion: "ama-worker-v1",
    runtimeIdentity: stableJson({ type: profile.driver.type, process: profile.driver.process }),
  };
}

function reusableCheckpoint(
  checkpoint: RuntimeCheckpointRef | null | undefined,
  scope: RuntimeResourceScope,
  fenceGeneration: number,
  kind: NonNullable<ManagedRuntimePlan["runtimeCheckpoint"]>,
  identity: { harnessVersion: string; runtimeIdentity: string },
): checkpoint is RuntimeCheckpointRef {
  return checkpoint !== null
    && checkpoint !== undefined
    && checkpoint.kind === kind
    && checkpoint.sessionId === scope.sessionId
    && checkpoint.workGeneration < fenceGeneration
    && checkpoint.harnessVersion === identity.harnessVersion
    && checkpoint.runtimeIdentity === identity.runtimeIdentity
    && checkpoint.provider.length > 0
    && checkpoint.checkpointId.length > 0
    && checkpoint.sourceRuntimeId.length > 0
    && Number.isSafeInteger(checkpoint.workspaceRevision)
    && Number.isSafeInteger(checkpoint.workGeneration);
}

export function createManagedRuntimeHost(
  dependencies: ManagedRuntimeHostDependencies,
): ManagedRuntimeHost {
  const scheduler = dependencies.scheduler ?? defaultScheduler;

  return {
    async run({ scope, profile }) {
      const [
        sandboxCapabilities,
        workspaceCapabilities,
        outputCapabilities,
        harnessCapabilities,
      ] =
        await Promise.all([
          dependencies.sandbox.capabilities(scope),
          dependencies.workspace.capabilities(scope),
          dependencies.outputs.capabilities(scope),
          dependencies.harnessDriver.driverCapabilities(scope),
        ]);
      const plan = resolveManagedRuntimePlan(profile, {
        sandbox: sandboxCapabilities,
        workspace: workspaceCapabilities,
        outputs: outputCapabilities,
        harness: harnessCapabilities,
      });
      if (plan.runtimeCheckpoint !== null && dependencies.runtimeCheckpoint === undefined) {
        throw new Error(
          `The selected composition advertises ${plan.runtimeCheckpoint} runtime checkpoints but does not provide RuntimeCheckpointPort`,
        );
      }
      const runtimeIdentity = checkpointIdentity(profile);

      const acquired = await dependencies.fences.acquire({
        scope,
        ownerId: dependencies.ownerId,
        ttlMs: dependencies.leaseTtlMs,
      });
      if (acquired.type === "conflict") return acquired;

      let fence: RuntimeResourceFence = acquired.fence;
      let workspaceBinding: WorkspaceBinding | null = null;
      let outputBinding: SessionOutputBinding | null = null;
      let sandboxLease: ManagedSandboxLease | null = null;
      let cleanupReason: "completed" | "failed" | "lease_lost" = "failed";
      let outputPublished = false;
      let runtimeCheckpoint: RuntimeCheckpointRef | null = null;
      let retainedRuntimePublished = false;
      let cleanupPersistenceError: unknown = null;
      const controller = new AbortController();
      let leaseLost = false;
      let monitor: Promise<void> | null = null;

      const loseLease = (reason: string) => {
        leaseLost = true;
        cleanupReason = "lease_lost";
        controller.abort(new Error(reason));
      };

      // Fence ownership starts at acquire, not when the sandbox eventually
      // becomes runnable. Restore, mount and provider allocation may all take
      // longer than one TTL, so renew throughout the complete resource
      // transaction. The sandbox heartbeat joins only after acquire returns.
      monitor = (async () => {
        while (!controller.signal.aborted) {
          await scheduler.sleep(
            dependencies.heartbeatIntervalMs,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const renewed = await dependencies.fences.renew({
            fence,
            ttlMs: dependencies.leaseTtlMs,
          });
          if (renewed.type === "lost") {
            loseLease("Runtime resource fence lost");
            return;
          }
          fence = renewed.fence;
          const activeSandboxLease = sandboxLease;
          if (activeSandboxLease === null) continue;
          const sandboxHeartbeat = await dependencies.sandbox.heartbeat({
            scope,
            fence,
            lease: activeSandboxLease,
          });
          if (sandboxHeartbeat.type === "lost") {
            loseLease("Sandbox lease lost");
            return;
          }
        }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) {
          loseLease(`Runtime heartbeat failed: ${String(error)}`);
        }
      });

      try {
        workspaceBinding = await dependencies.workspace.materialize({
          scope,
          fence,
          strategy: plan.workspaceStrategy,
          activeCheckpoint: acquired.publication?.workspaceCandidate ?? null,
          idempotencyKey: idempotencyKey(
            scope,
            fence.generation,
            "workspace-materialize",
          ),
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (plan.outputStrategy !== null) {
          outputBinding = await dependencies.outputs.prepare({
            scope,
            fence,
            strategy: plan.outputStrategy,
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              "outputs-prepare",
            ),
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }
        const previousRuntimeCheckpoint = acquired.publication?.runtimeCheckpoint;
        if (
          plan.runtimeCheckpoint !== null
          && reusableCheckpoint(
            previousRuntimeCheckpoint,
            scope,
            fence.generation,
            plan.runtimeCheckpoint,
            runtimeIdentity,
          )
        ) {
          try {
            sandboxLease = await dependencies.runtimeCheckpoint!.restore({
              scope,
              fence,
              checkpoint: previousRuntimeCheckpoint,
            });
          } catch {
            // A provider checkpoint is an optimization. The canonical recovery
            // path remains workspace materialization plus a fresh runtime.
            sandboxLease = null;
          }
        }
        if (sandboxLease === null) {
          sandboxLease = await dependencies.sandbox.acquire({
            scope,
            fence,
            plan,
            workspace: workspaceBinding,
            outputs: outputBinding,
            signal: controller.signal,
          });
        }
        controller.signal.throwIfAborted();

        await dependencies.workspace.attach({
          scope,
          fence,
          strategy: plan.workspaceStrategy,
          binding: workspaceBinding,
          sandbox: sandboxLease,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (outputBinding !== null && plan.outputStrategy !== null) {
          await dependencies.outputs.attach({
            scope,
            fence,
            strategy: plan.outputStrategy,
            binding: outputBinding,
            sandbox: sandboxLease,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }

        const execution = await dependencies.harnessDriver.run({
          scope,
          fence,
          sandbox: sandboxLease,
          workspacePath: workspaceBinding.mountPath,
          outputPath: outputBinding?.mountPath ?? null,
          driver: plan.driver,
          signal: controller.signal,
        });
        if (leaseLost || execution.type === "aborted") {
          cleanupReason = "lease_lost";
          return { type: "lease_lost" };
        }

        if (plan.workspaceStrategy === "retained_runtime") {
          sandboxLease = await dependencies.sandbox.suspend({
            scope,
            fence,
            lease: sandboxLease,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }

        const workspaceCandidate: WorkspaceCheckpointCandidate =
          await dependencies.workspace.checkpoint({
            scope,
            fence,
            strategy: plan.workspaceStrategy,
            binding: workspaceBinding,
            sandbox: sandboxLease,
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              "workspace-checkpoint",
            ),
            signal: controller.signal,
          });
        controller.signal.throwIfAborted();
        if (leaseLost) return { type: "lease_lost" };
        if (plan.runtimeCheckpoint !== null) {
          try {
            runtimeCheckpoint = await dependencies.runtimeCheckpoint!.create({
              scope,
              fence,
              sandbox: sandboxLease,
              kind: plan.runtimeCheckpoint,
              workspaceRevision: workspaceCandidate.revision,
              ...runtimeIdentity,
            });
            if (
              runtimeCheckpoint.kind !== plan.runtimeCheckpoint
              || runtimeCheckpoint.provider !== sandboxLease.provider
              || runtimeCheckpoint.sourceRuntimeId !== sandboxLease.runtimeId
              || runtimeCheckpoint.sessionId !== scope.sessionId
              || runtimeCheckpoint.workGeneration !== fence.generation
              || runtimeCheckpoint.harnessVersion !== runtimeIdentity.harnessVersion
              || runtimeCheckpoint.runtimeIdentity !== runtimeIdentity.runtimeIdentity
              || runtimeCheckpoint.workspaceRevision !== workspaceCandidate.revision
            ) {
              throw new Error("RuntimeCheckpointPort returned an incompatible checkpoint ref");
            }
          } catch (error) {
            if (profile.runtimeCheckpoint === "required") throw error;
            runtimeCheckpoint = null;
          }
          controller.signal.throwIfAborted();
        }
        let outputCandidate: SessionOutputManifestCandidate | null = null;
        if (outputBinding !== null && plan.outputStrategy !== null) {
          const entries = await dependencies.outputs.collect({
            scope,
            fence,
            strategy: plan.outputStrategy,
            binding: outputBinding,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          outputCandidate = await dependencies.outputs.finalize({
            scope,
            fence,
            strategy: plan.outputStrategy,
            binding: outputBinding,
            entries,
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              "outputs-finalize",
            ),
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }
        if (leaseLost) return { type: "lease_lost" };
        const published = await dependencies.fences.publish({
          fence,
          workspaceCandidate,
          outputCandidate,
          ...(runtimeCheckpoint === null ? {} : { runtimeCheckpoint }),
        });
        if (published.type === "lost") {
          cleanupReason = "lease_lost";
          return { type: "lease_lost" };
        }
        outputPublished = true;
        retainedRuntimePublished = plan.workspaceStrategy === "retained_runtime";
        cleanupReason = "completed";
        return { type: "completed", revision: published.revision };
      } catch (error) {
        if (leaseLost) return { type: "lease_lost" };
        cleanupReason = "failed";
        return { type: "failed", error };
      } finally {
        controller.abort(new Error("Managed runtime cleanup"));
        await monitor;
        if (sandboxLease !== null && !retainedRuntimePublished) {
          try {
            await dependencies.sandbox.terminate({
              scope,
              fence,
              lease: sandboxLease,
              reason: cleanupReason,
            });
          } catch (error) {
            try {
              await dependencies.orphans.enqueue({
                scope,
                generation: fence.generation,
                ownerId: fence.ownerId,
                sandbox: sandboxLease,
                reason: cleanupReason,
                error:
                  error instanceof Error
                    ? new Error(error.message.replaceAll(fence.token, "[redacted]"))
                    : error,
              });
            } catch (persistenceError) {
              cleanupPersistenceError = persistenceError;
            }
          }
        }
        if (outputBinding !== null) {
          if (outputPublished) {
            await dependencies.outputs
              .release({ scope, fence, binding: outputBinding })
              .catch(() => {});
          } else {
            await dependencies.outputs
              .abort({
                scope,
                fence,
                binding: outputBinding,
                reason: cleanupReason === "lease_lost" ? "lease_lost" : "failed",
              })
              .catch(() => {});
          }
        }
        if (workspaceBinding !== null) {
          await dependencies.workspace
            .release({ scope, fence, binding: workspaceBinding })
            .catch(() => {});
        }
        await dependencies.fences
          .release({ fence, reason: cleanupReason })
          .catch(() => {});
        if (cleanupPersistenceError !== null) throw cleanupPersistenceError;
      }
    },
  };
}
