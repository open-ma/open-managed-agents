// One-shot re-authorization callback for an existing Linear installation.
//
// Why this exists: pre-refresh-support installs discarded Linear's
// refresh_token. Their 24h access tokens are now dead and the only fix is
// to run Linear's OAuth consent flow again. The companion admin endpoint
// (in apps/integrations/src/index.ts) generates a click-through link;
// when the user approves on linear.app, Linear redirects here. This route
// delegates the actual OAuth dance to LinearProvider.completeReauthorize —
// the route's job is just HTTP framing (validate inputs, render JSON).
//
// Once every previously-deployed install has been migrated through here,
// this whole module + the admin endpoint can be deleted.

import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /linear/oauth/reauth/:appId/callback?code=...&state=...
 */
app.get("/:appId/callback", async (c) => {
  const appId = c.req.param("appId");
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return c.json({ error: "linear_oauth_denied", details: oauthError }, 400);
  }
  if (!appId || !code || !state) {
    return c.json({ error: "missing appId, code, or state" }, 400);
  }

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);

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
    installationId: result.installationId,
    workspaceName: result.workspaceName,
    botUserId: result.botUserId,
    capturedRefreshToken: result.capturedRefreshToken,
    accessTokenPreview: `${result.accessToken.slice(0, 16)}…`,
    note: "Tokens rotated. The bot can now refresh silently going forward.",
  });
});

export default app;
