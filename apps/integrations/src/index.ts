import { Hono } from "hono";
import type { Env } from "./env";
import linearWebhook from "./routes/linear/webhook";
import linearPublications from "./routes/linear/publications";
import linearDedicatedCallback from "./routes/linear/dedicated-callback";
import linearSetupPage from "./routes/linear/setup-page";
import linearMcp from "./routes/linear/mcp";
import linearEventTap from "./routes/linear/event-tap";
import githubWebhook from "./routes/github/webhook";
import githubPublications from "./routes/github/publications";
import githubInstallCallback from "./routes/github/install-callback";
import githubSetupPage from "./routes/github/setup-page";
import githubManifest from "./routes/github/manifest";
import githubInternal from "./routes/github/internal";
import { buildContainer } from "./wire";

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub
// today; Slack later), runs OAuth/install flows for installations, and hosts
// the MCP servers that expose external APIs to agent sessions.
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

// Linear
app.route("/linear/oauth/app", linearDedicatedCallback);
app.route("/linear/webhook", linearWebhook);
app.route("/linear/publications", linearPublications);
app.route("/linear/mcp", linearMcp);
app.route("/linear/internal", linearEventTap);
app.route("/linear-setup", linearSetupPage);

// GitHub
app.route("/github/install/app", githubInstallCallback);
app.route("/github/manifest", githubManifest);
app.route("/github/internal", githubInternal);
app.route("/github/webhook", githubWebhook);
app.route("/github/publications", githubPublications);
app.route("/github-setup", githubSetupPage);

export default {
  fetch: app.fetch,
};
