import type { BetaWebhookEvent } from "@anthropic-ai/sdk/resources/beta/webhooks";
import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";

import type {
  ManagedEnvironmentWorker,
  ManagedEnvironmentWorkerScheduler,
  ManagedEnvironmentWorkerWebhookInput,
  ManagedEnvironmentWorkerWebhookResult,
} from "./environment-worker";

export interface ManagedEnvironmentWorkDispatchDescriptor {
  provider: string;
  version: string;
  strategy: "poll_unacked_then_dispatch";
}

/** Provider control plane that receives a reserved but unacknowledged Work
 * item. The sandbox worker owns ACK/heartbeat/stop and canonical Session IO. */
export interface ManagedEnvironmentWorkDispatchPort {
  descriptor(): ManagedEnvironmentWorkDispatchDescriptor;
  dispatch(input: {
    apiBaseUrl: string;
    environmentKey: string;
    workspaceId: string;
    work: BetaSelfHostedWork;
    signal: AbortSignal;
  }): Promise<void>;
}

interface DispatchedEnvironmentRunnerClient {
  beta: {
    environments: {
      work: {
        poll(
          environmentId: string,
          params: {
            block_ms?: number | null;
            reclaim_older_than_ms?: number | null;
            "Anthropic-Worker-ID"?: string;
          },
          options?: { signal?: AbortSignal },
        ): PromiseLike<BetaSelfHostedWork | null>;
        stop(
          workId: string,
          params: { environment_id: string; force?: boolean },
          options?: { signal?: AbortSignal },
        ): PromiseLike<unknown>;
      };
    };
  };
}

export interface DispatchedManagedEnvironmentWorkerClient {
  baseURL: string;
  beta: {
    webhooks: {
      unwrap(
        body: string,
        options: { headers: Record<string, string>; key?: string },
      ): unknown;
    };
  };
  withOptions(options: {
    apiKey: null;
    authToken: string;
    credentials: null;
    config: null;
    profile: null;
  }): DispatchedEnvironmentRunnerClient;
}

export interface DispatchedManagedEnvironmentWorkerOptions {
  client: DispatchedManagedEnvironmentWorkerClient;
  environmentId: string;
  environmentKey: string;
  workspaceId: string;
  dispatch: ManagedEnvironmentWorkDispatchPort;
  workerId?: string;
  fallbackPollIntervalMs?: number;
  reclaimOlderThanMs?: number;
  webhookKey?: string;
  sandboxApiBaseUrl?: string;
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

function eventIdentity(value: unknown): { eventId: string; type: string; workspaceId: string } {
  if (!isRecord(value) || value.type !== "event" || typeof value.id !== "string") {
    throw new TypeError("Invalid Managed Agents webhook event envelope");
  }
  if (!isRecord(value.data)) {
    throw new TypeError("Invalid Managed Agents webhook event data");
  }
  const type = value.data.type;
  const workspaceId = value.data.workspace_id;
  if (typeof type !== "string" || typeof workspaceId !== "string") {
    throw new TypeError("Invalid Managed Agents webhook event data");
  }
  return { eventId: value.id, type, workspaceId };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

/** Cloudflare/GKE-style controller. Raw Work poll only reserves delivery; it
 * deliberately does not call ACK. The dispatched sandbox worker establishes
 * the official lease and owns every subsequent Work transition. */
export function createDispatchedManagedEnvironmentWorker(
  options: DispatchedManagedEnvironmentWorkerOptions,
): ManagedEnvironmentWorker {
  const scheduler = options.scheduler ?? defaultScheduler;
  const fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(fallbackPollIntervalMs) || fallbackPollIntervalMs <= 0) {
    throw new RangeError("fallbackPollIntervalMs must be a positive integer");
  }
  const runnerClient = options.client.withOptions({
    apiKey: null,
    authToken: options.environmentKey,
    credentials: null,
    config: null,
    profile: null,
  });
  let activeDrain: Promise<void> | null = null;
  let rerunRequested = false;

  const reportError = async (error: unknown) => {
    await options.onError?.(error);
  };

  const drainOnce = async (signal: AbortSignal): Promise<"drained" | "dispatch_failed"> => {
    while (!signal.aborted) {
      const work = await runnerClient.beta.environments.work.poll(
        options.environmentId,
        {
          block_ms: null,
          ...(options.reclaimOlderThanMs === undefined
            ? {}
            : { reclaim_older_than_ms: options.reclaimOlderThanMs }),
          ...(options.workerId === undefined
            ? {}
            : { "Anthropic-Worker-ID": options.workerId }),
        },
        { signal },
      );
      if (work === null) return "drained";
      if (work.data.type !== "session") {
        await runnerClient.beta.environments.work.stop(
          work.id,
          { environment_id: work.environment_id, force: true },
          { signal },
        );
        continue;
      }
      try {
        await options.dispatch.dispatch({
          apiBaseUrl: options.sandboxApiBaseUrl ?? options.client.baseURL,
          environmentKey: options.environmentKey,
          workspaceId: options.workspaceId,
          work,
          signal,
        });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        // Do not ACK or stop. The server-side reservation timeout is the
        // authority that makes this Work available to a replacement.
        await reportError(error);
        return "dispatch_failed";
      }
    }
    return "drained";
  };

  const drain = (
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    rerunRequested = true;
    if (activeDrain !== null) return activeDrain;
    activeDrain = (async () => {
      do {
        rerunRequested = false;
        const outcome = await drainOnce(signal);
        if (outcome === "dispatch_failed") {
          rerunRequested = false;
          break;
        }
      } while (rerunRequested && !signal.aborted);
    })().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
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
      input.waitUntil(drain().catch(reportError));
      return { type: "triggered", eventId: identity.eventId };
    },

    drain,

    async run(signal = new AbortController().signal) {
      try {
        await drain(signal);
        while (!signal.aborted) {
          await scheduler.sleep(fallbackPollIntervalMs, signal);
          await drain(signal);
        }
      } catch (error) {
        if (!isAbort(error, signal)) throw error;
      }
    },
  };
}
