import { Hono } from "hono";
import type { Env } from "./env";
import linearWebhook from "./routes/linear/webhook";
import linearPublications from "./routes/linear/publications";
import linearDedicatedCallback from "./routes/linear/dedicated-callback";
import linearSetupPage from "./routes/linear/setup-page";
import linearMcp from "./routes/linear/mcp";
import githubWebhook from "./routes/github/webhook";
import githubPublications from "./routes/github/publications";
import githubInstallCallback from "./routes/github/install-callback";
import githubSetupPage from "./routes/github/setup-page";
import githubManifest from "./routes/github/manifest";
import githubInternal from "./routes/github/internal";
import slackWebhook from "./routes/slack/webhook";
import slackPublications from "./routes/slack/publications";
import slackDedicatedCallback from "./routes/slack/dedicated-callback";
import slackSetupPage from "./routes/slack/setup-page";
import { buildContainer } from "./wire";
import { buildProviders } from "./providers";

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub +
// Slack), runs OAuth/install flows for installations, and hosts the MCP servers
// that expose external APIs to agent sessions.
//
// Provider logic lives in packages/<provider>; this app is the composition
// root that wires Cloudflare adapters into provider implementations.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// TEMP one-shot admin: dump a Linear installation's App OAuth access token.
// Used to validate end-to-end on a fresh env. Remove this route + the
// TEMP_DEBUG_TOKEN secret after verification.
app.get("/admin/dump-linear-installation-token", async (c) => {
  if (
    !c.env.TEMP_DEBUG_TOKEN ||
    c.req.header("x-debug-token") !== c.env.TEMP_DEBUG_TOKEN
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const id = c.req.query("installation_id");
  if (!id) return c.json({ error: "installation_id required" }, 400);
  const container = buildContainer(c.env);
  const inst = await container.installations.get(id);
  if (!inst) return c.json({ error: "not_found" }, 404);
  const token = await container.installations.getAccessToken(id);
  if (!token) return c.json({ error: "no token" }, 404);
  return c.json({
    installationId: inst.id,
    userId: inst.userId,
    workspaceId: inst.workspaceId,
    workspaceName: inst.workspaceName,
    vaultId: inst.vaultId,
    botUserId: inst.botUserId,
    scopes: inst.scopes,
    token,
  });
});

// TEMP one-shot admin: build a Linear OAuth re-authorize URL for an existing
// installation that pre-dates refresh_token capture. Open the returned URL,
// approve on linear.app, and the callback at /linear/oauth/reauth/.../callback
// rotates this row's tokens in place (capturing refresh_token this time).
// Remove together with /admin/dump-linear-installation-token.
app.get("/admin/linear-reauth-link", async (c) => {
  if (
    !c.env.TEMP_DEBUG_TOKEN ||
    c.req.header("x-debug-token") !== c.env.TEMP_DEBUG_TOKEN
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const installationId = c.req.query("installation_id");
  if (!installationId) return c.json({ error: "installation_id required" }, 400);

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env);

  let result;
  try {
    result = await linear.buildReauthorizeUrl({
      installationId,
      redirectBase: c.env.GATEWAY_ORIGIN,
    });
  } catch (err) {
    return c.json(
      { error: "build_reauth_url_failed", details: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
  // container is referenced indirectly via the provider; touch to silence
  // unused-var if the noUnusedLocals lint kicks in.
  void container;

  return c.json({
    installationId,
    appId: result.appId,
    workspaceName: result.workspaceName,
    botUserId: result.botUserId,
    authorizeUrl: result.authorizeUrl,
    note: "Open authorizeUrl, approve on linear.app, and the callback rotates this install's tokens in place.",
  });
});

// Linear
app.route("/linear/oauth/app", linearDedicatedCallback);
app.route("/linear/webhook", linearWebhook);
app.route("/linear/publications", linearPublications);
app.route("/linear/mcp", linearMcp);
app.route("/linear-setup", linearSetupPage);

// GitHub
app.route("/github/install/app", githubInstallCallback);
app.route("/github/manifest", githubManifest);
app.route("/github/internal", githubInternal);
app.route("/github/webhook", githubWebhook);
app.route("/github/publications", githubPublications);
app.route("/github-setup", githubSetupPage);

// Slack
app.route("/slack/oauth/app", slackDedicatedCallback);
app.route("/slack/webhook", slackWebhook);
app.route("/slack/publications", slackPublications);
app.route("/slack-setup", slackSetupPage);

export default {
  fetch: app.fetch,
};
