import Anthropic from "@anthropic-ai/sdk";
import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedEnvironmentWorker,
  type ManagedEnvironmentWorkerClient,
  type ManagedRuntimeHost,
  type ManagedRuntimeProfile,
  type ManagedRuntimeRunResult,
} from "../src/index";

const WEBHOOK_SECRET = `whsec_${Buffer.from("official-webhook-secret").toString("base64")}`;

const queuedWork: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-06T04:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: {},
  secret: Buffer.from(JSON.stringify({ sessions_token: "session-token" }))
    .toString("base64url"),
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

const startingWork: BetaSelfHostedWork = {
  ...queuedWork,
  acknowledged_at: "2026-09-06T04:00:01.000Z",
  started_at: "2026-09-06T04:00:01.000Z",
  state: "starting",
};

const sessionSnapshot = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcp_servers: [],
    model: { id: "claude-sonnet-4-6", speed: "standard" },
    multiagent: null,
    name: "Metadata staging fixture",
    skills: [],
    system: null,
    tools: [],
    type: "agent",
    version: 1,
  },
  archived_at: null,
  budget: null,
  created_at: "2026-09-06T04:00:00.000Z",
  environment_id: "env_01",
  metadata: {
    input_file: "s3://fixture-bucket/input.csv",
    commit_sha: "0123456789abcdef",
  },
  outcome_evaluations: [],
  resources: [
    {
      id: "sesrsc_file_01",
      created_at: "2026-09-06T04:00:00.000Z",
      file_id: "file_01",
      mount_path: "/workspace/input.csv",
      type: "file",
      updated_at: "2026-09-06T04:00:00.000Z",
    },
    {
      id: "sesrsc_repo_01",
      checkout: { type: "commit", sha: "0123456789abcdef" },
      created_at: "2026-09-06T04:00:00.000Z",
      mount_path: "/workspace",
      type: "github_repository",
      updated_at: "2026-09-06T04:00:00.000Z",
      url: "https://github.com/openma-ai/example.git",
    },
  ],
  stats: {},
  status: "running",
  title: "Metadata staging fixture",
  type: "session",
  updated_at: "2026-09-06T04:00:01.000Z",
  usage: {},
  vault_ids: [],
} as BetaManagedAgentsSession;

const profile: ManagedRuntimeProfile = {
  workspace: { requirement: "ephemeral" },
  outputs: { requirement: "disabled" },
  runtimeCheckpoint: "disabled",
  driver: {
    type: "ama_worker",
    process: {
      command: "node",
      args: ["worker.mjs"],
      env: { CUSTOM: "kept", ANTHROPIC_WORK_ID: "must-be-overridden" },
    },
  },
};

const supervisedProfile: ManagedRuntimeProfile = {
  ...profile,
  driver: {
    type: "openma_supervised",
    protocol: "openma-harness-supervisor-v1",
    supervisor: { command: "openma-supervisor" },
    harness: { id: "pi", version: "1" },
    readyTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    drainTimeoutMs: 1_000,
  },
};

function officialRunStartedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "event" as const,
    id: "event_01",
    created_at: "2026-09-06T04:00:00.000Z",
    data: {
      type: "session.status_run_started" as const,
      id: "session_01",
      organization_id: "org_01",
      workspace_id: "workspace_01",
    },
    ...overrides,
  };
}

function signedWebhook(event: object) {
  const body = JSON.stringify(event);
  const id = "msg_01";
  const timestamp = new Date();
  const webhook = new Webhook(WEBHOOK_SECRET);
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": webhook.sign(id, timestamp, body),
    },
  };
}

