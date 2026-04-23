import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// Slack A1 (full identity) install flow.
//
// Three steps, three endpoints (mirrors Linear's):
//   1. POST /slack/publications/start-a1
//      → returns { formToken, callbackUrl, webhookUrl, suggestedAppName, ... }
//   2. POST /slack/publications/credentials
//      → returns { url, appId, callbackUrl, webhookUrl }  (final URLs with appId)
//   3. GET  /slack/oauth/app/:appId/callback
//      → completes install, redirects to Console returnUrl
//
// /start-a1 and /handoff-link are internal-only (called by apps/main via
// service binding) and require the shared header secret. /credentials is
// reachable directly from the user's browser (admin handoff page submits
// straight here without a session) — auth there is the formToken JWT itself.

const app = new Hono<{ Bindings: Env }>();

function requireInternalSecret(env: Env, headerValue: string | undefined): boolean {
  return Boolean(
    env.INTEGRATIONS_INTERNAL_SECRET &&
      headerValue === env.INTEGRATIONS_INTERNAL_SECRET,
  );
}

interface StartA1Body {
  userId: string;
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl: string | null;
  returnUrl: string;
}

app.post("/start-a1", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<StartA1Body>();
  if (!body.userId || !body.agentId || !body.environmentId || !body.personaName || !body.returnUrl) {
    return c.json(
      { error: "userId, agentId, environmentId, personaName, returnUrl required" },
      400,
    );
  }

  const { slack } = buildProviders(c.env);
  const result = await slack.startInstall({
    userId: body.userId,
    agentId: body.agentId,
    environmentId: body.environmentId,
    mode: "full",
    persona: { name: body.personaName, avatarUrl: body.personaAvatarUrl },
    returnUrl: body.returnUrl,
  });

  if (result.kind !== "step" || result.step !== "credentials_form") {
    return c.json({ error: "unexpected install result", result }, 500);
  }
  return c.json(result.data);
});

interface SubmitCredentialsBody {
  formToken: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

app.post("/credentials", async (c) => {
  const body = await c.req.json<SubmitCredentialsBody>();
  if (!body.formToken || !body.clientId || !body.clientSecret || !body.signingSecret) {
    return c.json(
      {
        error: "formToken, clientId, clientSecret, signingSecret required",
        hint:
          "signingSecret comes from the Slack App's Basic Information page " +
          "(Signing Secret field). Slack uses this single value to sign all webhook events.",
      },
      400,
    );
  }

  const { slack } = buildProviders(c.env);

  let result;
  try {
    result = await slack.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: body.formToken,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        signingSecret: body.signingSecret,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run slack publish to mint a fresh form token (TTL ~30 min).",
        },
        400,
      );
    }
    return c.json({ error: "credentials_failed", details: msg }, 400);
  }

  if (result.kind !== "step" || result.step !== "install_link") {
    return c.json({ error: "unexpected continue result", result }, 500);
  }
  return c.json(result.data);
});

interface HandoffLinkBody {
  formToken: string;
}

/**
 * POST /slack/publications/handoff-link
 * Body: { formToken } from a prior /start-a1 call.
 * Returns: { url, expiresInDays } — share this URL with a workspace admin.
 */
app.post("/handoff-link", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<HandoffLinkBody>();
  if (!body.formToken) return c.json({ error: "formToken required" }, 400);

  const { slack } = buildProviders(c.env);

  let result;
  try {
    result = await slack.continueInstall({
      publicationId: null,
      payload: { kind: "handoff_link", formToken: body.formToken },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run slack publish to mint a fresh form token (TTL ~30 min).",
        },
        400,
      );
    }
    return c.json({ error: "handoff_failed", details: msg }, 400);
  }

  if (result.kind !== "step" || result.step !== "install_link") {
    return c.json({ error: "unexpected handoff result", result }, 500);
  }
  return c.json(result.data);
});

export default app;
