import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";
import { webhookRateLimitMiddleware, shouldDropForTenantRateLimit } from "../../webhook-rate-limit";

// Webhook receiver for GitHub Apps:
//   POST /github/webhook/app/:appOmaId
//
// Always returns 200 — GitHub retries any non-2xx, including for events we
// chose not to act on. Drops are logged in linear_webhook_events (which holds
// rows from all providers; the table just hasn't been renamed yet).

const app = new Hono<{ Bindings: Env }>();

app.use("/*", webhookRateLimitMiddleware);

app.post("/app/:appOmaId", async (c) => {
  const appOmaId = c.req.param("appOmaId");
  const rawBody = await c.req.raw.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const deliveryId = headers["x-github-delivery"] ?? null;
  const eventType = headers["x-github-event"] ?? null;

  const container = buildContainer(c.env);
  const { github } = buildProviders(c.env, container);
  const outcome = await github.handleWebhook({
    providerId: "github",
    // Reusing the WebhookRequest.installationId field to carry our
    // OMA-internal app id. The GitHubProvider re-interprets it.
    installationId: appOmaId,
    deliveryId,
    headers,
    rawBody,
  });

  console.log(
    `[github-webhook] appOmaId=${appOmaId} event=${eventType} delivery=${deliveryId} handled=${outcome.handled} reason=${outcome.reason ?? "ok"}`,
  );

  // Per-tenant rate limit. GitHub dispatches inline so this gate stops the
  // NEXT request in a sustained burst rather than the current one. Sliding
  // window converges within seconds.
  if (outcome.tenantId) {
    await shouldDropForTenantRateLimit(c.env, outcome.tenantId);
  }

  // GitHub contract: always 200. Body is informational.
  return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
});

export default app;
