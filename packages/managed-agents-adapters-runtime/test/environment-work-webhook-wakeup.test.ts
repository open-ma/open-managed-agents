import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { StandardWebhookEnvironmentWorkWakeup } from "../src/environment-work-webhook-wakeup";

const SECRET = `whsec_${Buffer.from("openma-official-webhook").toString("base64")}`;

describe("StandardWebhookEnvironmentWorkWakeup", () => {
  it("delivers the exact official status_run_started event with Standard Webhooks headers", async () => {
    const requests: Request[] = [];
    const signingTime = new Date();
    const wakeup = new StandardWebhookEnvironmentWorkWakeup({
      endpoint: "https://worker.example/webhooks/managed-agents",
      signingKey: SECRET,
      organizationId: "org_openma",
      nextEventId: () => "event_01",
      now: () => signingTime,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
    });

    await wakeup.notifyRunStarted({
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workId: "work_01",
      occurredAt: "2026-09-06T04:00:00.000Z",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const body = await request.text();
    const event = new Anthropic({
      apiKey: "unused",
      webhookKey: SECRET,
    }).beta.webhooks.unwrap(body, {
      headers: Object.fromEntries(request.headers.entries()),
    });
    expect(event).toEqual({
      type: "event",
      id: "event_01",
      created_at: "2026-09-06T04:00:00.000Z",
      data: {
        type: "session.status_run_started",
        id: "session_01",
        organization_id: "org_openma",
        workspace_id: "workspace_01",
      },
    });
    expect(Object.keys(event).sort()).toEqual(["created_at", "data", "id", "type"]);
    expect(Object.keys(event.data).sort()).toEqual([
      "id",
      "organization_id",
      "type",
      "workspace_id",
    ]);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("webhook-id")).toBe("event_01");
    expect(request.headers.get("webhook-timestamp")).toBe(
      String(Math.floor(signingTime.getTime() / 1_000)),
    );
    expect(request.headers.get("webhook-signature")).toMatch(/^v1,/);
    expect(request.redirect).toBe("manual");
  });

  it("retries transient delivery failures but never changes the event identity", async () => {
    const bodies: string[] = [];
    const ids: string[] = [];
    const signatures: string[] = [];
    const timestamps: string[] = [];
    const sleeps: number[] = [];
    let attempt = 0;
    const wakeup = new StandardWebhookEnvironmentWorkWakeup({
      endpoint: "https://worker.example/webhooks/managed-agents",
      signingKey: SECRET,
      organizationId: ({ workspaceId }) => `org:${workspaceId}`,
      nextEventId: () => "event_retry",
      now: () => new Date(`2026-09-06T04:00:0${attempt + 1}.000Z`),
      random: () => 0.5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.text());
        ids.push(request.headers.get("webhook-id") ?? "");
        signatures.push(request.headers.get("webhook-signature") ?? "");
        timestamps.push(request.headers.get("webhook-timestamp") ?? "");
        attempt += 1;
        return new Response(null, { status: attempt < 3 ? 503 : 204 });
      },
    });

    await wakeup.notifyRunStarted({
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workId: "work_01",
      occurredAt: "2026-09-06T04:00:00.000Z",
    });

    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(ids).toEqual(["event_retry", "event_retry", "event_retry"]);
    expect(new Set(signatures).size).toBe(3);
    expect(new Set(timestamps).size).toBe(3);
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it("retries a 4xx response for all three official delivery attempts", async () => {
    let attempts = 0;
    const wakeup = new StandardWebhookEnvironmentWorkWakeup({
      endpoint: "https://worker.example/webhooks/managed-agents",
      signingKey: SECRET,
      organizationId: "org_openma",
      nextEventId: () => "event_rejected",
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 400 });
      },
      sleep: async () => {},
    });

    await expect(wakeup.notifyRunStarted({
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workId: "work_01",
      occurredAt: "2026-09-06T04:00:00.000Z",
    })).rejects.toThrow("Managed Agents webhook returned HTTP 400");
    expect(attempts).toBe(3);
  });

  it("does not retry a redirect because official delivery disables the endpoint", async () => {
    let attempts = 0;
    const wakeup = new StandardWebhookEnvironmentWorkWakeup({
      endpoint: "https://worker.example/webhooks/managed-agents",
      signingKey: SECRET,
      organizationId: "org_openma",
      nextEventId: () => "event_redirected",
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 307 });
      },
    });

    await expect(wakeup.notifyRunStarted({
      workspaceId: "workspace_01",
      environmentId: "env_01",
      sessionId: "session_01",
      workId: "work_01",
      occurredAt: "2026-09-06T04:00:00.000Z",
    })).rejects.toThrow("Managed Agents webhook returned HTTP 307");
    expect(attempts).toBe(1);
  });
});
