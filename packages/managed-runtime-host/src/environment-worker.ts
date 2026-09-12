import type { BetaWebhookEvent } from "@anthropic-ai/sdk/resources/beta/webhooks";
import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  ManagedRuntimeProfile,
  RuntimeSessionSnapshot,
} from "@open-managed-agents/runtime-resource-contract";
import { ExecutionLeaseController } from "@open-managed-agents/execution-control";

import type { ManagedRuntimeHost, ManagedRuntimeRunResult } from "./host";

export interface ManagedEnvironmentWorkPoller extends AsyncIterable<BetaSelfHostedWork> {
  readonly signal: AbortSignal;
  abort(): void;
}

export interface ManagedEnvironmentWorkPollerOptions {
  environmentId: string;
  environmentKey: string;
  workerId?: string;
  signal?: AbortSignal;
  autoStop?: boolean;
  drain?: boolean;
  blockMs?: number | null;
  reclaimOlderThanMs?: number | null;
}

export interface ManagedEnvironmentHeartbeatResult {
  last_heartbeat: string;
  lease_extended: boolean;
  state: string;
  ttl_seconds: number;
}

export interface ManagedEnvironmentWorkerRunnerClient {
  beta: {
    environments: {
      work: {
        heartbeat(
          workId: string,
          params: {
            environment_id: string;
            desired_ttl_seconds?: number;
            expected_last_heartbeat?: string;
          },
          options?: { signal?: AbortSignal },
        ): PromiseLike<ManagedEnvironmentHeartbeatResult>;
        stop(
          workId: string,
          params: { environment_id: string; force?: boolean },
          options?: { signal?: AbortSignal },
        ): PromiseLike<unknown>;
      };
    };
    sessions: {
      retrieve(
        sessionId: string,
        params?: object | null,
        options?: { signal?: AbortSignal },
      ): PromiseLike<BetaManagedAgentsSession>;
    };
    files: {
      download(
        fileId: string,
        params?: object | null,
        options?: { signal?: AbortSignal },
      ): PromiseLike<Response>;
    };
    memoryStores: {
      memories: {
        list(
          memoryStoreId: string,
          params: { view: "basic" | "full"; limit: number },
          options?: { signal?: AbortSignal },
        ): AsyncIterable<{
          type: string;
          id?: string;
          path: string;
          content?: string | null;
          content_sha256?: string;
        }>;
        create(
          memoryStoreId: string,
          params: { path: string; content: string },
          options?: { signal?: AbortSignal },
        ): PromiseLike<{
          id: string;
          path: string;
          content?: string | null;
          content_sha256: string;
        }>;
        update(
          memoryId: string,
          params: {
            memory_store_id: string;
            path: string;
            content: string;
            precondition: { type: "content_sha256"; content_sha256: string };
          },
          options?: { signal?: AbortSignal },
        ): PromiseLike<{
          id: string;
          path: string;
          content?: string | null;
          content_sha256: string;
        }>;
        delete(
          memoryId: string,
          params: {
            memory_store_id: string;
            expected_content_sha256: string;
          },
          options?: { signal?: AbortSignal },
        ): PromiseLike<unknown>;
      };
    };
  };
}

/** Structural on purpose: multiple SDK peer-resolution copies remain usable. */
export interface ManagedEnvironmentWorkerClient {
  baseURL: string;
  beta: {
    environments: {
      work: {
        poller(options: ManagedEnvironmentWorkPollerOptions): ManagedEnvironmentWorkPoller;
      };
    };
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
    /** Optional API origin embedded in the claimed Work credential. */
    baseURL?: string;
  }): ManagedEnvironmentWorkerRunnerClient;
}

export interface ManagedEnvironmentWorkerScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ManagedEnvironmentWorkerOptions {
  client: ManagedEnvironmentWorkerClient;
  environmentId: string;
  environmentKey: string;
  workspaceId: string;
  host: ManagedRuntimeHost;
  profileFor(
    work: BetaSelfHostedWork,
    session: BetaManagedAgentsSession,
  ): ManagedRuntimeProfile | Promise<ManagedRuntimeProfile>;
  workerId?: string;
  /** Periodic non-blocking poll used when a webhook is lost. Defaults to 5s. */
  fallbackPollIntervalMs?: number;
  /** Work heartbeat cadence for the supervised lane. Defaults to 30s. */
  heartbeatIntervalMs?: number;
  /** Requested Work heartbeat TTL for the supervised lane. Defaults to 90s. */
  heartbeatTtlSeconds?: number;
  /** Forwarded unchanged to the official WorkPoller. */
  reclaimOlderThanMs?: number;
  /** Overrides the signing key configured on the Anthropic client. */
  webhookKey?: string;
  /** Base URL reachable from inside the sandbox; defaults to client.baseURL. */
  sandboxApiBaseUrl?: string;
  scheduler?: ManagedEnvironmentWorkerScheduler;
  onRunResult?: (
    work: BetaSelfHostedWork,
    result: ManagedRuntimeRunResult,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface ManagedEnvironmentWorkerWebhookInput {
  body: string;
  headers: Record<string, string>;
  /** Cloudflare ctx.waitUntil, Node background task registry, or equivalent. */
  waitUntil(promise: Promise<void>): void;
}

export type ManagedEnvironmentWorkerWebhookResult =
  | { type: "triggered"; eventId: string }
  | { type: "ignored"; eventId: string };

export interface ManagedEnvironmentWorker {
  /** Verify one official Standard Webhooks envelope and schedule a queue drain. */
  handleWebhook(
    input: ManagedEnvironmentWorkerWebhookInput,
  ): ManagedEnvironmentWorkerWebhookResult;
  /** Run one coalesced, non-blocking queue drain. */
  drain(signal?: AbortSignal): Promise<void>;
  /** Poll immediately and then periodically, providing the durable fallback. */
  run(signal?: AbortSignal): Promise<void>;
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

function withClaimedWorkEnvironment(
  profile: ManagedRuntimeProfile,
  input: {
    apiBaseUrl: string;
    environmentKey: string;
    workSecret: string;
    work: BetaSelfHostedWork;
  },
): ManagedRuntimeProfile {
  const process = profile.driver.type === "ama_worker"
    ? profile.driver.process
    : profile.driver.supervisor;
  const env: Record<string, string> = {
    ...process.env,
    ANTHROPIC_BASE_URL: input.apiBaseUrl,
    ANTHROPIC_ENVIRONMENT_ID: input.work.environment_id,
    ANTHROPIC_ENVIRONMENT_KEY: input.environmentKey,
    ANTHROPIC_SESSION_ID: input.work.data.id,
    ANTHROPIC_WORK_ID: input.work.id,
    ANTHROPIC_WORK_SECRET: input.workSecret,
  };
  if (profile.driver.type === "ama_worker") {
    return {
      ...profile,
      driver: {
        ...profile.driver,
        process: { ...profile.driver.process, env },
      },
    };
  }
  return {
    ...profile,
    driver: {
      ...profile.driver,
      supervisor: { ...profile.driver.supervisor, env },
    },
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function hasStatus(error: unknown, status: number): boolean {
  return isRecord(error) && error.status === status;
}

function apiErrorStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number"
    ? error.status
    : undefined;
}

interface ClaimedSessionCredential {
  sessionsToken: string;
  workSecret: string;
  apiBaseUrl?: string;
}

function decodeClaimedSessionCredential(
  work: BetaSelfHostedWork,
): ClaimedSessionCredential {
  if (work.secret == null || work.secret === "") {
    throw new Error(`Session Work ${work.id} has no per-work secret`);
  }
  let decoded: unknown;
  try {
    const base64 = work.secret.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    decoded = JSON.parse(atob(padded));
  } catch (error) {
    throw new Error(`Session Work ${work.id} has an invalid per-work secret`, {
      cause: error,
    });
  }
  if (!isRecord(decoded) || typeof decoded.sessions_token !== "string"
    || decoded.sessions_token === "") {
    throw new Error(`Session Work ${work.id} has no sessions_token`);
  }
  if (decoded.api_base_url !== undefined && typeof decoded.api_base_url !== "string") {
    throw new Error(`Session Work ${work.id} has an invalid api_base_url`);
  }
  return {
    sessionsToken: decoded.sessions_token,
    workSecret: work.secret,
    ...(decoded.api_base_url === undefined
      ? {}
      : { apiBaseUrl: decoded.api_base_url }),
  };
}

function projectClaimedSession(
  session: BetaManagedAgentsSession,
): RuntimeSessionSnapshot {
  return {
    id: session.id,
    environmentId: session.environment_id,
    metadata: { ...session.metadata },
    resources: session.resources.map((resource) => ({ ...resource })),
  };
}

export function createManagedEnvironmentWorker(
  options: ManagedEnvironmentWorkerOptions,
): ManagedEnvironmentWorker {
  const scheduler = options.scheduler ?? defaultScheduler;
  const fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeatTtlSeconds = options.heartbeatTtlSeconds ?? 90;
  if (!Number.isSafeInteger(fallbackPollIntervalMs) || fallbackPollIntervalMs <= 0) {
    throw new RangeError("fallbackPollIntervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new RangeError("heartbeatIntervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(heartbeatTtlSeconds) || heartbeatTtlSeconds <= 0) {
    throw new RangeError("heartbeatTtlSeconds must be a positive integer");
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

  const runWork = async (work: BetaSelfHostedWork, signal: AbortSignal) => {
    // The generated schema allows the healthcheck discriminator to be absent.
    // It has no Session to host, but still needs a terminal lifecycle state.
    if (work.data.type !== "session") {
      await runnerClient.beta.environments.work.stop(work.id, {
        environment_id: work.environment_id,
        force: true,
      });
      return;
    }
    const claim = decodeClaimedSessionCredential(work);
    const sessionClient = options.client.withOptions({
      apiKey: null,
      authToken: claim.sessionsToken,
      credentials: null,
      config: null,
      profile: null,
      ...(claim.apiBaseUrl === undefined ? {} : { baseURL: claim.apiBaseUrl }),
    });
    const session = await sessionClient.beta.sessions.retrieve(
      work.data.id,
      null,
      { signal },
    );
    if (session.id !== work.data.id) {
      throw new Error(
        `Claimed Work ${work.id} returned Session ${session.id}; expected ${work.data.id}`,
      );
    }
    if (session.environment_id !== work.environment_id) {
      throw new Error(
        `Claimed Session ${session.id} belongs to ${session.environment_id}; expected ${work.environment_id}`,
      );
    }
    const declared = await options.profileFor(work, session);
    const profile = withClaimedWorkEnvironment(declared, {
      apiBaseUrl: options.sandboxApiBaseUrl
        ?? claim.apiBaseUrl
        ?? options.client.baseURL,
      environmentKey: options.environmentKey,
      workSecret: claim.workSecret,
      work,
    });
    signal.throwIfAborted();
    const scope = {
      workspaceId: options.workspaceId,
      environmentId: work.environment_id,
      sessionId: work.data.id,
      workId: work.id,
    };
    const sessionInputAccess = {
      async downloadFile(input: { fileId: string; signal: AbortSignal }) {
        const response = await sessionClient.beta.files.download(
          input.fileId,
          null,
          { signal: input.signal },
        );
        const mimeType = response.headers.get("content-type") ?? undefined;
        return {
          content: new Uint8Array(await response.arrayBuffer()),
          ...(mimeType === undefined ? {} : { mimeType }),
        };
      },
      memories: {
        async list(input: {
          memoryStoreId: string;
          projection: "basic" | "full";
          signal: AbortSignal;
        }) {
          const memories: Array<{
            id: string;
            path: string;
            contentSha256: string;
            content?: string;
          }> = [];
          for await (const item of sessionClient.beta.memoryStores.memories.list(
            input.memoryStoreId,
            {
              view: input.projection,
              limit: input.projection === "basic" ? 100 : 20,
            },
            { signal: input.signal },
          )) {
            if (item.type !== "memory") continue;
            if (
              typeof item.id !== "string"
              || typeof item.content_sha256 !== "string"
              || typeof item.path !== "string"
            ) {
              throw new Error("Session Memory API returned an invalid memory record");
            }
            memories.push({
              id: item.id,
              path: item.path,
              contentSha256: item.content_sha256,
              ...(item.content === null || item.content === undefined
                ? {}
                : { content: item.content }),
            });
          }
          return memories;
        },
        async create(input: {
          memoryStoreId: string;
          path: string;
          content: string;
          signal: AbortSignal;
        }) {
          try {
            const item = await sessionClient.beta.memoryStores.memories.create(
              input.memoryStoreId,
              { path: input.path, content: input.content },
              { signal: input.signal },
            );
            return {
              type: "applied" as const,
              memory: {
                id: item.id,
                path: item.path,
                contentSha256: item.content_sha256,
                ...(item.content === null || item.content === undefined
                  ? {}
                  : { content: item.content }),
              },
            };
          } catch (error) {
            if (apiErrorStatus(error) === 409) return { type: "conflict" as const };
            throw error;
          }
        },
        async update(input: {
          memoryStoreId: string;
          memoryId: string;
          path: string;
          content: string;
          expectedContentSha256: string;
          signal: AbortSignal;
        }) {
          try {
            const item = await sessionClient.beta.memoryStores.memories.update(
              input.memoryId,
              {
                memory_store_id: input.memoryStoreId,
                path: input.path,
                content: input.content,
                precondition: {
                  type: "content_sha256",
                  content_sha256: input.expectedContentSha256,
                },
              },
              { signal: input.signal },
            );
            return {
              type: "applied" as const,
              memory: {
                id: item.id,
                path: item.path,
                contentSha256: item.content_sha256,
                ...(item.content === null || item.content === undefined
                  ? {}
                  : { content: item.content }),
              },
            };
          } catch (error) {
            const status = apiErrorStatus(error);
            if (status === 404) return { type: "not_found" as const };
            if (status === 409 || status === 412) return { type: "conflict" as const };
            throw error;
          }
        },
        async delete(input: {
          memoryStoreId: string;
          memoryId: string;
          expectedContentSha256: string;
          signal: AbortSignal;
        }) {
          try {
            await sessionClient.beta.memoryStores.memories.delete(
              input.memoryId,
              {
                memory_store_id: input.memoryStoreId,
                expected_content_sha256: input.expectedContentSha256,
              },
              { signal: input.signal },
            );
            return { type: "applied" as const };
          } catch (error) {
            const status = apiErrorStatus(error);
            if (status === 404) return { type: "not_found" as const };
            if (status === 409 || status === 412) return { type: "conflict" as const };
            throw error;
          }
        },
      },
    };
    if (profile.driver.type === "ama_worker") {
      const result = await options.host.run({
        scope,
        profile,
        session: projectClaimedSession(session),
        sessionInputAccess,
        signal,
      });
      await options.onRunResult?.(work, result);
      return;
    }

    // The OpenMA supervisor does not speak the official Work protocol, so the
    // outer Environment Worker owns that lease without translating the
    // supervisor protocol. A 412 is an authoritative fence loss.
    interface EnvironmentWorkFence {
      lastHeartbeat: string;
      expiresAtMs: number;
    }
    const lease = new ExecutionLeaseController<EnvironmentWorkFence>({
      fence: {
        lastHeartbeat: "NO_HEARTBEAT",
        expiresAtMs: Date.now() + heartbeatTtlSeconds * 1_000,
      },
      heartbeatIntervalMs,
      signal,
      scheduler,
      now: Date.now,
      leaseExpiresAt: (fence) => fence.expiresAtMs,
      onRetry: reportError,
      renew: async (fence, heartbeatSignal) => {
        try {
          const response = await runnerClient.beta.environments.work.heartbeat(
            work.id,
            {
              environment_id: work.environment_id,
              desired_ttl_seconds: heartbeatTtlSeconds,
              expected_last_heartbeat: fence.lastHeartbeat,
            },
            { signal: heartbeatSignal },
          );
          const nextFence = {
            lastHeartbeat: response.last_heartbeat,
            expiresAtMs: Date.now() + response.ttl_seconds * 1_000,
          };
          if (!response.lease_extended || response.state === "stopping" || response.state === "stopped") {
            return {
              type: "renewed" as const,
              fence: nextFence,
              stopRequested: true,
              reason: new Error(`Work entered ${response.state}`),
            };
          }
          return { type: "renewed" as const, fence: nextFence };
        } catch (error) {
          if (heartbeatSignal.aborted) {
            // Local teardown is not evidence that the remote lease was lost.
            return { type: "renewed" as const, fence };
          }
          return hasStatus(error, 412)
            ? { type: "lost" as const, reason: error }
            : { type: "retry" as const, error };
        }
      },
    });
    const heartbeat = lease.start({ immediate: true });
    let result: ManagedRuntimeRunResult;
    try {
      result = await options.host.run({
        scope,
        profile,
        session: projectClaimedSession(session),
        sessionInputAccess,
        signal: lease.signal,
      });
    } finally {
      await lease.close(new Error("Managed runtime finished"));
      await heartbeat;
    }
    await options.onRunResult?.(work, result);
    if (!lease.lost && !lease.stopRequested) {
      await runnerClient.beta.environments.work.stop(work.id, {
        environment_id: work.environment_id,
        force: true,
      });
    }
  };

  const drainOnce = async (
    signal: AbortSignal,
  ): Promise<"drained" | "work_failed"> => {
    const poller = options.client.beta.environments.work.poller({
      environmentId: options.environmentId,
      environmentKey: options.environmentKey,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
      ...(options.reclaimOlderThanMs === undefined
        ? {}
        : { reclaimOlderThanMs: options.reclaimOlderThanMs }),
      autoStop: false,
      blockMs: null,
      drain: true,
      signal,
    });
    for await (const work of poller) {
      try {
        await runWork(work, signal);
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        // Do not stop a failed item here. Its ACK/heartbeat lease is the
        // authority; after it expires another worker may reclaim it. End this
        // activation so a zero/expired TTL cannot make one replica repeatedly
        // reclaim the poison item in a hot loop.
        await reportError(error);
        return "work_failed";
      }
    }
    return "drained";
  };

  const drain = (signal: AbortSignal = new AbortController().signal): Promise<void> => {
    rerunRequested = true;
    if (activeDrain !== null) return activeDrain;
    activeDrain = (async () => {
      do {
        rerunRequested = false;
        const outcome = await drainOnce(signal);
        if (outcome === "work_failed") {
          // A webhook that raced the failure is only a hint. The periodic poll
          // remains the durable retry path and gives another replica a chance.
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
    handleWebhook(input) {
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
      const activation = drain().catch(reportError);
      input.waitUntil(activation);
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
