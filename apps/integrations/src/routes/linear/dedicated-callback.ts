import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Linear OAuth callback for A1 (per-publication App). Per-app endpoint so
// HMAC verification (later, on webhooks) and OAuth callback both can find
// the right App credentials by URL path.
//
// This same URI also serves the one-shot re-authorize flow for
// pre-refresh-support installs (state.kind = "linear.oauth.reauth"): we
// reuse the registered redirect_uri instead of forcing a separate one to
// be added to every existing OAuth app. Dispatch is purely by state.kind —
// fresh installs hit `continueInstall`, reauth flows go through
// `completeReauthorize`, which rotates tokens on the existing row.

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

  // Peek at state.kind to decide which provider entrypoint to invoke. We
  // verify the JWT signature here instead of trusting an unverified payload;
  // the provider methods re-verify too but that's fine — verify is cheap
  // and the dispatch is part of the route's job, not the provider's.
  let stateKind: string | null = null;
  try {
    const payload = await container.jwt.verify<{ kind?: string }>(state);
    stateKind = payload.kind ?? null;
  } catch {
    return c.json({ error: "invalid_state" }, 400);
  }

  if (stateKind === "linear.oauth.reauth") {
    let result;
    try {
      result = await linear.completeReauthorize({
        appId,
        code,
        state,
        redirectBase: c.env.GATEWAY_ORIGIN,
      });
    } catch (err) {
      return c.json(
        { error: "reauth_failed", details: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
    return c.json({
      ok: true,
      flow: "reauth",
      installationId: result.installationId,
      workspaceName: result.workspaceName,
      botUserId: result.botUserId,
      capturedRefreshToken: result.capturedRefreshToken,
      accessTokenPreview: `${result.accessToken.slice(0, 16)}…`,
      note: "Tokens rotated on the existing install. Bot can refresh silently going forward.",
    });
  }

  // Fresh dedicated install path (state.kind = "linear.oauth.dedicated").
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
