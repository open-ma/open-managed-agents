import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Linear OAuth callback for the shared OMA App (B+ mode).
//
// Linear redirects the user's browser here with `code` and `state` after they
// authorize the install. We finish the install and redirect back to the
// Console URL captured in the state JWT.

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /linear/oauth/shared/callback?code=...&state=...
 *
 * On success: redirects to the Console returnUrl with `?publication_id=...`.
 * On failure: returns a JSON error (until we have a richer error UI).
 */
app.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    // Linear sends the user back here even when they decline.
    return c.json({ error: "linear_oauth_denied", details: error }, 400);
  }
  if (!code || !state) {
    return c.json({ error: "missing code or state" }, 400);
  }

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);

  let result;
  try {
    result = await linear.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback", code, state },
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

  // Decode state to recover the Console returnUrl. The JWT is verified inside
  // continueInstall; here we just need to read the returnUrl. Re-verify so we
  // never trust an unsigned payload.
  const statePayload = await container.jwt.verify<{ returnUrl: string }>(state);
  const target = new URL(statePayload.returnUrl);
  target.searchParams.set("publication_id", result.publicationId);
  target.searchParams.set("install", "ok");
  return c.redirect(target.toString(), 302);
});

export default app;
