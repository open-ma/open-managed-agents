import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Webhook receiver:
//   POST /linear/webhook/app/:appId       — A1 per-publication App
//
// Always returns 200 — Linear retries any non-2xx, including for events we
// chose not to act on. Drops are logged in linear_webhook_events.

const app = new Hono<{ Bindings: Env }>();

app.post("/app/:appId", async (c) => {
  const appId = c.req.param("appId");
  const rawBody = await c.req.raw.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const deliveryId =
    headers["linear-delivery"] ??
    safeJsonField(rawBody, "webhookId") ??
    null;

  // Find the installation that uses this app. Webhooks before the install
  // completes (App row exists but publication_id is null) get dropped here.
  const container = buildContainer(c.env);
  let installationId: string | null = null;
  if (appId) {
    const appRow = await container.apps.get(appId);
    if (appRow?.publicationId) {
      const pub = await container.publications.get(appRow.publicationId);
      if (pub) installationId = pub.installationId;
    }
  }

  const { linear } = buildProviders(c.env, container);
  const outcome = await linear.handleWebhook({
    providerId: "linear",
    installationId,
    deliveryId,
    headers,
    rawBody,
  });

  // Surface routing/verification reasons in tail logs. Cheap to emit
  // unconditionally — the structured shape stays grep-friendly.
  console.log(
    `[linear-webhook] appId=${appId} delivery=${deliveryId} event=${headers["linear-event"]} handled=${outcome.handled} reason=${outcome.reason ?? "ok"} sessionId=${outcome.sessionId ?? "-"}`,
  );
  // TEMP: dump body for AgentSessionEvent so we can extend the parser.
  // wrangler tail truncates each line ~600 bytes — split into chunks.
  if (headers["linear-event"] === "AgentSessionEvent") {
    const chunkSize = 400;
    for (let i = 0; i < Math.min(rawBody.length, 8000); i += chunkSize) {
      console.log(`[linear-body] ${deliveryId} ${i}: ${rawBody.slice(i, i + chunkSize)}`);
    }
  }

  // Linear contract: always 200. Body is informational.
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
