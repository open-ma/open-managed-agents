import Anthropic from "@anthropic-ai/sdk";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderNativeManagedEnvironmentWorker,
  type ManagedEnvironmentActivationPort,
} from "../src/index";

const WEBHOOK_SECRET = `whsec_${Buffer.from("provider-native-webhook-secret").toString("base64")}`;

function runStartedEvent(overrides: Record<string, unknown> = {}) {
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
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "webhook-signature": webhook.sign(id, timestamp, body),
    },
  };
}

function client() {
  return new Anthropic({
    apiKey: "must-not-be-used",
    baseURL: "http://openma.test",
    webhookKey: WEBHOOK_SECRET,
    maxRetries: 0,
    fetch: async () => {
      throw new Error("provider-native activation must not poll or ACK Work");
    },
  });
}

function activation(overrides: Partial<ManagedEnvironmentActivationPort> = {}) {
  return {
    descriptor: () => ({
      provider: "aws-microvm",
      version: "1.0.0",
      strategy: "acquire_then_session_poll" as const,
    }),
    activate: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    ...overrides,
  };
}

function verificationClient(event: unknown) {
  return {
    beta: { webhooks: { unwrap: vi.fn(() => event) } },
  };
}

describe("provider-native Environment Worker activation", () => {
  it("verifies the official webhook and passes a stable idempotency key to the provider", async () => {
    const activate = vi.fn<ManagedEnvironmentActivationPort["activate"]>(async () => undefined);
    const reconcile = vi.fn<ManagedEnvironmentActivationPort["reconcile"]>(async () => undefined);
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: {
        descriptor: () => ({
          provider: "aws-microvm",
          version: "1.0.0",
          strategy: "acquire_then_session_poll",
        }),
        activate,
        reconcile,
      },
    });
    const scheduled: Promise<void>[] = [];

    expect(worker.handleWebhook({
      ...signedWebhook(runStartedEvent()),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "triggered", eventId: "event_01" });
    await Promise.all(scheduled);

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith({
      eventId: "event_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workspaceId: "workspace_01",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("uses provider reconciliation as the fallback without claiming Managed Agents Work", async () => {
    const activate = vi.fn<ManagedEnvironmentActivationPort["activate"]>(async () => undefined);
    const reconcile = vi.fn<ManagedEnvironmentActivationPort["reconcile"]>(async () => undefined);
    const controller = new AbortController();
    let sleeps = 0;
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: {
        descriptor: () => ({
          provider: "aws-microvm",
          version: "1.0.0",
          strategy: "acquire_then_session_poll",
        }),
        activate,
        reconcile,
      },
      fallbackReconcileIntervalMs: 5,
      scheduler: {
        async sleep() {
          sleeps += 1;
          controller.abort();
        },
      },
    });

    await worker.run(controller.signal);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({
      environmentId: "env_01",
      signal: controller.signal,
      workspaceId: "workspace_01",
    });
    expect(sleeps).toBe(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores non-start events and events from another workspace", () => {
    const activate = vi.fn<ManagedEnvironmentActivationPort["activate"]>(async () => undefined);
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: {
        descriptor: () => ({
          provider: "aws-microvm",
          version: "1.0.0",
          strategy: "acquire_then_session_poll",
        }),
        activate,
        reconcile: async () => undefined,
      },
    });
    const scheduled: Promise<void>[] = [];

    expect(worker.handleWebhook({
      ...signedWebhook(runStartedEvent({
        data: {
          type: "session.created",
          id: "session_01",
          organization_id: "org_01",
          workspace_id: "workspace_01",
        },
      })),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "ignored", eventId: "event_01" });
    expect(worker.handleWebhook({
      ...signedWebhook(runStartedEvent({
        data: {
          type: "session.status_run_started",
          id: "session_02",
          organization_id: "org_01",
          workspace_id: "workspace_02",
        },
      })),
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "ignored", eventId: "event_01" });

    expect(scheduled).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([0, 1.5])("rejects invalid reconciliation interval %s", (fallbackReconcileIntervalMs) => {
    expect(() => createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: activation(),
      fallbackReconcileIntervalMs,
    })).toThrow("positive integer");
  });

  it.each([
    ["non-object envelope", null, /event envelope/],
    ["array envelope", [], /event envelope/],
    ["wrong envelope type", { type: "wrong", id: "event", data: {} }, /event envelope/],
    ["missing event id", { type: "event", data: {} }, /event envelope/],
    ["non-object data", { type: "event", id: "event", data: null }, /event data/],
    ["missing session", { type: "event", id: "event", data: { type: "session.status_run_started", workspace_id: "workspace_01" } }, /event data/],
    ["empty session", { type: "event", id: "event", data: { type: "session.status_run_started", id: "", workspace_id: "workspace_01" } }, /event data/],
    ["missing type", { type: "event", id: "event", data: { id: "session", workspace_id: "workspace_01" } }, /event data/],
    ["missing workspace", { type: "event", id: "event", data: { type: "session.status_run_started", id: "session" } }, /event data/],
  ])("rejects %s", (_name, event, message) => {
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: verificationClient(event),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: activation(),
    });

    expect(() => worker.handleWebhook({ body: "{}", headers: {}, waitUntil: vi.fn() }))
      .toThrow(message);
  });

  it("passes an explicit signing key and reports asynchronous activation failure", async () => {
    const errors: unknown[] = [];
    const activate = vi.fn(async () => { throw new Error("activation failed"); });
    const signedClient = verificationClient(runStartedEvent());
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: signedClient,
      environmentId: "env_01",
      workspaceId: "workspace_01",
      webhookKey: "explicit-key",
      activation: activation({ activate }),
      onError: (error) => { errors.push(error); },
    });
    const scheduled: Promise<void>[] = [];

    expect(worker.handleWebhook({
      body: "{}",
      headers: { test: "header" },
      waitUntil: (promise) => scheduled.push(promise),
    })).toEqual({ type: "triggered", eventId: "event_01" });
    await Promise.all(scheduled);

    expect(signedClient.beta.webhooks.unwrap).toHaveBeenCalledWith("{}", {
      headers: { test: "header" },
      key: "explicit-key",
    });
    expect(errors).toEqual([expect.objectContaining({ message: "activation failed" })]);
  });

  it("coalesces concurrent reconciliation and reruns after the active pass", async () => {
    let release!: () => void;
    const firstPass = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = vi.fn()
      .mockImplementationOnce(async () => await firstPass)
      .mockResolvedValue(undefined);
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: activation({ reconcile }),
    });

    const first = worker.drain();
    const second = worker.drain();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("reconciles again after a normal scheduler wake-up before abort", async () => {
    const controller = new AbortController();
    let sleeps = 0;
    const selected = activation();
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: selected,
      scheduler: {
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) controller.abort();
        },
      },
    });

    await worker.run(controller.signal);
    expect(selected.reconcile).toHaveBeenCalledTimes(2);
  });

  it("uses the default run signal and treats AbortError as shutdown", async () => {
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: activation(),
      scheduler: { sleep: async () => { throw new DOMException("aborted", "AbortError"); } },
    });

    await expect(worker.run()).resolves.toBeUndefined();
  });

  it("propagates non-abort reconcile failures", async () => {
    const worker = createProviderNativeManagedEnvironmentWorker({
      client: client(),
      environmentId: "env_01",
      workspaceId: "workspace_01",
      activation: activation({ reconcile: vi.fn(async () => { throw new Error("reconcile failed"); }) }),
    });

    await expect(worker.run(new AbortController().signal)).rejects.toThrow("reconcile failed");
  });

  it("covers normal wake-up and in-flight abort in the default scheduler", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const worker = createProviderNativeManagedEnvironmentWorker({
        client: client(),
        environmentId: "env_01",
        workspaceId: "workspace_01",
        activation: activation(),
        fallbackReconcileIntervalMs: 10,
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
