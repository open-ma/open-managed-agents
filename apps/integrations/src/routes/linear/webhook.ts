import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Webhook receiver. Two endpoints, one per install kind:
//   POST /linear/webhook/shared           — B+ shared OMA App
//   POST /linear/webhook/app/:appId       — A1 per-publication App (Phase 11)
//
// Always returns 200 — Linear retries any non-2xx, including for events we
// chose not to act on. Drops are logged in linear_webhook_events.

const app = new Hono<{ Bindings: Env }>();

app.post("/shared", async (c) => {
  return handle(c, "shared", null);
});

app.post("/app/:appId", async (c) => {
  const appId = c.req.param("appId");
  return handle(c, "dedicated", appId);
});

async function handle(
  c: { req: { raw: Request }; env: Env; json: (body: unknown, status?: number) => Response },
  kind: "shared" | "dedicated",
  appId: string | null,
): Promise<Response> {
  const rawBody = await c.req.raw.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const deliveryId =
    headers["linear-delivery"] ??
    safeJsonField(rawBody, "webhookId") ??
    null;

  // Resolve installationId from the URL kind. For shared, we have to look it
  // up from the body's organizationId since one shared App can serve many
  // workspaces. For dedicated (A1), the appId pins one installation.
  let installationId: string | null = null;
  const container = buildContainer(c.env);
  if (kind === "shared") {
    const orgId = safeJsonField(rawBody, "organizationId");
    if (orgId) {
      const inst = await container.installations.findByWorkspace(
        "linear",
        orgId,
        "shared",
        null,
      );
      installationId = inst?.id ?? null;
    }
  } else if (appId) {
    // Find the installation that uses this app. Webhooks before the install
    // completes (App row exists but publication_id is null) get dropped here.
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

  // Linear contract: always 200. Body is informational.
  return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
}

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
