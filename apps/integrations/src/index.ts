import { Hono } from "hono";
import type { Env } from "./env";
import linearWebhook from "./routes/linear/webhook";
import linearPublications from "./routes/linear/publications";
import linearDedicatedCallback from "./routes/linear/dedicated-callback";
import linearSetupPage from "./routes/linear/setup-page";
import githubWebhook from "./routes/github/webhook";
import githubPublications from "./routes/github/publications";
import githubInstallCallback from "./routes/github/install-callback";
import githubSetupPage from "./routes/github/setup-page";
import githubManifest from "./routes/github/manifest";
import githubInternal from "./routes/github/internal";

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub
// today; Slack later), runs OAuth/install flows for installations, and hosts
// the MCP servers that expose external APIs to agent sessions.
//
// Provider logic lives in packages/<provider>; this app is the composition
// root that wires Cloudflare adapters into provider implementations.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Linear
app.route("/linear/oauth/app", linearDedicatedCallback);
app.route("/linear/webhook", linearWebhook);
app.route("/linear/publications", linearPublications);
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
