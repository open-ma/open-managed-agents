import Anthropic from "@anthropic-ai/sdk";
import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  createDispatchedManagedEnvironmentWorker,
  type ManagedEnvironmentWorkDispatchPort,
} from "../src/index";

const WEBHOOK_SECRET = `whsec_${Buffer.from("dispatch-webhook-secret").toString("base64")}`;

const queuedWork: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-07T04:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: {},
  secret: "opaque-work-secret",
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

function runStartedEvent() {
  return {
    type: "event" as const,
    id: "event_01",
    created_at: "2026-09-07T04:00:00.000Z",
    data: {
      type: "session.status_run_started" as const,
      id: "session_01",
      organization_id: "org_01",
      workspace_id: "workspace_01",
    },
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
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
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
      });
      if (path.endsWith("/work/poll")) {
        if (!available) return Response.json(null);
        available = false;
        return Response.json(queuedWork);
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    },
  });
  return { client, requests };
}

function dispatcher() {
  const dispatch = vi.fn<ManagedEnvironmentWorkDispatchPort["dispatch"]>(
    async () => undefined,
  );
  const port: ManagedEnvironmentWorkDispatchPort = {
    descriptor: () => ({
      provider: "gke-agent-sandbox",
      version: "1.0.0",
      strategy: "poll_unacked_then_dispatch",
    }),
    dispatch,
  };
  return { port, dispatch };
}

function fakeClient(options: {
  poll?: () => Promise<BetaSelfHostedWork | null>;
  unwrap?: () => unknown;
  stop?: (
    workId: string,
    params: { environment_id: string; force?: boolean },
    options?: { signal?: AbortSignal },
  ) => PromiseLike<unknown>;
} = {}) {
  const stop = vi.fn(options.stop ?? (async () => undefined));
  const poll = vi.fn(options.poll ?? (async () => null));
  const unwrap = vi.fn(options.unwrap ?? (() => runStartedEvent()));
  return {
    client: {
      baseURL: "https://control.example.test",
      beta: { webhooks: { unwrap } },
      withOptions: vi.fn(() => ({ beta: { environments: { work: { poll, stop } } } })),
    },
    poll,
    stop,
    unwrap,
  };
}

