import type {
  CredentialEgressBinding,
  CredentialEgressPort,
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
  SessionInputAccessPort,
  SessionInputMaterializerPort,
  RuntimeSessionSnapshot,
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
  /** Cadence for materializer-owned writable Memory Stores. Defaults to 15s,
   * matching the official Environment Worker's synchronization interval. */
  sessionInputSyncIntervalMs?: number;
  fences: RuntimeResourceFencePort;
  sandbox: ManagedSandboxPort;
  workspace: WorkspacePersistencePort;
  outputs: SessionOutputPort;
  harnessDriver: SandboxHarnessDriverPort;
  orphans: RuntimeOrphanPort;
  scheduler?: RuntimeSchedulerPort;
  /** Optional provider-owned process/runtime checkpoint implementation. */
  runtimeCheckpoint?: RuntimeCheckpointPort;
  /** Optional OpenMA extension; the official Environment Work shape is unchanged. */
  credentialEgress?: CredentialEgressPort;
  /** Optional stager for official Session resources and application metadata. */
  sessionInputs?: SessionInputMaterializerPort;
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
    /** Session snapshot fetched after claim with the per-work bearer. */
    session?: RuntimeSessionSnapshot;
    /** Ephemeral per-claim content access; never persisted or copied into the
     * runtime environment. */
    sessionInputAccess?: SessionInputAccessPort;
    /** Cancels this generation and prevents canonical publication. */
    signal?: AbortSignal;
  }): Promise<ManagedRuntimeRunResult>;
}

