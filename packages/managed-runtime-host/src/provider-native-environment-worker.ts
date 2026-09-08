import type { BetaWebhookEvent } from "@anthropic-ai/sdk/resources/beta/webhooks";

import type {
  ManagedEnvironmentWorker,
  ManagedEnvironmentWorkerScheduler,
  ManagedEnvironmentWorkerWebhookInput,
  ManagedEnvironmentWorkerWebhookResult,
} from "./environment-worker";

export interface ManagedEnvironmentActivationInput {
  /** Stable official webhook event id. Provider adapters must use this as the
   * idempotency key before launching compute. */
  eventId: string;
  environmentId: string;
  sessionId: string;
  workspaceId: string;
}

export interface ManagedEnvironmentActivationReconcileInput {
  environmentId: string;
  workspaceId: string;
  signal: AbortSignal;
}

export interface ManagedEnvironmentActivationIntent
  extends ManagedEnvironmentActivationInput {
  attemptCount: number;
  maxAttempts: number;
  deadlineAtMs: number;
  nextAttemptAtMs: number;
}

export interface ManagedEnvironmentActivationClaim {
  intent: ManagedEnvironmentActivationIntent;
  ownerId: string;
  generation: number;
  token: string;
  expiresAtMs: number;
}

/** Durable, provider-neutral queue for runtimes that must launch before Work
 * claim. Implementations must make claim/complete/retry atomic CAS operations. */
export interface ManagedEnvironmentActivationIntentStorePort {
  enqueue(
    intent: Omit<
      ManagedEnvironmentActivationIntent,
      "attemptCount" | "nextAttemptAtMs"
    >,
  ): Promise<{ type: "inserted" } | { type: "existing" }>;
  claim(input: {
    environmentId: string;
    workspaceId: string;
    ownerId: string;
    leaseTtlMs: number;
    eventId?: string;
  }): Promise<
    | { type: "claimed"; claim: ManagedEnvironmentActivationClaim }
    | { type: "empty" }
  >;
  renew(input: {
    claim: ManagedEnvironmentActivationClaim;
    leaseTtlMs: number;
  }): Promise<
    | { type: "renewed"; claim: ManagedEnvironmentActivationClaim }
    | { type: "lost" }
  >;
  complete(input: {
    claim: ManagedEnvironmentActivationClaim;
    runtimeId: string;
  }): Promise<{ type: "completed" } | { type: "lost" }>;
  retry(input: {
    claim: ManagedEnvironmentActivationClaim;
    nextAttemptAtMs: number;
    error: string;
  }): Promise<{ type: "released" | "exhausted" } | { type: "lost" }>;
}

export interface ManagedEnvironmentActivationDescriptor {
  provider: string;
  version: string;
  /** The provider runtime starts before its in-runtime worker claims the
   * Session Work item. */
  strategy: "acquire_then_session_poll";
}

/** Provider-native launch boundary for runtimes that must exist before their
 * in-runtime worker can claim Session Work. Implementations durably record an
 * activation intent before side effects, fence duplicate launches by event id
 * and reconcile unfinished intents after webhook loss or process failure. */
export interface ManagedEnvironmentActivationPort {
  descriptor(): ManagedEnvironmentActivationDescriptor;
  activate(input: ManagedEnvironmentActivationInput): Promise<void>;
  reconcile(input: ManagedEnvironmentActivationReconcileInput): Promise<void>;
}

export interface ManagedEnvironmentWebhookVerificationClient {
  beta: {
    webhooks: {
      unwrap(
        body: string,
        options: { headers: Record<string, string>; key?: string },
      ): unknown;
    };
  };
}

export interface ProviderNativeManagedEnvironmentWorkerOptions {
  client: ManagedEnvironmentWebhookVerificationClient;
  environmentId: string;
  workspaceId: string;
  activation: ManagedEnvironmentActivationPort;
  /** Reconciles durable provider launch intents; this deliberately does not
   * poll or claim Managed Agents Work. Defaults to 5 seconds. */
  fallbackReconcileIntervalMs?: number;
  /** Overrides the signing key configured on the Anthropic client. */
  webhookKey?: string;
  scheduler?: ManagedEnvironmentWorkerScheduler;
  onError?: (error: unknown) => void | Promise<void>;
}