describe("provider-dispatched Managed Environment Worker", () => {
  it("polls without ACK and lets the sandbox worker establish Work ownership", async () => {
    const { client, requests } = apiHarness();
    const { port, dispatch } = dispatcher();
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      workerId: "dispatcher_01",
      dispatch: port,
    });

    await worker.drain();

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/environments/env_01/work/poll",
      "GET /v1/environments/env_01/work/poll",
    ]);
    expect(requests.every(({ authorization }) => authorization === "Bearer environment-key"))
      .toBe(true);
    expect(requests.every(({ workerId }) => workerId === "dispatcher_01"))
      .toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      apiBaseUrl: "http://openma.test",
      environmentKey: "environment-key",
      signal: expect.any(AbortSignal),
      work: queuedWork,
      workspaceId: "workspace_01",
    });
  });

  it("uses the signed webhook as a wake-up for the same unacked dispatch path", async () => {
    const { client } = apiHarness();
    const { port, dispatch } = dispatcher();
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      dispatch: port,
    });
    const scheduled: Promise<void>[] = [];

    expect(worker.handleWebhook({
      ...signedWebhook(runStartedEvent()),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "triggered", eventId: "event_01" });
    await Promise.all(scheduled);

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("ends a failed activation so the unacked reservation can be reclaimed later", async () => {
    const errors: unknown[] = [];
    const { client, requests } = apiHarness();
    const port: ManagedEnvironmentWorkDispatchPort = {
      descriptor: () => ({
        provider: "cloudflare-isolate",
        version: "1.0.0",
        strategy: "poll_unacked_then_dispatch",
      }),
      async dispatch() {
        throw new Error("injected SandboxClaim failure");
      },
    };
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      dispatch: port,
      onError: async (error) => { errors.push(error); },
    });

    await expect(worker.drain()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(errors).toEqual([
      expect.objectContaining({ message: "injected SandboxClaim failure" }),
    ]);
  });

  it.each([0, 1.5])("rejects invalid fallback polling interval %s", (fallbackPollIntervalMs) => {
    const { client } = fakeClient();
    expect(() => createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: dispatcher().port,
      fallbackPollIntervalMs,
    })).toThrow("positive integer");
  });

  it.each([
    ["non-object envelope", null, /event envelope/],
    ["array envelope", [], /event envelope/],
    ["wrong envelope type", { type: "wrong", id: "event", data: {} }, /event envelope/],
    ["missing event id", { type: "event", data: {} }, /event envelope/],
    ["non-object data", { type: "event", id: "event", data: null }, /event data/],
    ["missing data type", { type: "event", id: "event", data: { workspace_id: "workspace_01" } }, /event data/],
    ["missing workspace", { type: "event", id: "event", data: { type: "session.status_run_started" } }, /event data/],
  ])("rejects %s", (_name, event, message) => {
    const { client } = fakeClient({ unwrap: () => event });
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: dispatcher().port,
    });

    expect(() => worker.handleWebhook({ body: "{}", headers: {}, waitUntil: vi.fn() }))
      .toThrow(message);
  });

  it("ignores unrelated event types and workspaces and passes an explicit signing key", () => {
    const events = [
      { ...runStartedEvent(), data: { ...runStartedEvent().data, type: "session.created" } },
      { ...runStartedEvent(), data: { ...runStartedEvent().data, workspace_id: "other" } },
    ];
    const { client, unwrap } = fakeClient({ unwrap: () => events.shift() });
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      webhookKey: "explicit-key",
      dispatch: dispatcher().port,
    });

    expect(worker.handleWebhook({ body: "{}", headers: {}, waitUntil: vi.fn() }))
      .toEqual({ type: "ignored", eventId: "event_01" });
    expect(worker.handleWebhook({ body: "{}", headers: {}, waitUntil: vi.fn() }))
      .toEqual({ type: "ignored", eventId: "event_01" });
    expect(unwrap).toHaveBeenCalledWith("{}", { headers: {}, key: "explicit-key" });
  });

  it("stops non-Session Work and dispatches with provider-specific poll and API options", async () => {
    const queued = [
      { ...queuedWork, id: "non-session", data: { type: "task", id: "task_01" } },
      queuedWork,
    ] as BetaSelfHostedWork[];
    const { client, poll, stop } = fakeClient({ poll: async () => queued.shift() ?? null });
    const { port, dispatch } = dispatcher();
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      workerId: "worker",
      reclaimOlderThanMs: 30_000,
      sandboxApiBaseUrl: "https://sandbox-api.example.test",
      dispatch: port,
    });

    await worker.drain();

    expect(stop).toHaveBeenCalledWith("non-session", {
      environment_id: "env_01",
      force: true,
    }, { signal: expect.any(AbortSignal) });
    expect(poll).toHaveBeenCalledWith("env_01", {
      block_ms: null,
      reclaim_older_than_ms: 30_000,
      "Anthropic-Worker-ID": "worker",
    }, { signal: expect.any(AbortSignal) });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      apiBaseUrl: "https://sandbox-api.example.test",
    }));
  });

  it("reuses one active drain and performs a requested rerun", async () => {
    let releaseDispatch!: () => void;
    const dispatchMayFinish = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let polls = 0;
    const { client } = fakeClient({ poll: async () => ++polls === 1 ? queuedWork : null });
    const { port, dispatch } = dispatcher();
    dispatch.mockImplementationOnce(async () => await dispatchMayFinish);
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: port,
    });

    const first = worker.drain();
    const second = worker.drain();
    expect(second).toBe(first);
    releaseDispatch();
    await Promise.all([first, second]);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("propagates an abort from provider dispatch without reporting it", async () => {
    const errors: unknown[] = [];
    const { client } = fakeClient({ poll: async () => queuedWork });
    const { port, dispatch } = dispatcher();
    dispatch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: port,
      onError: (error) => { errors.push(error); },
    });

    await expect(worker.drain()).rejects.toMatchObject({ name: "AbortError" });
    expect(errors).toEqual([]);
  });

  it("runs the fallback loop with the default signal and swallows AbortError", async () => {
    const { client } = fakeClient();
    const sleep = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); });
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: dispatcher().port,
      scheduler: { sleep },
    });

    await expect(worker.run()).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("propagates a non-abort fallback scheduler failure", async () => {
    const { client } = fakeClient();
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: dispatcher().port,
      scheduler: { sleep: async () => { throw new Error("scheduler failed"); } },
    });

    await expect(worker.run(new AbortController().signal)).rejects.toThrow("scheduler failed");
  });

  it("treats an already aborted drain as empty", async () => {
    const { client } = fakeClient();
    const controller = new AbortController();
    controller.abort();
    const worker = createDispatchedManagedEnvironmentWorker({
      client,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "workspace_01",
      dispatch: dispatcher().port,
    });

    await expect(worker.drain(controller.signal)).resolves.toBeUndefined();
  });

  it("covers normal wake-up and in-flight abort in the default scheduler", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient();
      const controller = new AbortController();
      const worker = createDispatchedManagedEnvironmentWorker({
        client,
        environmentId: "env_01",
        environmentKey: "key",
        workspaceId: "workspace_01",
        dispatch: dispatcher().port,
        fallbackPollIntervalMs: 10,
      });
      const running = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort(new DOMException("stopped", "AbortError"));
      await expect(running).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
