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
import { buildProviders } from "./providers";

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub +
// Slack), runs OAuth/install flows for installations, and hosts the MCP servers
// that expose external APIs to agent sessions.
//
// Provider logic lives in packages/<provider>; this app is the composition
// root that wires Cloudflare adapters into provider implementations.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

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