const defaultScheduler: RuntimeSchedulerPort = {
  sleep(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
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
  const processIdentity = (process: {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }) => ({
    command: process.command,
    ...(process.args === undefined ? {} : { args: process.args }),
    ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
    // Environment values commonly contain per-work credentials. Persisting
    // them in checkpoint metadata would be a secret leak; names are enough to
    // reject a materially different process contract.
    envKeys: Object.keys(process.env ?? {}).sort(),
  });
  if (profile.driver.type === "openma_supervised") {
    return {
      harnessVersion: profile.driver.harness.version,
      runtimeIdentity: stableJson({
        type: profile.driver.type,
        id: profile.driver.harness.id,
        version: profile.driver.harness.version,
        supervisor: processIdentity(profile.driver.supervisor),
      }),
    };
  }
  return {
    harnessVersion: "ama-worker-v1",
    runtimeIdentity: stableJson({
      type: profile.driver.type,
      process: processIdentity(profile.driver.process),
    }),
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

function requiresHostSessionInputMaterializer(
  profile: ManagedRuntimeProfile,
  session: RuntimeSessionSnapshot,
): boolean {
  if (session.resources.length === 0) return false;
  if (profile.driver.type === "openma_supervised") return true;

  // The unmodified Anthropic EnvironmentWorker owns memory-store download,
  // mount and final synchronization inside the runtime. File and repository
  // resources (plus any future/unknown discriminator) still belong to the
  // OpenMA host materializer and therefore fail closed when it is absent.
  return session.resources.some((resource) => resource.type !== "memory_store");
}

function requiresRepositoryCredentialEgress(
  session: RuntimeSessionSnapshot | undefined,
): boolean {
  return session?.resources.some(
    (resource) => resource.type === "github_repository",
  ) ?? false;
}

export function createManagedRuntimeHost(
  dependencies: ManagedRuntimeHostDependencies,
): ManagedRuntimeHost {
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const sessionInputSyncIntervalMs = dependencies.sessionInputSyncIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(sessionInputSyncIntervalMs) || sessionInputSyncIntervalMs <= 0) {
    throw new Error("sessionInputSyncIntervalMs must be a positive integer");
  }

  return {
    async run({ scope, profile, session, sessionInputAccess, signal }) {
      if (
        dependencies.sessionInputs === undefined
        && session !== undefined
        && requiresHostSessionInputMaterializer(profile, session)
      ) {
        throw new Error(
          "Session resources require a SessionInputMaterializerPort",
        );
      }
      const credentialEgressRequirement = requiresRepositoryCredentialEgress(session)
        ? "required"
        : profile.credentialEgress?.requirement ?? "disabled";
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
      if (
        credentialEgressRequirement === "required"
        && dependencies.credentialEgress === undefined
      ) {
        throw new Error(
          "Required credential egress is unavailable: this Runtime Host has no CredentialEgressPort",
        );
      }
      if (
        credentialEgressRequirement !== "disabled"
        && dependencies.credentialEgress !== undefined
      ) {
        const capabilities = await dependencies.credentialEgress.capabilities(scope);
        if (
          credentialEgressRequirement === "required"
          && capabilities.enforcement !== "enforced"
        ) {
          throw new Error(
            `This profile requires enforced credential egress, but the provider reports ${capabilities.enforcement}`,
          );
        }
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
      let credentialEgressBinding: CredentialEgressBinding | null = null;
      let sandboxLease: ManagedSandboxLease | null = null;
      let cleanupReason: "completed" | "failed" | "lease_lost" = "failed";
      let outputPublished = false;
      let runtimeCheckpoint: RuntimeCheckpointRef | null = null;
      let retainedRuntimePublished = false;
      let cleanupPersistenceError: unknown = null;
      let publishedOutputCandidate = acquired.publication?.outputCandidate ?? null;
      const committedCheckpointIds = new Set<string>();
      const controller = new AbortController();
      let leaseLost = false;
      let monitor: Promise<void> | null = null;
      let sessionInputSyncAbort: AbortController | null = null;
      let sessionInputSyncLoop: Promise<void> | null = null;
      let sessionInputSyncFailure: unknown = null;
      let sessionInputSyncTail: Promise<void> = Promise.resolve();

      const loseLease = (reason: string) => {
        leaseLost = true;
        cleanupReason = "lease_lost";
        controller.abort(new Error(reason));
      };
      const onExternalAbort = () => loseLease("Managed runtime execution cancelled");
      if (signal?.aborted) onExternalAbort();
      else signal?.addEventListener("abort", onExternalAbort, { once: true });

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
        if (
          credentialEgressRequirement !== "disabled"
          && dependencies.credentialEgress !== undefined
        ) {
          credentialEgressBinding = await dependencies.credentialEgress.prepare({
            scope,
            fence,
            requirement: credentialEgressRequirement,
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              "credential-egress-prepare",
            ),
            signal: controller.signal,
          });
          if (
            credentialEgressRequirement === "required"
            && credentialEgressBinding === null
          ) {
            throw new Error(
              "Required credential egress could not be prepared for this Session",
            );
          }
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
            credentialEgress: credentialEgressBinding,
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
        if (
          credentialEgressBinding !== null
          && dependencies.credentialEgress !== undefined
        ) {
          await dependencies.credentialEgress.attach({
            scope,
            fence,
            binding: credentialEgressBinding,
            sandbox: sandboxLease,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }

        if (dependencies.sessionInputs !== undefined && session !== undefined) {
          await dependencies.sessionInputs.materialize({
            scope,
            fence,
            session,
            workspace: workspaceBinding,
            sandbox: sandboxLease,
            activeWorkspaceCheckpoint:
              acquired.publication?.workspaceCandidate ?? null,
            resourceOwnership: {
              memoryStore: profile.driver.type === "ama_worker"
                ? "worker"
                : "materializer",
            },
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              "session-inputs-materialize",
            ),
            ...(sessionInputAccess === undefined ? {} : { access: sessionInputAccess }),
            authorize: async () => {
              const current = await dependencies.fences.isCurrent(fence);
              if (!current) loseLease("Runtime resource fence lost during Session input materialization");
              return current;
            },
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }

        // Both bindings are established before the harness driver starts. Keep
        // immutable references for the callback so its protocol contract does
        // not inherit nullable setup/cleanup bookkeeping.
        const activeWorkspace = workspaceBinding;
        const activeSandbox = sandboxLease;
        const sessionInputOwnership = {
          memoryStore: profile.driver.type === "ama_worker"
            ? "worker" as const
            : "materializer" as const,
        };
        const synchronizeSessionInputs = async (stage: string): Promise<void> => {
          if (dependencies.sessionInputs === undefined || session === undefined) return;
          const operation = sessionInputSyncTail.then(async () => {
            await dependencies.sessionInputs!.synchronize({
              scope,
              fence,
              session,
              sandbox: activeSandbox,
              resourceOwnership: sessionInputOwnership,
              idempotencyKey: idempotencyKey(
                scope,
                fence.generation,
                `session-inputs-synchronize-${stage}`,
              ),
              authorize: async () => {
                const current = await dependencies.fences.isCurrent(fence);
                if (!current) loseLease("Runtime resource fence lost during Session input synchronization");
                return current;
              },
              ...(sessionInputAccess === undefined ? {} : { access: sessionInputAccess }),
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
          });
          sessionInputSyncTail = operation.catch(() => {});
          await operation;
        };
        const needsPeriodicSessionInputSync =
          sessionInputOwnership.memoryStore === "materializer"
          && session?.resources.some((resource) =>
            resource.type === "memory_store" && resource.access !== "read_only") === true;
        if (needsPeriodicSessionInputSync) {
          sessionInputSyncAbort = new AbortController();
          const periodicAbort = sessionInputSyncAbort;
          const abortPeriodic = () => periodicAbort.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", abortPeriodic, { once: true });
          sessionInputSyncLoop = (async () => {
            let sequence = 0;
            try {
              while (!periodicAbort.signal.aborted) {
                await scheduler.sleep(sessionInputSyncIntervalMs, periodicAbort.signal);
                if (periodicAbort.signal.aborted) return;
                sequence += 1;
                await synchronizeSessionInputs(`periodic-${sequence}`);
              }
            } catch (error) {
              if (periodicAbort.signal.aborted) return;
              sessionInputSyncFailure = error;
              controller.abort(error);
            } finally {
              controller.signal.removeEventListener("abort", abortPeriodic);
            }
          })();
        }
        const checkpointLiveTurn = async (input: {
          checkpointId: string;
          sessionId: string;
          turnId?: string;
        }): Promise<void> => {
          if (
            input.checkpointId.length === 0
            || input.sessionId !== scope.sessionId
            || committedCheckpointIds.has(input.checkpointId)
          ) {
            throw new Error("Harness requested an invalid or duplicate live checkpoint");
          }
          controller.signal.throwIfAborted();
          await synchronizeSessionInputs(`checkpoint-${input.checkpointId}`);
          const workspaceCandidate = await dependencies.workspace.checkpoint({
            scope,
            fence,
            strategy: plan.workspaceStrategy,
            binding: activeWorkspace,
            sandbox: activeSandbox,
            idempotencyKey: idempotencyKey(
              scope,
              fence.generation,
              `workspace-checkpoint-${input.checkpointId}`,
            ),
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          // outputBinding can only be produced by the guarded prepare step
          // above, so its presence proves the planned strategy exists.
          if (outputBinding !== null) {
            const outputStrategy = plan.outputStrategy!;
            const entries = await dependencies.outputs.collect({
              scope,
              fence,
              strategy: outputStrategy,
              binding: outputBinding,
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            publishedOutputCandidate = await dependencies.outputs.finalize({
              scope,
              fence,
              strategy: outputStrategy,
              binding: outputBinding,
              entries,
              idempotencyKey: idempotencyKey(
                scope,
                fence.generation,
                `outputs-finalize-${input.checkpointId}`,
              ),
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
          }
          const published = await dependencies.fences.publish({
            fence,
            workspaceCandidate,
            outputCandidate: publishedOutputCandidate,
            runtimeCheckpoint: null,
          });
          if (published.type === "lost") {
            loseLease("Runtime resource fence lost during live checkpoint");
            throw new Error("Runtime resource fence lost during live checkpoint");
          }
          committedCheckpointIds.add(input.checkpointId);
          outputPublished = outputBinding !== null;
        };

        const execution = await dependencies.harnessDriver.run({
          scope,
          fence,
          sandbox: sandboxLease,
          workspacePath: workspaceBinding.mountPath,
          outputPath: outputBinding?.mountPath ?? null,
          driver: plan.driver,
          checkpoint: checkpointLiveTurn,
          signal: controller.signal,
        });
        sessionInputSyncAbort?.abort(new Error("Managed runtime harness settled"));
        await sessionInputSyncLoop;
        await sessionInputSyncTail;
        if (leaseLost) {
          cleanupReason = "lease_lost";
          return { type: "lease_lost" };
        }
        if (sessionInputSyncFailure !== null) throw sessionInputSyncFailure;
        if (execution.type === "aborted") {
          cleanupReason = "lease_lost";
          return { type: "lease_lost" };
        }

        await synchronizeSessionInputs("final");

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
          publishedOutputCandidate = outputCandidate;
        }
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
        signal?.removeEventListener("abort", onExternalAbort);
        sessionInputSyncAbort?.abort(new Error("Managed runtime cleanup"));
        await sessionInputSyncLoop;
        await sessionInputSyncTail;
        controller.abort(new Error("Managed runtime cleanup"));
        if (
          credentialEgressBinding !== null
          && dependencies.credentialEgress !== undefined
        ) {
          try {
            await dependencies.credentialEgress.revoke({
              scope,
              fence,
              binding: credentialEgressBinding,
              reason: cleanupReason,
            });
          } catch (error) {
            // Provider-native snapshot grants cannot be left attached to a
            // retained runtime. Force termination and surface the cleanup
            // failure after the remaining resources have been released.
            retainedRuntimePublished = false;
            cleanupPersistenceError = error;
          }
        }
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
        if (
          credentialEgressBinding !== null
          && dependencies.credentialEgress !== undefined
        ) {
          await dependencies.credentialEgress
            .release({ scope, fence, binding: credentialEgressBinding })
            .catch((error: unknown) => {
              cleanupPersistenceError ??= error;
            });
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
