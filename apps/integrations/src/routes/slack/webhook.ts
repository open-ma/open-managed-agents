import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";
import { webhookRateLimitMiddleware, shouldDropForTenantRateLimit } from "../../webhook-rate-limit";

// Webhook receiver:
//   POST /slack/webhook/app/:appId
//
// Always returns 200 — Slack retries any non-2xx, including for events we
// chose not to act on. Drops are logged in slack_webhook_events.
//
// Slack's 3-second response budget is enforced strictly. The provider returns
// `deferredWork` on the WebhookOutcome; we attach it to executionCtx.waitUntil
// and return immediately. URL-verification handshakes need a synchronous
// challenge response in the body — we surface those via `challengeResponse`.

const app = new Hono<{ Bindings: Env }>();

app.use("/*", webhookRateLimitMiddleware);

app.post("/app/:appId", async (c) => {
  const appId = c.req.param("appId");
  const rawBody = await c.req.raw.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  // Stuff appId into the WebhookRequest envelope via a synthetic header so
  // the provider stays runtime-agnostic (no Hono context).
  if (appId) headers["x-internal-app-id"] = appId;

  const { slack } = buildProviders(c.env);
  const outcome = await slack.handleWebhook({
    providerId: "slack",
    installationId: appId, // provider's appIdFromHeaders fallback
    deliveryId: null,
    headers,
    rawBody,
  });

  // Tail-grep-friendly structured log. Cheap to emit unconditionally.
  const eventType = headers["x-slack-event-type"] ?? safeJsonField(rawBody, "type");
  console.log(
    `[slack-webhook] appId=${appId} type=${eventType} handled=${outcome.handled} reason=${outcome.reason ?? "ok"}`,
  );

  // url_verification handshake — Slack expects the challenge string echoed
  // back in plain text (or as { challenge } JSON; plain text is canonical).
  if (outcome.challengeResponse !== undefined) {
    return new Response(outcome.challengeResponse, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // Per-tenant rate limit: a misconfigured workspace can spew thousands of
  // events from a legit Slack IP. Apply AFTER handleWebhook so we know
  // which tenant — drop the deferred dispatch but still 200 so Slack
  // doesn't retry and amplify the problem.
  if (outcome.tenantId && (await shouldDropForTenantRateLimit(c.env, outcome.tenantId))) {
    return c.json({ ok: false, reason: "tenant_rate_limited" }, 200);
  }

  // Defer the heavy lifting (session create/resume) so we 200 within Slack's
  // 3-second budget. Errors inside deferred work are written to the
  // webhook event log by the provider; we don't care here.
  if (outcome.deferredWork) {
    c.executionCtx.waitUntil(outcome.deferredWork());
  }

  return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
});

/** Best-effort scan of one top-level JSON field without parsing the whole body. */
function safeJsonField(body: string, field: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export default app;
