import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Linear OAuth callback for A1 (per-publication App). Per-app endpoint so
// HMAC verification (later, on webhooks) and OAuth callback both can find
// the right App credentials by URL path.

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /linear/oauth/app/:appId/callback?code=...&state=...
 */
app.get("/:appId/callback", async (c) => {
  const appId = c.req.param("appId");
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return c.json({ error: "linear_oauth_denied", details: error }, 400);
  }
  if (!appId || !code || !state) {
    return c.json({ error: "missing appId, code, or state" }, 400);
  }

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);

  let result;
  try {
    result = await linear.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_dedicated", appId, code, state },
    });
  } catch (err) {
    return c.json(
      {
        error: "install_failed",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  if (result.kind !== "complete") {
    return c.json({ error: "unexpected install result", result }, 500);
  }

  // Recover the Console returnUrl from the (still-valid) state JWT.
  const statePayload = await container.jwt.verify<{ returnUrl: string }>(state);
  const target = new URL(statePayload.returnUrl);
  target.searchParams.set("publication_id", result.publicationId);
  target.searchParams.set("install", "ok");
  return c.redirect(target.toString(), 302);
});

export default app;