function apiHarness() {
  let available = true;
  const requests: Array<{
    authorization: string | null;
    method: string;
    path: string;
    workerId: string | null;
    xApiKey: string | null;
  }> = [];
  const client = new Anthropic({
    apiKey: "parent-key-must-not-leak",
    baseURL: "http://openma.test",
    webhookKey: WEBHOOK_SECRET,
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      const path = new URL(request.url).pathname;
      requests.push({
        authorization: request.headers.get("authorization"),
        method: request.method,
        path,
        workerId: request.headers.get("anthropic-worker-id"),
        xApiKey: request.headers.get("x-api-key"),
      });
      if (path.endsWith("/work/poll")) {
        if (!available) return Response.json(null);
        available = false;
        return Response.json(queuedWork);
      }
      if (path.endsWith("/ack")) return Response.json(startingWork);
      if (path === "/v1/sessions/session_01") return Response.json(sessionSnapshot);
      if (path === "/v1/files/file_01/content") {
        return new Response(new Uint8Array([0, 255, 1]), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    },
  });
  return { client, requests };
}

function hostHarness() {
  const runs: Parameters<ManagedRuntimeHost["run"]>[0][] = [];
  const host: ManagedRuntimeHost = {
    async run(input) {
      runs.push(input);
      return { type: "completed", revision: 1 };
    },
  };
  return { host, runs };
}

function structuralClient(input: {
  work?: BetaSelfHostedWork | null;
  session?: BetaManagedAgentsSession;
  webhookEvent?: unknown;
  download?: Response;
  heartbeat?: (input: {
    workId: string;
    params: unknown;
    options: { signal?: AbortSignal } | undefined;
  }) => Promise<{
    last_heartbeat: string;
    lease_extended: boolean;
    state: string;
    ttl_seconds: number;
  }>;
} = {}) {
  let work = input.work === undefined ? queuedWork : input.work;
  const pollerOptions: unknown[] = [];
  const clientOptions: unknown[] = [];
  const stops: unknown[] = [];
  const downloads: unknown[] = [];
  const heartbeats: unknown[] = [];
  const unwrapOptions: unknown[] = [];
  const runner = {
    beta: {
      environments: {
        work: {
          async heartbeat(
            workId: string,
            params: unknown,
            options: { signal?: AbortSignal } | undefined,
          ) {
            heartbeats.push({ workId, params, options });
            return input.heartbeat?.({ workId, params, options }) ?? {
              last_heartbeat: "2026-09-06T04:00:02.000Z",
              lease_extended: true,
              state: "active",
              ttl_seconds: 90,
            };
          },
          async stop(workId: string, params: unknown, options: unknown) {
            stops.push({ workId, params, options });
          },
        },
      },
      sessions: {
        async retrieve() {
          return input.session ?? sessionSnapshot;
        },
      },
      files: {
        async download(fileId: string, params: unknown, options: unknown) {
          downloads.push({ fileId, params, options });
          return input.download ?? new Response(new Uint8Array([1]));
        },
      },
    },
  };
  const client: ManagedEnvironmentWorkerClient = {
    baseURL: "https://control.example",
    beta: {
      environments: {
        work: {
          poller(options) {
            pollerOptions.push(options);
            const claimed = work;
            work = null;
            return {
              signal: options.signal ?? new AbortController().signal,
              abort() {},
              async *[Symbol.asyncIterator]() {
                if (claimed !== null) yield claimed;
              },
            };
          },
        },
      },
      webhooks: {
        unwrap(_body, options) {
          unwrapOptions.push(options);
          return "webhookEvent" in input
            ? input.webhookEvent
            : officialRunStartedEvent();
        },
      },
    },
    withOptions(options) {
      clientOptions.push(options);
      return runner;
    },
  };
  return {
    client,
    clientOptions,
    downloads,
    heartbeats,
    pollerOptions,
    stops,
    unwrapOptions,
  };
}

describe("managed Environment Worker activation", () => {
  it.each([
    ["fallbackPollIntervalMs", 0],
    ["fallbackPollIntervalMs", 1.5],
    ["heartbeatIntervalMs", 0],
    ["heartbeatIntervalMs", 1.5],
    ["heartbeatTtlSeconds", 0],
    ["heartbeatTtlSeconds", 1.5],
  ] as const)("rejects invalid %s=%s before constructing clients", (field, value) => {
    const { client, clientOptions } = structuralClient({ work: null });
    expect(() => createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: hostHarness().host,
      profileFor: async () => profile,
      [field]: value,
    })).toThrow(/positive integer/u);
    expect(clientOptions).toEqual([]);
  });

  it.each([
    null,
    [],
    {},
    { type: "other", id: "event_01", data: {} },
    { type: "event", id: 1, data: {} },
    { type: "event", id: "event_01", data: null },
    { type: "event", id: "event_01", data: [] },
    { type: "event", id: "event_01", data: {} },
    { type: "event", id: "event_01", data: { type: 1, workspace_id: "workspace_01" } },
    { type: "event", id: "event_01", data: { type: "session.created", workspace_id: 1 } },
  ])("rejects malformed webhook event %# before scheduling work", (webhookEvent) => {
    const { client } = structuralClient({ work: null, webhookEvent });
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: hostHarness().host,
      profileFor: async () => profile,
    });
    expect(() => worker.handleWebhook({
      body: "{}",
      headers: {},
      waitUntil: () => { throw new Error("must not schedule"); },
    })).toThrow(/Invalid Managed Agents webhook event/u);
  });

  it.each([
    [null, /no per-work secret/u],
    ["", /no per-work secret/u],
    ["not-json", /invalid per-work secret/u],
    [Buffer.from("null").toString("base64url"), /no sessions_token/u],
    [Buffer.from(JSON.stringify({ sessions_token: 1 })).toString("base64url"), /no sessions_token/u],
    [Buffer.from(JSON.stringify({ sessions_token: "" })).toString("base64url"), /no sessions_token/u],
    [Buffer.from(JSON.stringify({ sessions_token: "token", api_base_url: 1 })).toString("base64url"), /invalid api_base_url/u],
  ])("fails a Session Work with invalid credential %j without starting the host", async (secret, message) => {
    const badWork = { ...queuedWork, secret } as BetaSelfHostedWork;
    const { client } = structuralClient({ work: badWork });
    const { host, runs } = hostHarness();
    const errors: unknown[] = [];
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host,
      profileFor: async () => profile,
      onError: (error) => { errors.push(error); },
    });
    await worker.drain();
    expect(runs).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ message: expect.stringMatching(message) })]);
  });

  it("uses the claimed API origin, optional poll controls, and preserves a missing MIME type", async () => {
    const work = {
      ...queuedWork,
      secret: Buffer.from(JSON.stringify({
        sessions_token: "session-token",
        api_base_url: "https://claim.example",
      })).toString("base64url"),
    };
    const { client, clientOptions, pollerOptions } = structuralClient({ work });
    const { host, runs } = hostHarness();
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      reclaimOlderThanMs: 123,
      sandboxApiBaseUrl: "https://sandbox-gateway.example",
      host,
      profileFor: async () => profile,
    });
    await worker.drain();
    expect(pollerOptions).toEqual([expect.objectContaining({ reclaimOlderThanMs: 123 })]);
    expect(clientOptions).toContainEqual(expect.objectContaining({
      authToken: "session-token",
      baseURL: "https://claim.example",
    }));
    expect(runs[0]?.profile.driver).toMatchObject({
      process: { env: { ANTHROPIC_BASE_URL: "https://sandbox-gateway.example" } },
    });
    const access = Reflect.get(runs[0]!, "sessionInputAccess") as {
      downloadFile(input: { fileId: string; signal: AbortSignal }): Promise<unknown>;
    };
    await expect(access.downloadFile({
      fileId: "file_01",
      signal: new AbortController().signal,
    })).resolves.toEqual({ content: new Uint8Array([1]) });
  });

  it("force-stops non-Session healthcheck work without constructing a Session", async () => {
    const healthcheck = {
      ...queuedWork,
      data: { type: "healthcheck" },
      secret: null,
    } as unknown as BetaSelfHostedWork;
    const { client, stops } = structuralClient({ work: healthcheck });
    const { host, runs } = hostHarness();
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host,
      profileFor: async () => profile,
    });
    await worker.drain();
    expect(runs).toEqual([]);
    expect(stops).toEqual([expect.objectContaining({
      workId: "work_01",
      params: { environment_id: "env_01", force: true },
    })]);
  });

  it.each([
    [{ ...sessionSnapshot, id: "session_other" }, /expected session_01/u],
    [{ ...sessionSnapshot, environment_id: "env_other" }, /expected env_01/u],
  ] as const)("rejects a claimed Session identity mismatch", async (session, message) => {
    const { client } = structuralClient({ session: session as BetaManagedAgentsSession });
    const errors: unknown[] = [];
    const { host, runs } = hostHarness();
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host,
      profileFor: async () => profile,
      onError: (error) => { errors.push(error); },
    });
    await worker.drain();
    expect(runs).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ message: expect.stringMatching(message) })]);
  });
  it("uses the official signed webhook only as a wake-up, then claims with the official WorkPoller", async () => {
    const { client, requests } = apiHarness();
    const { host, runs } = hostHarness();
    let profileSession: BetaManagedAgentsSession | undefined;
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      workerId: "worker_01",
      host,
      profileFor: async (_work, session) => {
        profileSession = session;
        return profile;
      },
    });
    const scheduled: Promise<void>[] = [];

    const result = worker.handleWebhook({
      ...signedWebhook(officialRunStartedEvent()),
      waitUntil: (promise) => scheduled.push(promise),
    });

    expect(result).toEqual({ type: "triggered", eventId: "event_01" });
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/environments/env_01/work/poll",
      "POST /v1/environments/env_01/work/work_01/ack",
      "GET /v1/sessions/session_01",
      "GET /v1/environments/env_01/work/poll",
    ]);
    for (const request of requests.filter(({ path }) => !path.startsWith("/v1/sessions/"))) {
      expect(request.authorization).toBe("Bearer environment-key");
      expect(request.xApiKey).toBeNull();
    }
    expect(requests.find(({ path }) => path === "/v1/sessions/session_01"))
      .toMatchObject({
        authorization: "Bearer session-token",
        method: "GET",
        xApiKey: null,
      });
    expect(requests.filter(({ path }) => path.endsWith("/work/poll")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ workerId: "worker_01" }),
      ]));
    expect(requests.find(({ path }) => path.endsWith("/ack"))?.workerId).toBeNull();
    expect(runs).toHaveLength(1);
    expect(profileSession).toEqual(sessionSnapshot);
    expect(runs[0]?.session).toEqual({
      id: "session_01",
      environmentId: "env_01",
      metadata: sessionSnapshot.metadata,
      resources: sessionSnapshot.resources,
    });
    expect(runs[0]?.scope).toEqual({
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workId: "work_01",
    });
    const sessionInputAccess = Reflect.get(runs[0]!, "sessionInputAccess") as {
      downloadFile(input: { fileId: string; signal: AbortSignal }): Promise<{
        content: Uint8Array;
        mimeType?: string;
      }>;
    } | undefined;
    expect(sessionInputAccess).toBeDefined();
    await expect(sessionInputAccess!.downloadFile({
      fileId: "file_01",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      content: new Uint8Array([0, 255, 1]),
      mimeType: "application/octet-stream",
    });
    expect(requests.find(({ path }) => path === "/v1/files/file_01/content"))
      .toMatchObject({ authorization: "Bearer session-token", xApiKey: null });
    expect(runs[0]?.profile.driver).toEqual({
      type: "ama_worker",
      process: expect.objectContaining({
        env: {
          CUSTOM: "kept",
          ANTHROPIC_BASE_URL: "http://openma.test",
          ANTHROPIC_ENVIRONMENT_ID: "env_01",
          ANTHROPIC_ENVIRONMENT_KEY: "environment-key",
          ANTHROPIC_SESSION_ID: "session_01",
          ANTHROPIC_WORK_ID: "work_01",
          ANTHROPIC_WORK_SECRET: queuedWork.secret,
        },
      }),
    });
  });

  it("does not start a runtime when the claimed Session cannot be retrieved", async () => {
    let available = true;
    let hostRuns = 0;
    const errors: unknown[] = [];
    const client = new Anthropic({
      apiKey: "parent-key-must-not-leak",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/work/poll")) {
          if (!available) return Response.json(null);
          available = false;
          return Response.json(queuedWork);
        }
        if (path.endsWith("/ack")) return Response.json(startingWork);
        if (path === "/v1/sessions/session_01") {
          return Response.json({
            type: "error",
            error: { type: "api_error", message: "injected Session read failure" },
          }, { status: 503 });
        }
        throw new Error(`unexpected request ${request.method} ${path}`);
      },
    });
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          hostRuns += 1;
          return { type: "completed", revision: 1 };
        },
      },
      profileFor: async () => profile,
      onError: async (error) => { errors.push(error); },
    });

    await expect(worker.drain(AbortSignal.timeout(1_000))).resolves.toBeUndefined();

    expect(hostRuns).toBe(0);
    expect(errors).toEqual([
      expect.objectContaining({ status: 503 }),
    ]);
  });

  it("ignores other official webhook events and events for another workspace", () => {
    const { client, requests } = apiHarness();
    const { host } = hostHarness();
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host,
      profileFor: async () => profile,
    });
    const scheduled: Promise<void>[] = [];
    const unrelated = officialRunStartedEvent({
      data: {
        type: "session.created",
        id: "session_01",
        organization_id: "org_01",
        workspace_id: "workspace_01",
      },
    });
    expect(worker.handleWebhook({
      ...signedWebhook(unrelated),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "ignored", eventId: "event_01" });
    expect(worker.handleWebhook({
      ...signedWebhook(officialRunStartedEvent({
        data: {
          type: "session.status_run_started",
          id: "session_01",
          organization_id: "org_02",
          workspace_id: "workspace_02",
        },
      })),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "ignored", eventId: "event_01" });
    expect(scheduled).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("recovers a lost webhook through the immediate poll fallback", async () => {
    const { client } = apiHarness();
    const { host, runs } = hostHarness();
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host,
      profileFor: async () => profile,
      fallbackPollIntervalMs: 5,
    });
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    while (runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await running;
    expect(runs).toHaveLength(1);
  });

  it("ends the activation after a failed work item instead of reclaiming it in a hot loop", async () => {
    let pollCount = 0;
    let ackCount = 0;
    const errors: unknown[] = [];
    const client = new Anthropic({
      apiKey: "parent-key-must-not-leak",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/work/poll")) {
          pollCount += 1;
          return Response.json(queuedWork);
        }
        if (path.endsWith("/ack")) {
          ackCount += 1;
          return Response.json(startingWork);
        }
        if (path === "/v1/sessions/session_01") return Response.json(sessionSnapshot);
        throw new Error(`unexpected request ${request.method} ${path}`);
      },
    });
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          throw new Error("injected sandbox launch failure");
        },
      },
      profileFor: async () => profile,
      onError: async (error) => { errors.push(error); },
    });

    await expect(worker.drain(AbortSignal.timeout(1_000))).resolves.toBeUndefined();
    expect(pollCount).toBe(1);
    expect(ackCount).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({ message: "injected sandbox launch failure" }),
    ]);
  });

  it("coalesces local webhook/poll races and relies on the server claim for cross-worker exclusion", async () => {
    const { client, requests } = apiHarness();
    const firstHost = hostHarness();
    const secondHost = hostHarness();
    const shared = {
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      profileFor: async () => profile,
    };
    const first = createManagedEnvironmentWorker({ ...shared, host: firstHost.host, workerId: "worker_a" });
    const second = createManagedEnvironmentWorker({ ...shared, host: secondHost.host, workerId: "worker_b" });

    await Promise.all([first.drain(), first.drain(), second.drain()]);

    expect(firstHost.runs.length + secondHost.runs.length).toBe(1);
    expect(requests.filter(({ path }) => path.endsWith("/ack"))).toHaveLength(1);
  });

  it.each([
    [{ lease_extended: false, state: "active" }, "active"],
    [{ lease_extended: true, state: "stopping" }, "stopping"],
    [{ lease_extended: true, state: "stopped" }, "stopped"],
  ] as const)("treats an authoritative heartbeat %s response as a stop request", async (state, expectedState) => {
    const { client, stops } = structuralClient({
      heartbeat: async () => ({
        last_heartbeat: "2026-09-06T04:00:02.000Z",
        ttl_seconds: 90,
        ...state,
      }),
    });
    let abortReason: unknown;
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run(input) {
          const signal = input.signal!;
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }));
          }
          abortReason = signal.reason;
          return { type: "lease_lost" };
        },
      },
      profileFor: async () => supervisedProfile,
    });
    await worker.drain();
    expect(abortReason).toEqual(expect.objectContaining({
      message: `Work entered ${expectedState}`,
    }));
    expect(stops).toEqual([]);
  });

  it("reports a transient heartbeat failure and can still complete before lease expiry", async () => {
    const heartbeatError = Object.assign(new Error("temporary gateway failure"), { status: 503 });
    let report!: () => void;
    const reported = new Promise<void>((resolve) => { report = resolve; });
    const errors: unknown[] = [];
    const { client, stops } = structuralClient({
      heartbeat: async () => { throw heartbeatError; },
    });
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          await reported;
          return { type: "completed", revision: 1 };
        },
      },
      profileFor: async () => supervisedProfile,
      onError: (error) => {
        errors.push(error);
        report();
      },
    });
    await worker.drain();
    expect(errors).toEqual([heartbeatError]);
    expect(stops).toHaveLength(1);
  });

  it("does not misclassify an in-flight heartbeat cancelled by local cleanup as lease loss", async () => {
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    const { client, stops } = structuralClient({
      heartbeat: async ({ options }) => {
        heartbeatStarted();
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          await started;
          return { type: "completed", revision: 1 };
        },
      },
      profileFor: async () => supervisedProfile,
    });
    await worker.drain();
    expect(stops).toHaveLength(1);
  });

  it("propagates AbortError from a Work without reporting it as a Work failure", async () => {
    const { client } = structuralClient();
    const errors: unknown[] = [];
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          throw new DOMException("cancelled", "AbortError");
        },
      },
      profileFor: async () => profile,
      onError: (error) => { errors.push(error); },
    });
    await expect(worker.drain()).rejects.toMatchObject({ name: "AbortError" });
    expect(errors).toEqual([]);
  });

  it("forwards an explicit webhook key and reports an asynchronous activation failure", async () => {
    const { client, unwrapOptions } = structuralClient();
    const failure = new Error("profile unavailable");
    const errors: unknown[] = [];
    const scheduled: Promise<void>[] = [];
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      webhookKey: "whsec_explicit",
      host: hostHarness().host,
      profileFor: async () => { throw failure; },
      onError: (error) => { errors.push(error); },
    });
    expect(worker.handleWebhook({
      body: "{}",
      headers: { test: "header" },
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "triggered", eventId: "event_01" });
    await Promise.all(scheduled);
    expect(unwrapOptions).toEqual([{ headers: { test: "header" }, key: "whsec_explicit" }]);
    expect(errors).toEqual([failure]);
  });

  it("runs another drain after a scheduler wake and propagates non-abort scheduler failure", async () => {
    const { client, pollerOptions } = structuralClient({ work: null });
    const failure = new Error("timer backend unavailable");
    let sleeps = 0;
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: hostHarness().host,
      profileFor: async () => profile,
      scheduler: {
        async sleep() {
          sleeps += 1;
          if (sleeps === 1) return;
          throw failure;
        },
      },
    });
    await expect(worker.run()).rejects.toBe(failure);
    expect(pollerOptions).toHaveLength(2);
  });

  it("owns the official heartbeat lease for an OpenMA-supervised harness and aborts on 412", async () => {
    let available = true;
    let heartbeatCount = 0;
    let stopCount = 0;
    let hostSawAbort = false;
    const client = new Anthropic({
      apiKey: "parent-key-must-not-leak",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/work/poll")) {
          if (!available) return Response.json(null);
          available = false;
          return Response.json(queuedWork);
        }
        if (path.endsWith("/ack")) return Response.json(startingWork);
        if (path === "/v1/sessions/session_01") return Response.json(sessionSnapshot);
        if (path.endsWith("/heartbeat")) {
          heartbeatCount += 1;
          if (heartbeatCount === 1) {
            return Response.json({
              type: "work_heartbeat",
              last_heartbeat: "2026-09-06T04:00:02.000Z",
              lease_extended: true,
              state: "active",
              ttl_seconds: 90,
            });
          }
          return Response.json({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "heartbeat precondition did not match",
            },
          }, { status: 412 });
        }
        if (path.endsWith("/stop")) {
          stopCount += 1;
          return Response.json({ ...startingWork, state: "stopped" });
        }
        throw new Error(`unexpected request ${request.method} ${path}`);
      },
    });
    const supervisedProfile: ManagedRuntimeProfile = {
      ...profile,
      driver: {
        type: "openma_supervised",
        protocol: "openma-harness-supervisor-v1",
        supervisor: { command: "openma-supervisor" },
        harness: { id: "pi", version: "1" },
        readyTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
      },
    };
    const host: ManagedRuntimeHost = {
      async run(input) {
        const signal = (input as typeof input & { signal?: AbortSignal }).signal;
        if (signal === undefined) return { type: "failed", error: new Error("missing signal") };
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        hostSawAbort = signal.aborted;
        return { type: "lease_lost" };
      },
    };
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      workerId: "supervisor_01",
      host,
      profileFor: async () => supervisedProfile,
      heartbeatIntervalMs: 1,
    });

    await worker.drain(AbortSignal.timeout(1_000));

    expect(heartbeatCount).toBe(2);
    expect(hostSawAbort).toBe(true);
    expect(stopCount).toBe(0);
  });

  it("stops a normally completed supervised Work after closing its heartbeat monitor", async () => {
    let available = true;
    let heartbeatCount = 0;
    let stopCount = 0;
    let heartbeatObserved!: () => void;
    const observedHeartbeat = new Promise<void>((resolve) => {
      heartbeatObserved = resolve;
    });
    const client = new Anthropic({
      apiKey: "parent-key-must-not-leak",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/work/poll")) {
          if (!available) return Response.json(null);
          available = false;
          return Response.json(queuedWork);
        }
        if (path.endsWith("/ack")) return Response.json(startingWork);
        if (path === "/v1/sessions/session_01") return Response.json(sessionSnapshot);
        if (path.endsWith("/heartbeat")) {
          heartbeatCount += 1;
          heartbeatObserved();
          return Response.json({
            type: "work_heartbeat",
            last_heartbeat: "2026-09-06T04:00:02.000Z",
            lease_extended: true,
            state: "active",
            ttl_seconds: 90,
          });
        }
        if (path.endsWith("/stop")) {
          stopCount += 1;
          return Response.json({ ...startingWork, state: "stopped" });
        }
        throw new Error(`unexpected request ${request.method} ${path}`);
      },
    });
    const supervisedProfile: ManagedRuntimeProfile = {
      ...profile,
      driver: {
        type: "openma_supervised",
        protocol: "openma-harness-supervisor-v1",
        supervisor: { command: "openma-supervisor" },
        harness: { id: "pi", version: "1" },
        readyTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
      },
    };
    const results: ManagedRuntimeRunResult[] = [];
    const worker = createManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      host: {
        async run() {
          await observedHeartbeat;
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { type: "completed", revision: 1 };
        },
      },
      profileFor: async () => supervisedProfile,
      heartbeatIntervalMs: 100,
      onRunResult: async (_work, result) => { results.push(result); },
    });

    await expect(worker.drain(AbortSignal.timeout(1_000))).resolves.toBeUndefined();

    expect(heartbeatCount).toBe(1);
    expect(stopCount).toBe(1);
    expect(results).toEqual([{ type: "completed", revision: 1 }]);
  });
});
