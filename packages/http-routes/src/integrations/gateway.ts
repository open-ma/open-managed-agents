// Integrations gateway routes — OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, and the webhook receivers.
//
// The thin route bodies fan out to:
//   - InstallBridge.continueInstall (provider-routed; lookup of vault +
//     session binding is the bridge's job)
//   - InstallBridge.lookupLinearCredentialForSession (Linear MCP)
//   - InstallBridge.refreshGithubVault (GitHub internal endpoint)
//   - WebhookHandlers (per-provider, returns the same WebhookOutcome the
//     CF route consumed) — kept as a callback so the package doesn't
//     import @open-managed-agents/{linear,github,slack}.
//
// This file mirrors apps/integrations/src/routes/* one-for-one, with the
// CF-specific bits (executionCtx.waitUntil, env binding access) replaced by
// runtime-agnostic deps. CF wires them through service binding RPC; Node
// wires them through in-process services.
//
// Setup-page HTML is verbatim from the CF impl — re-rendered to match the
// existing console links a user might already have shared.

import { Hono } from "hono";
import type {
  InstallBridge,
  WebhookOutcome,
  WebhookRequest,
  JwtSigner,
} from "@open-managed-agents/integrations-core";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("http-routes.integrations.gateway");

/** Per-provider webhook handler closure. The host wires this to
 *  `provider.handleWebhook(req)` — keeps `@open-managed-agents/{linear,
 *  github,slack}` out of the http-routes deps. */
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookOutcome>;

export interface WebhookHandlers {
  linear?: WebhookHandler | null;
  github?: WebhookHandler | null;
  slack?: WebhookHandler | null;
}

/** Per-tenant rate-limit hook (CF wires the binding; Node soft-passes). */
export interface RateLimitHooks {
  shouldDropForTenant?(tenantId: string): Promise<boolean>;
}

export interface IntegrationsGatewayDeps {
  installBridge: InstallBridge;
  /** JwtSigner backing setup-page form-token verification + the OAuth state
   *  JWT. CF + Node both pass their WebCryptoJwtSigner here. */
  jwt: JwtSigner;
  /** Per-provider webhook closures. A null/undefined provider entry skips
   *  the webhook route mount. */
  webhooks: WebhookHandlers;
  /** Internal-secret required by /github/internal/* (the refresh-by-vault
   *  endpoint). Same secret CF used for the `INTEGRATIONS_INTERNAL_SECRET`
   *  service-binding gate. */
  internalSecret: string | null;
  /** Optional rate-limit hooks. Soft-pass when absent. */
  rateLimit?: RateLimitHooks;
}

