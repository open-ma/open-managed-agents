import { Hono } from "hono";
import type { Env } from "./env";
import linearWebhook from "./routes/linear/webhook";
import linearPublications from "./routes/linear/publications";
import linearDedicatedCallback from "./routes/linear/dedicated-callback";
import linearSetupPage from "./routes/linear/setup-page";

// Integrations gateway worker: receives 3rd-party webhooks (Linear today;
// Slack/GitHub later), runs OAuth flows for installations, and hosts the
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

export default {
  fetch: app.fetch,
};
