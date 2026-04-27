import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { servicesMiddleware, tenantDbMiddleware } from "@open-managed-agents/services";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware, authRateLimitMiddleware } from "./rate-limit";
import agentsRoutes from "./routes/agents";
import environmentsRoutes from "./routes/environments";
import sessionsRoutes from "./routes/sessions";
import vaultsRoutes from "./routes/vaults";
import oauthRoutes from "./routes/oauth";
import memoryRoutes from "./routes/memory";
import filesRoutes from "./routes/files";
import skillsRoutes from "./routes/skills";
import modelCardsRoutes from "./routes/model-cards";
import modelsRoutes from "./routes/models";
import clawhubRoutes from "./routes/clawhub";
import apiKeysRoutes from "./routes/api-keys";
import meRoutes from "./routes/me";
import tenantsRoutes from "./routes/tenants";
import evalsRoutes from "./routes/evals";
import costReportRoutes from "./routes/cost-report";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { tickEvalRuns } from "./eval-runner";
import { log, logError, recordEvent, errFields } from "@open-managed-agents/shared";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (public — no authMiddleware, but rate-limited per-IP and
// per-email so a stranger can't spam OTP sends and burn the mail budget).
// Lazy import to avoid crashing workerd in test environments
app.use("/auth/*", authRateLimitMiddleware);
app.on(["GET", "POST"], "/auth/*", async (c) => {
  if (!c.env.AUTH_DB) return c.json({ error: "Auth not configured" }, 503);
  const { createAuth } = await import("./auth-config");
  return createAuth(c.env).handler(c.req.raw);
});

// Auth info endpoint (public — tells the frontend which providers are enabled
// and surfaces the Turnstile site key so the Login page can render the widget).
app.get("/auth-info", (c) => {
  const providers: string[] = ["email", "email-otp"];
  if (c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  return c.json({
    providers,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null,
  });
});

// API routes (require authentication)
app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
// Resolve the per-tenant D1 database for this request. Phase 1: returns the
// shared AUTH_DB for every tenant (zero behaviour change). Phase 4: routes
// to per-tenant bindings published by the CICD sync script.
app.use("/v1/*", tenantDbMiddleware);
// Build the platform-agnostic service container once per request and stash it
// on c.var.services. Wiring (CF / Postgres / SQLite) lives in
// packages/services — routes only see the abstract Services interface.
app.use("/v1/*", servicesMiddleware);
app.route("/v1/agents", agentsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/oauth", oauthRoutes);
app.route("/v1/memory_stores", memoryRoutes);
app.route("/v1/files", filesRoutes);
app.route("/v1/skills", skillsRoutes);
app.route("/v1/model_cards", modelCardsRoutes);
app.route("/v1/models", modelsRoutes);
app.route("/v1/clawhub", clawhubRoutes);
app.route("/v1/api_keys", apiKeysRoutes);
app.route("/v1/me", meRoutes);
app.route("/v1/tenants", tenantsRoutes);
app.route("/v1/evals", evalsRoutes);
app.route("/v1/cost_report", costReportRoutes);
app.route("/v1/integrations", integrationsRoutes);

// Internal endpoints (NOT auth-middleware'd; secured by header secret inside
// the route file). Called only by the integrations gateway worker via service
// binding.
app.route("/v1/internal", internalRoutes);

// Proxy public integrations gateway paths to the INTEGRATIONS service binding
// so Linear/GitHub can hit the OAuth callback / webhook URLs at this worker's
// host. (Local dev convenience: avoids running integrations on a separate port.)
app.all("/linear/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/linear-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tickEvalRuns(env).then(
        (result) =>
          log(
            { op: "cron.tick_eval_runs", advanced: result.advanced, total: result.total },
            "tickEvalRuns ok",
          ),
        (err) => {
          logError({ op: "cron.tick_eval_runs", err }, "tickEvalRuns failed");
          recordEvent(env.ANALYTICS, {
            op: "cron.tick_eval_runs.failed",
            ...errFields(err),
          });
        },
      ),
    );
    // base_snapshot env-prep tick: scan envs that the prepare-env handler
    // kicked off, probe each via the agent worker's /__internal/prep-tick,
    // which runs createBackup once install.done is present and POSTs the
    // handle to /v1/environments/:id/build-complete.
    ctx.waitUntil(
      tickBaseSnapshotPreps(env).then(
        (n) => log({ op: "cron.tick_base_snapshot", checked: n }, "tickBaseSnapshotPreps ok"),
        (err) => logError({ op: "cron.tick_base_snapshot", err }, "tickBaseSnapshotPreps failed"),
      ),
    );
  },
};

/**
 * One cron tick over base_snapshot envs sitting in `building`. For each,
 * fire-and-forget POST to the agent worker's prep-tick endpoint; the
 * agent worker probes the prep sandbox, runs createBackup if ready, and
 * callbacks `/v1/environments/:id/build-complete` with the handle.
 *
 * Does NOT await each tick — they're independent, and the cron
 * waitUntil budget is shared with eval ticks. We dispatch all in
 * parallel and let the agent worker's response come whenever.
 */
async function tickBaseSnapshotPreps(env: Env): Promise<number> {
  const internalToken = (env as unknown as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!internalToken) return 0;
  const binding = (env as unknown as Record<string, unknown>)["SANDBOX_sandbox_default"] as Fetcher | undefined;
  if (!binding) return 0;

  const result = await env.AUTH_DB
    .prepare(
      `SELECT id, tenant_id FROM environments
        WHERE status = 'building' AND image_strategy = 'base_snapshot'
        ORDER BY created_at ASC LIMIT 50`,
    )
    .all<{ id: string; tenant_id: string }>();
  const rows = result.results ?? [];

  await Promise.allSettled(
    rows.map(async (r) => {
      // Use a fake host since the binding routes by service, not URL.
      const callbackUrl = `https://openma.dev/v1/environments/${r.id}/build-complete`;
      const url = `https://internal/__internal/prep-tick/${r.id}?callback_url=${encodeURIComponent(callbackUrl)}`;
      try {
        await binding.fetch(url, {
          method: "POST",
          headers: { "x-internal-token": internalToken },
        });
      } catch {
        // Surface failure summary at next tick — single-tick error
        // shouldn't block other envs from advancing.
      }
    }),
  );
  return rows.length;
}
