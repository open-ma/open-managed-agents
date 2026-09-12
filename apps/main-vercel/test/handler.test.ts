import { describe, expect, it, vi } from "vitest";

import { createVercelControlPlaneHandler } from "../src/handler";

function fixture() {
  const apiFetch = vi.fn(async (request: Request) =>
    Response.json({ path: new URL(request.url).pathname, body: await request.text() }));
  const drain = vi.fn(async (_signal?: AbortSignal) => undefined);
  const handleWebhook = vi.fn((input: {
    body: string;
    headers: Record<string, string>;
    waitUntil(promise: Promise<void>): void;
  }) => {
    input.waitUntil(Promise.resolve());
    return { type: "triggered" as const, eventId: "event_01" };
  });
  const scheduled: Promise<unknown>[] = [];
  const handler = createVercelControlPlaneHandler({
    loadApi: async () => ({ fetch: apiFetch }),
    loadEnvironmentWorker: async () => ({ drain, handleWebhook, run: vi.fn() }),
    waitUntil: (promise) => scheduled.push(promise),
    cronSecret: "cron-secret",
    pollTimeoutMs: 1_000,
  });
  return { apiFetch, drain, handleWebhook, scheduled, handler };
}

describe("Vercel control-plane handler", () => {
  it.each([0, -1, 1.5])("rejects invalid poll timeout %s", (pollTimeoutMs) => {
    expect(() => createVercelControlPlaneHandler({
      loadApi: async () => ({ fetch: vi.fn() }),
      loadEnvironmentWorker: async () => ({
        drain: vi.fn(),
        handleWebhook: vi.fn(),
        run: vi.fn(),
      }),
      waitUntil: vi.fn(),
      pollTimeoutMs,
    })).toThrow("pollTimeoutMs must be a positive integer");
  });

  it("forwards ordinary API and ACP steer events to the canonical app unchanged", async () => {
    const { handler, apiFetch } = fixture();
    const body = JSON.stringify({
      type: "user.message",
      id: "event_steer",
      content: [{ type: "text", text: "change direction" }],
    });
    const request = new Request("https://control.example.test/v1/oma/sessions/session_01/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const response = await handler.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/v1/oma/sessions/session_01/events",
      body,
    });
    expect(apiFetch).toHaveBeenCalledWith(request);
  });

  it("verifies and dispatches the raw Environment webhook through waitUntil", async () => {
    const { handler, handleWebhook, scheduled } = fixture();
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/webhook",
      {
        method: "POST",
        headers: { "webhook-id": "msg_01" },
        body: "{\"signed\":true}",
      },
    ));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ type: "triggered", event_id: "event_01" });
    expect(handleWebhook).toHaveBeenCalledWith({
      body: "{\"signed\":true}",
      headers: expect.objectContaining({ "webhook-id": "msg_01" }),
      waitUntil: expect.any(Function),
    });
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
  });

  it("rejects a malformed or unsigned webhook without scheduling Work", async () => {
    const { handler, handleWebhook, scheduled } = fixture();
    handleWebhook.mockImplementationOnce(() => { throw new Error("invalid signature"); });

    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/webhook",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_environment_webhook" });
    expect(scheduled).toEqual([]);
  });

  it("fails closed when the Environment worker cannot be composed", async () => {
    const onError = vi.fn();
    const handler = createVercelControlPlaneHandler({
      loadApi: async () => ({ fetch: vi.fn() }),
      loadEnvironmentWorker: async () => { throw new Error("worker config missing"); },
      waitUntil: vi.fn(),
      onError,
    });

    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/webhook",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "environment_worker_unavailable" });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "worker config missing" }));
  });

  it("requires POST for webhooks", async () => {
    const { handler, handleWebhook } = fixture();
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/webhook",
    ));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("runs one authenticated bounded fallback poll", async () => {
    const { handler, drain } = fixture();
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { headers: { authorization: "Bearer cron-secret" } },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(drain).toHaveBeenCalledOnce();
    expect(drain.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("requires GET or POST for fallback polls", async () => {
    const { handler, drain } = fixture();
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { method: "PUT", headers: { authorization: "Bearer cron-secret" } },
    ));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(drain).not.toHaveBeenCalled();
  });

  it("fails closed when polling fails", async () => {
    const { handler, drain } = fixture();
    drain.mockRejectedValueOnce(new Error("poll failed"));
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { method: "POST", headers: { authorization: "Bearer cron-secret" } },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "environment_poll_failed" });
  });

  it("bounds a stalled poll with the function deadline", async () => {
    vi.useFakeTimers();
    try {
      const handler = createVercelControlPlaneHandler({
        loadApi: async () => ({ fetch: vi.fn() }),
        loadEnvironmentWorker: async () => ({
          handleWebhook: vi.fn(),
          run: vi.fn(),
          drain: async (signal) => {
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
        waitUntil: vi.fn(),
        cronSecret: "cron-secret",
        pollTimeoutMs: 10,
      });
      const pending = handler.fetch(new Request(
        "https://control.example.test/api/openma/environment/poll",
        { headers: { authorization: "Bearer cron-secret" } },
      ));
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ status: 503 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an already-aborted request into the bounded poll", async () => {
    const requestController = new AbortController();
    requestController.abort(new Error("client disconnected"));
    const handler = createVercelControlPlaneHandler({
      loadApi: async () => ({ fetch: vi.fn() }),
      loadEnvironmentWorker: async () => ({
        handleWebhook: vi.fn(),
        run: vi.fn(),
        drain: async (signal) => signal?.throwIfAborted(),
      }),
      waitUntil: vi.fn(),
      cronSecret: "cron-secret",
      pollTimeoutMs: 10,
    });
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { headers: { authorization: "Bearer cron-secret" }, signal: requestController.signal },
    ));

    expect(response.status).toBe(503);
  });

  it.each([undefined, "", "Bearer wrong", "Basic cron-secret"])(
    "rejects fallback poll authorization %s",
    async (authorization) => {
      const { handler, drain } = fixture();
      const headers: Record<string, string> = authorization === undefined
        ? {}
        : { authorization };
      const response = await handler.fetch(new Request(
        "https://control.example.test/api/openma/environment/poll",
        { headers },
      ));

      expect(response.status).toBe(401);
      expect(drain).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the poll endpoint has no configured secret", async () => {
    const { handler: _handler, ...values } = fixture();
    const handler = createVercelControlPlaneHandler({
      loadApi: async () => ({ fetch: values.apiFetch }),
      loadEnvironmentWorker: async () => ({
        drain: values.drain,
        handleWebhook: values.handleWebhook,
        run: vi.fn(),
      }),
      waitUntil: (promise) => values.scheduled.push(promise),
    });
    const response = await handler.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
    ));

    expect(response.status).toBe(503);
    expect(values.drain).not.toHaveBeenCalled();
  });
});
