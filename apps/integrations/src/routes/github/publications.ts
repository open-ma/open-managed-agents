import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// GitHub publish flow — mirrors the linear/publications.ts shape exactly so
// the Console can call /github/publications/* the same way it calls Linear.
//
// Endpoints:
//   1. POST /github/publications/start-a1
//      → { formToken, appOmaId, setupUrl, webhookUrl, suggestedAppName,
//          recommendedPermissions, recommendedSubscriptions }
//   2. POST /github/publications/credentials
//      → { url, appOmaId, appSlug, botLogin, setupUrl, webhookUrl }
//   3. GET  /github/install/app/:appOmaId/callback
//      → completes install, redirects to Console returnUrl
//
// /start-a1 and /handoff-link require x-internal-secret. /credentials is
// reachable directly from the user's browser (admin handoff) — auth there is
// the formToken JWT itself.

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

  const { github } = buildProviders(c.env);
  const result = await github.startInstall({
    userId: body.userId,
    agentId: body.agentId,
    environmentId: body.environmentId,
    mode: "full",
    persona: { name: body.personaName, avatarUrl: body.personaAvatarUrl ?? null },
    returnUrl: body.returnUrl,
  });

  if (result.kind !== "step" || result.step !== "credentials_form") {
    return c.json({ error: "unexpected install result", result }, 500);
  }
  return c.json(result.data);
});

interface SubmitCredentialsBody {
  formToken: string;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
}

app.post("/credentials", async (c) => {
  const body = await c.req.json<SubmitCredentialsBody>();
  if (!body.formToken || !body.appId || !body.privateKey || !body.webhookSecret) {
    return c.json(
      {
        error: "formToken, appId, privateKey, webhookSecret required",
        hint:
          "From your GitHub App settings page: appId is the numeric ID at the top, " +
          "privateKey is the PEM file you download under 'Private keys', " +
          "webhookSecret is whatever you set in 'Webhook secret'.",
      },
      400,
    );
  }

  const { github } = buildProviders(c.env);

  let result;
  try {
    result = await github.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: body.formToken,
        appId: body.appId,
        privateKey: body.privateKey,
        webhookSecret: body.webhookSecret,
        clientId: body.clientId ?? null,
        clientSecret: body.clientSecret ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run github publish to mint a fresh form token (TTL ~30 min).",
        },
        400,
      );
    }
    if (/appId mismatch/.test(msg)) {
      return c.json(
        {
          error: "credentials_mismatch",
          details: msg,
          remediation:
            "The numeric App ID you pasted doesn't match what GitHub sees for that " +
            "private key. Double-check both are from the same App's settings page.",
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

app.post("/handoff-link", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<HandoffLinkBody>();
  if (!body.formToken) return c.json({ error: "formToken required" }, 400);

  const { github } = buildProviders(c.env);

  let result;
  try {
    result = await github.continueInstall({
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
          remediation: "Re-run github publish to mint a fresh form token (TTL ~30 min).",
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
