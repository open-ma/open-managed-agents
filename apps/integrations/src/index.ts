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

// Staging-only gate for the TEMP admin endpoints below. We detect staging
// by hostname rather than introducing a new env var: only the staging
// `wrangler.jsonc` env stanza names "staging" in GATEWAY_ORIGIN. A prod
// deploy that accidentally inherits TEMP_DEBUG_TOKEN still gets 404'd.
function isStagingEnv(env: Env): boolean {
  return /\bstaging\b/i.test(env.GATEWAY_ORIGIN ?? "");
}

// TEMP one-shot admin: dump a Linear installation's App OAuth access token.
// Used to validate end-to-end on a fresh env. Remove this route + the
// TEMP_DEBUG_TOKEN secret after verification.
app.get("/admin/dump-linear-installation-token", async (c) => {
  if (!isStagingEnv(c.env)) {
    return c.notFound();
  }
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
  if (!isStagingEnv(c.env)) {
    return c.notFound();
  }
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

/**
 * Cron entry point. Wired to wrangler.jsonc `triggers.crons`. Runs the
 * Linear dispatch sweep — picks rules whose interval has elapsed and
 * assigns matching unassigned issues to the configured bot user.
 *
 * Per-rule failures are caught inside `runDispatchSweep` so a bad rule
 * doesn't poison the tick. We log a single line per cron invocation so
 * `wrangler tail` shows tick-level outcomes; the provider also logs
 * per-issue failures inline.
 */
async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { linear } = buildProviders(env);
  const startedAt = Date.now();
  // Cap rules per tick so one tenant with many rules doesn't push past
  // the cron CPU budget. 50 is generous; raise if needed.
  const RULE_LIMIT = 50;
  ctx.waitUntil(
    (async () => {
      try {
        // Sweep first: discovers + assigns new candidate issues. For OAuth-app
        // installs the assign mutation triggers a Linear webhook which the
        // webhook handler enqueues — picked up by drainPendingEvents below.
        // For PAT installs the sweep itself enqueues + spawns sessions inline
        // (no webhook source for PATs).
        const sweepSummary = await linear.runDispatchSweep(startedAt, RULE_LIMIT);
        // Drain queue: webhook-deposited events get their session spawned
        // here. Cap per-tick (25) so a flood doesn't consume the whole budget.
        const drainSummary = await linear.drainPendingEvents(startedAt, 25);
        console.log(
          `[linear-dispatch-cron] tick=${controller.cron} ` +
            `swept=${sweepSummary.sweptRules} assigned=${sweepSummary.assignedIssues} ` +
            `sweep_errors=${sweepSummary.errors.length} ` +
            `drained=${drainSummary.drainedEvents} ok=${drainSummary.succeeded} fail=${drainSummary.failed} ` +
            `dur_ms=${Date.now() - startedAt}`,
        );
        for (const e of sweepSummary.errors) {
          console.warn(`[linear-dispatch-cron] rule=${e.ruleId} err=${e.message}`);
        }
      } catch (err) {
        // Top-level failure — usually means container init failed (e.g.,
        // missing binding). Log loudly so wrangler tail surfaces it.
        console.error(
          `[linear-dispatch-cron] fatal err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })(),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
};
