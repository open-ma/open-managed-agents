import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Linear A1 (full identity) install flow.
//
// Three steps, three endpoints:
//   1. POST /linear/publications/start-a1
//      → returns { formToken, callbackUrl, webhookUrl, suggestedAppName, ... }
//   2. POST /linear/publications/credentials
//      → returns { url, appId, callbackUrl, webhookUrl }  (final URLs with appId)
//   3. GET  /linear/oauth/app/:appId/callback
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

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);
  const result = await linear.startInstall({
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
  webhookSecret: string;
}

app.post("/credentials", async (c) => {
  const body = await c.req.json<SubmitCredentialsBody>();
  if (!body.formToken || !body.clientId || !body.clientSecret || !body.webhookSecret) {
    return c.json(
      {
        error: "formToken, clientId, clientSecret, webhookSecret required",
        hint:
          "webhookSecret comes from the Linear App's webhook page (the 'lin_wh_…' value). " +
          "Linear auto-generates it; OMA can't predict it.",
      },
      400,
    );
  }

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);

  let result;
  try {
    result = await linear.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: body.formToken,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        webhookSecret: body.webhookSecret,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface JWT failures as a stable error code with remediation. The
    // raw "JwtSigner.verify: <reason>" detail is implementation-leaky; map
    // it to something a CLI / agent can reason about.
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run linear publish to mint a fresh form token (TTL ~30 min).",
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
 * POST /linear/publications/handoff-link
 * Body: { formToken } from a prior /start-a1 call.
 * Returns: { url, expiresInDays } — share this URL with a workspace admin.
 */
app.post("/handoff-link", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<HandoffLinkBody>();
  if (!body.formToken) return c.json({ error: "formToken required" }, 400);

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);

  let result;
  try {
    result = await linear.continueInstall({
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
          remediation: "Re-run linear publish to mint a fresh form token (TTL ~30 min).",
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
