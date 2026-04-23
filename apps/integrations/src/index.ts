import { Hono } from "hono";
import type { Env } from "./env";
import linearWebhook from "./routes/linear/webhook";
import linearPublications from "./routes/linear/publications";
import linearDedicatedCallback from "./routes/linear/dedicated-callback";
import linearSetupPage from "./routes/linear/setup-page";
import slackWebhook from "./routes/slack/webhook";
import slackPublications from "./routes/slack/publications";
import slackDedicatedCallback from "./routes/slack/dedicated-callback";
import slackSetupPage from "./routes/slack/setup-page";

// Integrations gateway worker: receives 3rd-party webhooks (Linear + Slack
// today; GitHub later), runs OAuth flows for installations, and hosts the
// MCP servers that expose external APIs to agent sessions.
//
// Provider logic lives in packages/<provider>; this app is the composition
// root that wires Cloudflare adapters into provider implementations.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/linear/oauth/app", linearDedicatedCallback);
app.route("/linear/webhook", linearWebhook);
app.route("/linear/publications", linearPublications);
app.route("/linear-setup", linearSetupPage);

app.route("/slack/oauth/app", slackDedicatedCallback);
app.route("/slack/webhook", slackWebhook);
app.route("/slack/publications", slackPublications);
app.route("/slack-setup", slackSetupPage);

export default {
  fetch: app.fetch,
};