const defaultScheduler: ManagedEnvironmentWorkerScheduler = {
  sleep(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(signal.reason);
      }, { once: true });
    });
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventIdentity(value: unknown): {
  eventId: string;
  sessionId: string;
  type: string;
  workspaceId: string;
} {
  if (!isRecord(value) || value.type !== "event" || typeof value.id !== "string") {
    throw new TypeError("Invalid Managed Agents webhook event envelope");
  }
  if (!isRecord(value.data)) {
    throw new TypeError("Invalid Managed Agents webhook event data");
  }
  const sessionId = value.data.id;
  const type = value.data.type;
  const workspaceId = value.data.workspace_id;
  if (
    typeof sessionId !== "string"
    || sessionId === ""
    || typeof type !== "string"
    || typeof workspaceId !== "string"
  ) {
    throw new TypeError("Invalid Managed Agents webhook event data");
  }
  return { eventId: value.id, sessionId, type, workspaceId };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

/** Build the AWS-style provider-native lane: the signed Session webhook starts
 * provider compute, then the worker inside that runtime claims the matching
 * Work. The official Work API remains untouched and is never claimed here. */
export function createProviderNativeManagedEnvironmentWorker(
  options: ProviderNativeManagedEnvironmentWorkerOptions,
): ManagedEnvironmentWorker {
  const scheduler = options.scheduler ?? defaultScheduler;
  const fallbackReconcileIntervalMs = options.fallbackReconcileIntervalMs ?? 5_000;
  if (
    !Number.isSafeInteger(fallbackReconcileIntervalMs)
    || fallbackReconcileIntervalMs <= 0
  ) {
    throw new RangeError("fallbackReconcileIntervalMs must be a positive integer");
  }
  let activeReconcile: Promise<void> | null = null;
  let rerunRequested = false;

  const reportError = async (error: unknown) => {
    await options.onError?.(error);
  };

  const reconcile = (
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    rerunRequested = true;
    if (activeReconcile !== null) return activeReconcile;
    activeReconcile = (async () => {
      do {
        rerunRequested = false;
        signal.throwIfAborted();
        await options.activation.reconcile({
          environmentId: options.environmentId,
          workspaceId: options.workspaceId,
          signal,
        });
      } while (rerunRequested && !signal.aborted);
    })().finally(() => {
      activeReconcile = null;
    });
    return activeReconcile;
  };

  return {
    handleWebhook(
      input: ManagedEnvironmentWorkerWebhookInput,
    ): ManagedEnvironmentWorkerWebhookResult {
      const event = options.client.beta.webhooks.unwrap(input.body, {
        headers: input.headers,
        ...(options.webhookKey === undefined ? {} : { key: options.webhookKey }),
      }) as BetaWebhookEvent;
      const identity = eventIdentity(event);
      if (
        identity.type !== "session.status_run_started"
        || identity.workspaceId !== options.workspaceId
      ) {
        return { type: "ignored", eventId: identity.eventId };
      }
      const activation = options.activation.activate({
        eventId: identity.eventId,
        environmentId: options.environmentId,
        sessionId: identity.sessionId,
        workspaceId: identity.workspaceId,
      }).catch(reportError);
      input.waitUntil(activation);
      return { type: "triggered", eventId: identity.eventId };
    },

    drain: reconcile,

    async run(signal = new AbortController().signal) {
      try {
        await reconcile(signal);
        while (!signal.aborted) {
          await scheduler.sleep(fallbackReconcileIntervalMs, signal);
          if (!signal.aborted) await reconcile(signal);
        }
      } catch (error) {
        if (!isAbort(error, signal)) throw error;
      }
    },
  };
}
