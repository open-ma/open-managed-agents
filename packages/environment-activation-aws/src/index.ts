import type {
  ManagedEnvironmentActivationClaim,
  ManagedEnvironmentActivationInput,
  ManagedEnvironmentActivationIntent,
  ManagedEnvironmentActivationIntentStorePort,
  ManagedEnvironmentActivationPort,
  ManagedEnvironmentActivationReconcileInput,
} from "@open-managed-agents/managed-runtime-host";
import { ExecutionLeaseController } from "@open-managed-agents/execution-control";

export type AwsActivationIntent = ManagedEnvironmentActivationIntent;
export type AwsActivationClaim = ManagedEnvironmentActivationClaim;
export type AwsActivationIntentStorePort = ManagedEnvironmentActivationIntentStorePort;

export interface AwsMicrovmLauncherPort {
  /** Must be idempotent for idempotencyKey. `activationId` is the stable
   * Standard Webhooks event id; `idempotencyKey` also includes the fenced
   * launch generation so a stale launch can never destroy a replacement's VM. */
  launch(input: {
    activationId: string;
    idempotencyKey: string;
    environmentId: string;
    workspaceId: string;
    sessionId: string;
    attempt: number;
    generation: number;
    signal: AbortSignal;
  }): Promise<{ runtimeId: string }>;
  destroy(input: {
    runtimeId: string;
    reason: "activation_fence_lost";
  }): Promise<void>;
}

export interface AwsManagedEnvironmentActivationOptions {
  store: AwsActivationIntentStorePort;
  launcher: AwsMicrovmLauncherPort;
  ownerId: string;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  activationDeadlineMs?: number;
  reconcileBatchSize?: number;
  now?: () => number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** AWS MicroVM activation manager modelled after the provider reference:
 * webhook event idempotency is durable, launch work is leased, failures stay
 * retryable, and a VM created after ownership loss is reaped as an orphan. */
export function createManagedEnvironmentActivationPort(
  factoryOptions: AwsManagedEnvironmentActivationOptions,
): ManagedEnvironmentActivationPort {
  const options = factoryOptions;
  if (typeof options !== "object" || options === null) {
    throw new TypeError("AWS activation options are required");
  }
  if (typeof options.ownerId !== "string" || options.ownerId.trim() === "") {
    throw new TypeError("AWS activation ownerId must not be empty");
  }
  if (typeof options.store?.enqueue !== "function"
    || typeof options.store.claim !== "function"
    || typeof options.store.renew !== "function"
    || typeof options.store.complete !== "function"
    || typeof options.store.retry !== "function") {
    throw new TypeError("AWS activation requires an intent store Port");
  }
  if (typeof options.launcher?.launch !== "function"
    || typeof options.launcher.destroy !== "function") {
    throw new TypeError("AWS activation requires a MicroVM launcher Port");
  }
  const leaseTtlMs = positiveInteger(options.leaseTtlMs ?? 30_000, "leaseTtlMs");
  const retryDelayMs = positiveInteger(options.retryDelayMs ?? 1_000, "retryDelayMs");
  const leaseHeartbeatIntervalMs = positiveInteger(
    options.leaseHeartbeatIntervalMs ?? Math.max(1, Math.floor(leaseTtlMs / 3)),
    "leaseHeartbeatIntervalMs",
  );
  if (leaseHeartbeatIntervalMs >= leaseTtlMs) {
    throw new RangeError("leaseHeartbeatIntervalMs must be less than leaseTtlMs");
  }
  const maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maxAttempts");
  const activationDeadlineMs = positiveInteger(
    options.activationDeadlineMs ?? 10 * 60_000,
    "activationDeadlineMs",
  );
  const reconcileBatchSize = positiveInteger(
    options.reconcileBatchSize ?? 16,
    "reconcileBatchSize",
  );
  const now = options.now ?? Date.now;

  const processClaim = async (claim: AwsActivationClaim): Promise<void> => {
    const lease = new ExecutionLeaseController({
      fence: claim,
      heartbeatIntervalMs: leaseHeartbeatIntervalMs,
      renew: async (current) => {
        const result = await options.store.renew({
          claim: current,
          leaseTtlMs,
        });
        return result.type === "renewed"
          ? { type: "renewed" as const, fence: result.claim }
          : {
              type: "lost" as const,
              reason: new Error(
                `AWS activation lease lost for ${current.intent.eventId}`,
              ),
            };
      },
      leaseExpiresAt: (current) => current.expiresAtMs,
      now,
    });
    const monitoring = lease.start();
    let launched: { runtimeId: string };
    try {
      launched = await options.launcher.launch({
        activationId: claim.intent.eventId,
        idempotencyKey: `${claim.intent.eventId}:${claim.generation}`,
        environmentId: claim.intent.environmentId,
        workspaceId: claim.intent.workspaceId,
        sessionId: claim.intent.sessionId,
        attempt: claim.intent.attemptCount,
        generation: claim.generation,
        signal: lease.signal,
      });
    } catch (error) {
      try {
        await options.store.retry({
          claim: lease.fence,
          nextAttemptAtMs: now() + retryDelayMs,
          error: errorText(error),
        });
      } finally {
        await lease.close();
        await monitoring;
      }
      throw error;
    }

    let committed: { type: "completed" | "lost" };
    try {
      committed = await options.store.complete({
        claim: lease.fence,
        runtimeId: launched.runtimeId,
      });
    } finally {
      await lease.close();
      await monitoring;
    }
    if (committed.type === "completed") return;

    await options.launcher.destroy({
      runtimeId: launched.runtimeId,
      reason: "activation_fence_lost",
    });
    throw new Error(
      `AWS activation fence was lost after launching ${launched.runtimeId}`,
    );
  };

  const claim = async (
    input: Pick<ManagedEnvironmentActivationInput, "environmentId" | "workspaceId">
      & { eventId?: string },
  ) => options.store.claim({
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    ownerId: options.ownerId,
    leaseTtlMs,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
  });

  return {
    descriptor() {
      return {
        provider: "aws-microvm",
        version: "1.0.0",
        strategy: "acquire_then_session_poll",
      };
    },

    async activate(input: ManagedEnvironmentActivationInput) {
      await options.store.enqueue({
        ...input,
        maxAttempts,
        deadlineAtMs: now() + activationDeadlineMs,
      });
      const acquired = await claim(input);
      if (acquired.type === "claimed") await processClaim(acquired.claim);
    },

    async reconcile(input: ManagedEnvironmentActivationReconcileInput) {
      for (let index = 0; index < reconcileBatchSize; index += 1) {
        input.signal.throwIfAborted();
        const acquired = await claim(input);
        if (acquired.type === "empty") return;
        await processClaim(acquired.claim);
      }
    },
  };
}