export function buildIntegrationsGatewayRoutes(deps: IntegrationsGatewayDeps) {
  const app = new Hono();

  // ─── Linear ──────────────────────────────────────────────────────────
  // GET /linear/oauth/app/:appId/callback?code=&state=
  app.get("/linear/oauth/app/:appId/callback", async (c) => {
    const appId = c.req.param("appId");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "linear_oauth_denied", details: error }, 400);
    if (!appId || !code || !state) {
      return c.json({ error: "missing appId, code, or state" }, 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "linear",
        providerInstallationId: appId,
        code,
        state,
      });
      if (!result.returnUrl) {
        return c.json({ ok: true, publicationId: result.publicationId, flow: "complete" });
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "linear.oauth.callback.failed", appId, err: msg }, "linear callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /linear-setup/:token
  app.get("/linear-setup/:token", async (c) => {
    const token = c.req.param("token");
    let form: { persona: { name: string }; userId: string; agentId: string };
    try {
      form = await deps.jwt.verify<typeof form>(token);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
    }
    return c.html(linearLandingPage({ token, personaName: form.persona.name }));
  });

  // ─── GitHub ──────────────────────────────────────────────────────────
  // GET /github/install/app/:appOmaId/callback?installation_id=&setup_action=&state=
  app.get("/github/install/app/:appOmaId/callback", async (c) => {
    const appOmaId = c.req.param("appOmaId");
    const url = new URL(c.req.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "github_install_denied", details: error }, 400);
    if (!appOmaId || !installationId || !state) {
      return c.json({ error: "missing appOmaId, installation_id, or state" }, 400);
    }
    if (setupAction === "request") {
      return c.html(githubRequestPendingPage(setupAction), 200);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        providerInstallationId: appOmaId,
        state,
        extra: { installationId, setupAction },
      });
      if (!result.returnUrl) {
        return c.json({ ok: true, publicationId: result.publicationId });
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "github.install.callback.failed", appOmaId, err: msg }, "github callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /github/manifest/callback?code=&state=
  app.get("/github/manifest/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return c.html(errorPage("missing code or state in GitHub redirect"), 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        code,
        state,
        extra: { manifest: true },
      });
      if (!result.returnUrl) {
        return c.html(githubAutoRedirectPage({ installUrl: "/", returnUrl: "" }));
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(errorPage(`manifest exchange failed: ${msg}`), 500);
    }
  });

  // GET /github-setup/:token
  app.get("/github-setup/:token", async (c) => {
    const token = c.req.param("token");
    let form: { persona: { name: string }; userId: string; agentId: string; appOmaId: string };
    try {
      form = await deps.jwt.verify<typeof form>(token);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
    }
    return c.html(githubLandingPage({ token, personaName: form.persona.name }));
  });

  // POST /github/internal/refresh-by-vault — App-JWT install token mint.
  // Gated by INTEGRATIONS_INTERNAL_SECRET so it stays internal-only even
  // when mounted on a public Node port.
  app.post("/github/internal/refresh-by-vault", async (c) => {
    const expected = deps.internalSecret;
    if (!expected) return c.json({ error: "internal endpoints not configured" }, 503);
    const provided = c.req.header("x-internal-secret");
    if (!provided || provided !== expected) return c.json({ error: "unauthorized" }, 401);
    let body: { userId?: string; vaultId?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.userId || !body.vaultId) {
      return c.json({ error: "userId, vaultId required" }, 400);
    }
    try {
      const refreshed = await deps.installBridge.refreshGithubVault({
        userId: body.userId,
        vaultId: body.vaultId,
      });
      return c.json({ ok: true, token: refreshed.token, expiresAt: refreshed.expiresAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Match the CF route's 404 / 502 split rather than blanket 500 — the
      // session-create path branches on 404 vs 5xx.
      if (/no github installation|app row missing|private key missing/i.test(msg)) {
        return c.json({ error: msg }, 404);
      }
      return c.json({ error: "github_token_mint_failed", details: msg }, 502);
    }
  });

  // ─── Slack ───────────────────────────────────────────────────────────
  // GET /slack/oauth/app/:appId/callback?code=&state=
  app.get("/slack/oauth/app/:appId/callback", async (c) => {
    const appId = c.req.param("appId");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "slack_oauth_denied", details: error }, 400);
    if (!appId || !code || !state) {
      return c.json({ error: "missing appId, code, or state" }, 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "slack",
        providerInstallationId: appId,
        code,
        state,
      });
      if (!result.returnUrl) {
        return c.json({ ok: true, publicationId: result.publicationId });
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "slack.oauth.callback.failed", appId, err: msg }, "slack callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /slack-setup/:token
  app.get("/slack-setup/:token", async (c) => {
    const token = c.req.param("token");
    let form: { persona: { name: string }; userId: string; agentId: string };
    try {
      form = await deps.jwt.verify<typeof form>(token);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
    }
    return c.html(slackLandingPage({ token, personaName: form.persona.name }));
  });

  // ─── Webhooks ────────────────────────────────────────────────────────
  // Same /provider/webhook/app/:appId shape CF used. Each handler reads
  // the raw body, lowercases headers, and asks the provider via the
  // injected webhook closure. Always returns 200 (provider contract).
  if (deps.webhooks.linear) mountLinearWebhook(app, deps.webhooks.linear, deps.rateLimit);
  if (deps.webhooks.github) mountGithubWebhook(app, deps.webhooks.github, deps.rateLimit);
  if (deps.webhooks.slack) mountSlackWebhook(app, deps.webhooks.slack, deps.rateLimit);

  // ─── Linear MCP ──────────────────────────────────────────────────────
  app.post("/linear/mcp/:sessionId", async (c) => {
    return handleLinearMcp(c, deps.installBridge);
  });

  return app;
}

// ─── Webhook receivers (same shape as apps/integrations/src/routes/*) ──

function mountLinearWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  app.post("/linear/webhook/app/:appId", async (c) => {
    const appId = c.req.param("appId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const deliveryId = headers["linear-delivery"] ?? safeJsonField(rawBody, "webhookId");
    const outcome = await handler({
      providerId: "linear",
      installationId: appId ?? null,
      deliveryId,
      headers,
      rawBody,
    });
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      await rl.shouldDropForTenant(outcome.tenantId);
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

function mountGithubWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  app.post("/github/webhook/app/:appOmaId", async (c) => {
    const appOmaId = c.req.param("appOmaId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const deliveryId = headers["x-github-delivery"] ?? null;
    const outcome = await handler({
      providerId: "github",
      installationId: appOmaId,
      deliveryId,
      headers,
      rawBody,
    });
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      await rl.shouldDropForTenant(outcome.tenantId);
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

function mountSlackWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  app.post("/slack/webhook/app/:appId", async (c) => {
    const appId = c.req.param("appId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    if (appId) headers["x-internal-app-id"] = appId;
    const outcome = await handler({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers,
      rawBody,
    });
    if (outcome.challengeResponse !== undefined) {
      return new Response(outcome.challengeResponse, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      const dropped = await rl.shouldDropForTenant(outcome.tenantId);
      if (dropped) return c.json({ ok: false, reason: "tenant_rate_limited" }, 200);
    }
    if (outcome.deferredWork) {
      // Run in background — Slack's 3sec budget rules out inline. CF
      // still passes c.executionCtx.waitUntil under the hood; on Node the
      // promise just runs in the background.
      void outcome.deferredWork().catch((err) => {
        log.warn(
          { op: "slack.webhook.deferred.failed", err: err instanceof Error ? err.message : String(err) },
          "slack deferred work failed",
        );
      });
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

// ─── Linear MCP JSON-RPC ──────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "OMA Linear", version: "0.3.0" } as const;

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

async function handleLinearMcp(
  c: import("hono").Context,
  bridge: InstallBridge,
): Promise<Response> {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return jsonRpcError(null, -32001, "missing sessionId");
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!bearer) return jsonRpcError(null, -32001, "missing bearer token");

  let cred;
  try {
    cred = await bridge.lookupLinearCredentialForSession({ sessionId, bearerToken: bearer });
  } catch (err) {
    return jsonRpcError(null, -32001, `auth failed: ${(err as Error).message}`);
  }

  let body: JsonRpcReq;
  try {
    body = (await c.req.json()) as JsonRpcReq;
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id ?? null, -32600, "invalid request");
  }

  const id = body.id ?? null;
  switch (body.method) {
    case "initialize":
      return jsonRpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "OMA-side Linear escape hatch. Most issue/comment/state operations " +
          "should go through Linear's hosted MCP (mcp.linear.app/mcp), which " +
          "is also attached to this session. Use this server's `linear_graphql` " +
          "tool only when hosted MCP doesn't cover what you need.",
      });
    case "notifications/initialized":
      return new Response(null, { status: 204 });
    case "tools/list":
      return jsonRpcOk(id, { tools: [LINEAR_GRAPHQL_TOOL_DESCRIPTOR] });
    case "tools/call": {
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name !== "linear_graphql") {
        return jsonRpcError(id, -32601, `unknown tool: ${params.name}`);
      }
      try {
        const result = await runLinearGraphQL(cred, params.arguments ?? {});
        return jsonRpcOk(id, result);
      } catch (err) {
        return jsonRpcError(id, -32603, `tool failed: ${(err as Error).message}`);
      }
    }
    default:
      return jsonRpcError(id, -32601, `method not found: ${body.method}`);
  }
}

const LINEAR_GRAPHQL_TOOL_DESCRIPTOR = {
  name: "linear_graphql",
  title: "Raw Linear GraphQL escape hatch",
  description:
    "Run a single GraphQL query or mutation against Linear directly. Use " +
    "this for operations not covered by the curated tools above — creating " +
    "sub-issues, adding labels, attaching files, fetching team workflows, " +
    "etc.\n\n" +
    "Restrictions: exactly one operation per call (no multi-op documents). " +
    "Auth uses the publication's installation token, so the bot's effective " +
    "permissions are the OAuth app's scopes (read, write, app:assignable, " +
    "app:mentionable) — for personal-token installations, the PAT owner's " +
    "permissions.\n\n" +
    "Returns raw JSON. Errors come back as a structured `errors` array.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "GraphQL query or mutation source. Single operation only." },
      variables: { type: "object", description: "Optional GraphQL variables map." },
    },
    required: ["query"],
  },
};

async function runLinearGraphQL(
  cred: import("@open-managed-agents/integrations-core").LinearMcpCredentialLookupResult,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const query = String(args.query ?? "").trim();
  if (!query) return errResult("query required");
  const opMatches = query.match(/\b(query|mutation|subscription)\b/g) ?? [];
  if (opMatches.length > 1) {
    return errResult("multi-operation documents are not allowed; submit one operation per call");
  }
  const variables =
    args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
      ? (args.variables as Record<string, unknown>)
      : undefined;

  let token = cred.accessToken;
  let res = await linearGraphQLFetch(token, { query, variables });
  if (isAuthError(res.errors as Array<{ extensions?: { code?: string } }> | undefined)) {
    try {
      token = await cred.refreshAccessToken();
      res = await linearGraphQLFetch(token, { query, variables });
    } catch {
      // fall through with the original error
    }
  }
  const isError = Array.isArray(res.errors) && (res.errors as unknown[]).length > 0;
  const text = JSON.stringify({ data: res.data ?? null, errors: res.errors ?? null }, null, 2);
  return isError ? errResult(text) : okResult(text);
}

async function linearGraphQLFetch(
  accessToken: string,
  payload: { query: string; variables?: Record<string, unknown> },
): Promise<{ data?: unknown; errors?: unknown }> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      // PAT (`lin_api_…`) MUST be raw; OAuth tokens MUST be `Bearer <token>`.
      // Linear returns INPUT_ERROR if you Bearer-wrap a PAT.
      authorization: accessToken.startsWith("lin_api_") ? accessToken : `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { data?: unknown; errors?: unknown };
}

function isAuthError(errs: Array<{ extensions?: { code?: string } }> | undefined): boolean {
  if (!errs?.length) return false;
  return errs.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
}

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function jsonRpcOk<T>(id: string | number | null, result: T): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function safeJsonField(body: string, field: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// ─── Setup-page HTML (verbatim from CF impl) ─────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Link is invalid or expired</h1>
<p>${escapeHtml(message)}</p>
<p>Ask the original sender to generate a new setup link.</p>
</body></html>`;
}

function linearLandingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Linear app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
  </style>
</head>
<body>
  <h1>Set up "${escapedName}" in your Linear workspace</h1>
  <p>Someone on your team is installing OpenMA's <strong>${escapedName}</strong> agent
  into your Linear workspace. Linear app registration requires a workspace admin —
  that's where you come in.</p>

  <ol>
    <li>Open <a href="https://linear.app/settings/api" target="_blank">Linear → Settings → API</a> and create a new OAuth app:
      <ul>
        <li>Name: <code>${escapedName}</code></li>
        <li>Callback URL and Webhook URL: copy from the email/Slack message that brought you here</li>
        <li>Scopes: read, write, app:assignable, app:mentionable</li>
      </ul>
    </li>
    <li>Linear will give you <strong>Client ID</strong>, <strong>Client Secret</strong>,
      and a <strong>Webhook signing secret</strong> (starts with <code>lin_wh_</code>).
      Paste all three below — Linear auto-generates the webhook secret and OMA can't
      predict it, so we need it from you.</li>
    <li>Click "Continue" and approve the install in your Linear workspace.</li>
  </ol>

  <form id="f">
    <label for="cid">Client ID</label>
    <input id="cid" name="cid" required autocomplete="off">
    <label for="csec">Client Secret</label>
    <input id="csec" name="csec" type="password" required autocomplete="off">
    <label for="whsec">Webhook signing secret (lin_wh_…)</label>
    <input id="whsec" name="whsec" type="password" required autocomplete="off" placeholder="lin_wh_…">
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>

  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating…";
      msg.className = "";
      try {
        const res = await fetch("/linear/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            clientId: document.getElementById("cid").value.trim(),
            clientSecret: document.getElementById("csec").value.trim(),
            webhookSecret: document.getElementById("whsec").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to Linear to authorize…";
        msg.className = "ok";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        msg.className = "err";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function githubLandingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub App setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; }
    textarea { min-height: 120px; }
    button { margin-top: 16px; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
    .pillbar { display: flex; gap: 6px; flex-wrap: wrap; }
    .pillbar code { font-size: 11px; padding: 2px 6px; }
  </style>
</head>
<body>
  <h1>Install "${escapedName}" GitHub App on your org</h1>
  <p>Someone on your team is publishing OpenMA's <strong>${escapedName}</strong> agent
  to GitHub. GitHub App registration on an org requires an admin — that's where you come in.</p>
  <ol>
    <li>Open GitHub → Settings → Developer settings → New GitHub App.</li>
    <li>After saving, on the App's page download a <strong>private key</strong> (.pem). Note the <strong>App ID</strong> at the top.</li>
    <li>Paste the App ID, the contents of the .pem file, and the webhook secret you chose:</li>
  </ol>
  <form id="f">
    <label for="appid">App ID</label>
    <input id="appid" name="appid" required autocomplete="off" placeholder="e.g. 1234567">
    <label for="pkey">Private key (full PEM)</label>
    <textarea id="pkey" name="pkey" required autocomplete="off"></textarea>
    <label for="whsec">Webhook secret</label>
    <input id="whsec" name="whsec" type="password" required autocomplete="off">
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>
  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating with GitHub…";
      msg.className = "";
      try {
        const res = await fetch("/github/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            appId: document.getElementById("appid").value.trim(),
            privateKey: document.getElementById("pkey").value,
            webhookSecret: document.getElementById("whsec").value,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to GitHub to install the App on your org…";
        msg.className = "ok";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        msg.className = "err";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function githubRequestPendingPage(action: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Install requested</h1>
<p>The GitHub App install request was sent to an org owner (action: <code>${escapeHtml(action)}</code>).
Once they approve, GitHub will redirect here again with <code>setup_action=install</code> and OMA will
finish the publish then. You can close this tab.</p>
</body></html>`;
}

function githubAutoRedirectPage(opts: { installUrl: string; returnUrl: string }): string {
  const escUrl = escapeHtml(opts.installUrl);
  const escRet = escapeHtml(opts.returnUrl || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>App created — installing…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${escUrl}">
</head>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:60px auto;padding:0 20px;text-align:center">
  <h1>App created. Picking org / repos…</h1>
  <p>Redirecting to GitHub to install. If you're not redirected, <a href="${escUrl}">click here</a>.</p>
  ${escRet ? `<p style="font-size:13px;color:#666">After install you'll come back to <a href="${escRet}">your console</a>.</p>` : ""}
</body></html>`;
}

function slackLandingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Slack app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px;color:#111">
  <h1>Set up "${escapedName}" in your Slack workspace</h1>
  <p>Open <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps → Create New App</a>
  and follow the wizard. Then paste the credentials below.</p>
  <form id="f" style="margin-top:16px">
    <label>Client ID<input id="cid" required autocomplete="off"></label><br>
    <label>Client Secret<input id="csec" type="password" required autocomplete="off"></label><br>
    <label>Signing Secret<input id="ssec" type="password" required autocomplete="off"></label><br>
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>
  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating…";
      try {
        const res = await fetch("/slack/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            clientId: document.getElementById("cid").value.trim(),
            clientSecret: document.getElementById("csec").value.trim(),
            signingSecret: document.getElementById("ssec").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to Slack to authorize…";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
