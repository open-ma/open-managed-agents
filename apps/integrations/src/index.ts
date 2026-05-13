import { Hono } from "hono";
import type { Env } from "./env";
import linearPublications from "./routes/linear/publications";
import githubPublications from "./routes/github/publications";
import slackPublications from "./routes/slack/publications";
import slackSetupPage from "./routes/slack/setup-page";
import githubManifest from "./routes/github/manifest";
import { buildProviders } from "./providers";
import { buildContainer } from "./wire";
import { CfInstallBridge } from "./cf-install-bridge";
import { webhookRateLimitMiddleware, shouldDropForTenantRateLimit } from "./webhook-rate-limit";
import { linearDispatchTick } from "@open-managed-agents/scheduler/jobs/linear-dispatch";
import { getLogger } from "@open-managed-agents/observability";
import { buildIntegrationsGatewayRoutes } from "@open-managed-agents/http-routes";

const log = getLogger("apps.integrations");

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub +
// Slack), runs OAuth/install flows for installations, and hosts the MCP servers
// that expose external APIs to agent sessions.
//
// Most route bodies live in @open-managed-agents/http-routes via
// `buildIntegrationsGatewayRoutes` — this file just wires the CF-flavored
// install bridge + provider webhook handlers + per-IP/per-tenant rate
// limiting onto that. The publications + manifest-start endpoints stay
// here because they're CF-specific (return-shape preserved verbatim).
// Slack setup-page also stays as its own file because it surfaces a
// manifest-launch URL that isn't yet plumbed through the package; the
// rest of the providers' setup pages run from the package.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Defense-in-depth: /admin/* endpoints never existed (or were intentionally
// removed). Prod env always 404. Staging env requires TEMP_DEBUG_TOKEN
// (`x-debug-token`) — wrong/missing token = 401. Correct token falls
// through; current routes resolve to 404 because no admin handler is
// mounted. Staging detection uses \bstaging\b word boundary so hosts like
// `stagecoach.openma.dev` are NOT misclassified as staging. Mounted before
// the gateway middleware so the cheap reject runs first.
app.all("/admin/*", (c) => {
  const origin = c.env.GATEWAY_ORIGIN ?? "";
  const isStaging = /\bstaging\b/i.test(origin);
  if (!isStaging) return c.notFound();
  const token = c.req.header("x-debug-token");
  const expected = c.env.TEMP_DEBUG_TOKEN;
  if (!token || !expected || token !== expected) {
    return c.text("Unauthorized", 401);
  }
  return c.notFound();
});

// Per-IP rate limit on webhook receivers. Mounted before the package
// gateway so the cheap reject runs first.
app.use("/linear/webhook/*", webhookRateLimitMiddleware);
app.use("/github/webhook/*", webhookRateLimitMiddleware);
app.use("/slack/webhook/*", webhookRateLimitMiddleware);

// Publications/manifest-start CF-side wrappers (kept). These accept
// formToken POSTs from the browser and publish setup flows. Mounted
// before the gateway catch-all so they always win.
app.route("/linear/publications", linearPublications);
app.route("/github/publications", githubPublications);
app.route("/github/manifest", githubManifest);
app.route("/slack/publications", slackPublications);
app.route("/slack-setup", slackSetupPage);

// Package routes: OAuth callbacks, setup pages, Linear MCP, GitHub
// internal refresh, webhook receivers. The CfInstallBridge wraps the
// in-process providers (no service-binding hop).
app.use("*", async (c, next) => {
  const env = c.env;
  const bridge = new CfInstallBridge({ env });
  const providers = buildProviders(env);
  const container = buildContainer(env);
  const gateway = buildIntegrationsGatewayRoutes({
    installBridge: bridge,
    jwt: container.jwt,
    webhooks: {
      linear: (req) => providers.linear.handleWebhook(req),
      github: (req) => providers.github.handleWebhook(req),
      slack: (req) => providers.slack.handleWebhook(req),
    },
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET ?? null,
    rateLimit: {
      shouldDropForTenant: (tenantId) => shouldDropForTenantRateLimit(env, tenantId),
    },
  });
  // Slack's deferredWork callback needs ctx.waitUntil on CF — we can't
  // hand the package routes raw access to executionCtx, so re-attach
  // here. The Slack route in the package fires deferredWork() in the
  // background; on CF we want it under waitUntil so the isolate stays
  // alive until it completes.
  const res = await gateway.fetch(c.req.raw, env, c.executionCtx);
  if (res.status !== 404) return res;
  return next();
});

/**
 * Cron entry point — same as before. Linear dispatch sweep.
 */
async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const tick = linearDispatchTick({
    resolveSweeper: async () => {
      const { linear } = buildProviders(env);
      return linear;
    },
  });
  ctx.waitUntil(
    tick().catch((err) => {
      log.error(
        { err, op: "linear-dispatch-cron.fatal", cron: controller.cron },
        "linear-dispatch tick failed",
      );
    }),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
};
