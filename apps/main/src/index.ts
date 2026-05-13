import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import { servicesMiddleware, tenantDbMiddleware, getCfServicesForTenant } from "@open-managed-agents/services";
import {
  buildAgentRoutes,
  buildVaultRoutes,
  buildSessionRoutes,
  buildApiKeyRoutes,
  buildMeRoutes,
  buildTenantRoutes,
  mintApiKeyOnStorage,
} from "@open-managed-agents/http-routes";
import {
  createCfShardPoolService,
  createCfTenantShardDirectoryService,
} from "@open-managed-agents/tenant-dbs-store";
import { LOCAL_RUNTIME_ENV_ID } from "@open-managed-agents/shared";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware, authRateLimitMiddleware } from "./rate-limit";
import { cfRouteServices } from "./lib/cf-route-services";
import { cfApiKeyStorage } from "./lib/cf-api-key-storage";
import { CfSessionRouter } from "./lib/cf-session-router";
import {
  cfSessionLifecycle,
  cfOutputsAdapter,
  fetchVaultCredentials,
} from "./lib/cf-session-lifecycle";
import { validateAgentLimits } from "./lib/limits";
import { listMemberships, hasMembership } from "./auth-config";
import environmentsRoutes from "./routes/environments";
import oauthRoutes from "./routes/oauth";
import capCliOauthRoutes from "./routes/cap-cli-oauth";
import memoryRoutes from "./routes/memory";
import filesRoutes from "./routes/files";
import skillsRoutes from "./routes/skills";
import modelCardsRoutes from "./routes/model-cards";
import modelsRoutes from "./routes/models";
import clawhubRoutes from "./routes/clawhub";
import evalsRoutes from "./routes/evals";
import costReportRoutes from "./routes/cost-report";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { runtimesRoutes, runtimeDaemonRoutes, authenticateRuntimeToken } from "./routes/runtimes";
import statsRoutes from "./routes/stats";
import mcpProxyRoutes, {
  resolveProxyTargetByTenant,
  resolveOutboundCredentialByHost,
  forwardWithRefresh,
} from "./routes/mcp-proxy";
import { resolveGithubCredentials } from "./lib/github-creds";
import { buildCfScheduler } from "./lib/cf-scheduler-jobs";
import { buildCfMemoryQueue, dispatchCfMemoryQueueBatch } from "./lib/cf-queue-handlers";
import { logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { globalErrorHandler, requestMetricsMiddleware } from "./lib/observability";
import { errorEnvelopeMiddleware } from "./lib/error-envelope";
import type { R2EventMessage } from "@open-managed-agents/shared";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

// Request-level observability — must be the FIRST middleware so it
// captures every request including auth failures, rate-limit rejects,
// and unhandled exceptions. Pairs with globalErrorHandler below.
app.use("*", requestMetricsMiddleware);

// Normalize all 4xx/5xx JSON bodies into the Anthropic-compatible error
// envelope (`{type:"error", error:{type,message}, request_id}`) so callers
// of the official @anthropic-ai/sdk can `catch (e) { if (e.error?.error?.type
// === 'authentication_error') ... }`. Runs second so it sees the response
// body produced by every downstream middleware/handler. See lib/error-envelope.ts.
app.use("*", errorEnvelopeMiddleware);

// Catch-all for anything that escapes per-route try/catch. Logs +
// records to AE before returning a clean 500 (no internal leak in body).
app.onError(globalErrorHandler);

// Hono's default notFound is a plain "404 Not Found" body — wrap it in the
// Anthropic envelope so SDK callers can `if (e.error?.error?.type ===
// 'not_found_error')` instead of relying on raw status codes. Returning a
// JSON body here makes errorEnvelopeMiddleware's already-canonical short
// path kick in.
app.notFound((c) =>
  c.json(
    {
      type: "error" as const,
      error: {
        type: "not_found_error",
        message: `No route matched ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

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

// Build agent / vault / api-keys / me / tenants from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, AUTH_DB membership reads)
// get plumbed in here. Each mount is a Hono sub-app whose handler builds
// a one-shot package app per request — cheap (~µs of route registration)
// and keeps the per-tenant + per-request callbacks correctly scoped
// without leaking globals.

// Build agent / vault / api-keys / me / tenants / sessions from
// `@open-managed-agents/http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, AUTH_DB membership reads,
// USAGE_METER + refresh + GitHub fast-path lifecycle hooks) get plumbed
// in via closures over `c` so they always see the per-request services
// container without leaking globals.

type AppCtx = import("hono").Context<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    services: import("@open-managed-agents/services").Services;
    tenantDb: D1Database;
  };
}>;

const cfRouteServicesFromCtx = (c: AppCtx) =>
  cfRouteServices(c as never);

const agentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildAgentRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    validateModel: async (tenantId, model) => {
      const cards = await services.modelCards.list({ tenantId });
      const active = cards.filter((card) => card.archived_at === null);
      if (active.length === 0) return { valid: true };
      const modelId = typeof model === "string" ? model : model.id;
      const match = active.find((card) => card.model_id === modelId);
      if (!match) {
        return {
          valid: false,
          error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
        };
      }
      return { valid: true };
    },
    validateAgentLimits: (body) =>
      validateAgentLimits(body as Parameters<typeof validateAgentLimits>[0]),
    hasActiveSessionsByAgent: (tenantId, agentId) =>
      services.sessions.hasActiveByAgent({ tenantId, agentId }),
    hasActiveEvalsByAgent: (tenantId, agentId) =>
      services.evals.hasActiveByAgent({ tenantId, agentId }),
  });
  return invokePackage(c, app);
});

const vaultsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildVaultRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const apiKeysRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildApiKeyRoutes({ storage: cfApiKeyStorage(services.kv) });
  return invokePackage(c, app);
});

const meRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const app = buildMeRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    authDisabled: false,
    loadUser: async (userId) => {
      if (!env.AUTH_DB) return null;
      const r = await env.AUTH_DB
        .prepare(`SELECT id, email, name FROM "user" WHERE id = ?`)
        .bind(userId)
        .first<{ id: string; email: string; name: string | null }>();
      return r ?? null;
    },
    loadTenant: async (tenantId) => {
      if (!env.AUTH_DB) return null;
      const r = await env.AUTH_DB
        .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: (userId) => listMemberships(env.AUTH_DB, userId),
    hasMembership: (userId, tenantId) => hasMembership(env.AUTH_DB, userId, tenantId),
    mintApiKey: (input) =>
      mintApiKeyOnStorage(cfApiKeyStorage(services.kv), input),
  });
  return invokePackage(c, app);
});

const tenantsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const app = buildTenantRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    createTenantAndMembership: async ({ tenantId, name, userId }) => {
      const now = Math.floor(Date.now() / 1000);
      await env.AUTH_DB.batch([
        env.AUTH_DB
          .prepare("INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
          .bind(tenantId, name, now, now),
        env.AUTH_DB
          .prepare(
            "INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          )
          .bind(userId, tenantId, now),
      ]);
    },
    assignShard: async (tenantId) => {
      const controlPlaneDb = env.ROUTER_DB ?? env.AUTH_DB;
      const shardPool = createCfShardPoolService({ controlPlaneDb });
      const tenantShardDirectory = createCfTenantShardDirectoryService({ controlPlaneDb });
      const pick = await shardPool.pickShardForNewTenant();
      const bindingName = pick?.bindingName ?? "AUTH_DB_00";
      await tenantShardDirectory.assign({ tenantId, bindingName });
      await shardPool.incrementTenantCount(bindingName);
    },
  });
  return invokePackage(c, app);
});

const sessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const tenantId = ctx.var.tenant_id;
  const router = new CfSessionRouter({ env, services, tenantId });
  const app = buildSessionRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    router,
    localRuntimeEnvId: LOCAL_RUNTIME_ENV_ID,
    loadEnvironment: async ({ tenantId, environmentId }) => {
      if (environmentId === LOCAL_RUNTIME_ENV_ID) return null;
      const row = await services.environments.get({ tenantId, environmentId });
      return row ? toEnvironmentConfig(row) : null;
    },
    fetchVaultCredentials: ({ tenantId, vaultIds }) =>
      fetchVaultCredentials(services, tenantId, vaultIds),
    outputs: cfOutputsAdapter(env),
    debugRecoveryToken: (env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN,
    lifecycle: cfSessionLifecycle(c as never),
  });
  return invokePackage(c, app);
});

/**
 * Forward the outer Hono request into a freshly-built package app while
 * preserving (a) auth/tenant vars set by middleware (passed via per-call
 * middleware injected on the inner app), and (b) the relative URL the
 * package routes expect (`/`, `/:id`, etc.) — Hono's `app.route` only
 * strips the prefix when matching, not from `req.url`.
 */
function invokePackage(
  c: import("hono").Context,
  packageApp: { fetch: (req: Request, env?: unknown, ctx?: ExecutionContext) => Response | Promise<Response> },
): Promise<Response> | Response {
  const url = new URL(c.req.url);
  // Strip the outer mount prefix so e.g. `/v1/agents/abc` becomes `/abc`
  // before the package's `app.get("/:id")` sees it.
  const knownPrefixes = ["/v1/oma/", "/v1/"];
  let stripped = url.pathname;
  for (const p of knownPrefixes) {
    if (stripped.startsWith(p)) {
      // Drop the next path segment (resource name like "agents", "sessions").
      const rest = stripped.slice(p.length);
      const slashIdx = rest.indexOf("/");
      stripped = slashIdx === -1 ? "/" : rest.slice(slashIdx);
      break;
    }
  }
  url.pathname = stripped || "/";

  // Carry the outer auth vars (tenant_id, user_id) over the request via
  // headers so the inner app's middleware can re-hydrate them. Header
  // names are namespaced so they can't collide with user-controlled
  // headers; a stray client-supplied `x-oma-tenant-id` is overwritten.
  const headers = new Headers(c.req.raw.headers);
  const tenantId = (c.var as { tenant_id?: string }).tenant_id;
  const userId = (c.var as { user_id?: string }).user_id;
  if (tenantId) headers.set("x-oma-internal-tenant-id", tenantId);
  if (userId) headers.set("x-oma-internal-user-id", userId);

  // One-shot middleware: re-hydrate vars on the inner context.
  const wrapped = new Hono();
  wrapped.use("*", async (innerC, next) => {
    const t = headers.get("x-oma-internal-tenant-id");
    const u = headers.get("x-oma-internal-user-id");
    if (t) innerC.set("tenant_id" as never, t as never);
    if (u) innerC.set("user_id" as never, u as never);
    await next();
  });
  wrapped.route("/", packageApp as Parameters<typeof wrapped.route>[1]);

  return wrapped.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
    }),
    c.env,
    c.executionCtx,
  );
}
app.route("/v1/agents", agentsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/oauth", oauthRoutes);
app.route("/v1/cap-cli/oauth", capCliOauthRoutes);
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
app.route("/v1/runtimes", runtimesRoutes);
app.route("/v1/stats", statsRoutes);

// Billing-API proxy needs the session-resolved tenant_id, so it must
// run authMiddleware first. The proxy handler below short-circuits
// before tenantDb/services middlewares (it doesn't need them).
app.use("/billing-api/*", authMiddleware);
app.use("/billing-api/*", rateLimitMiddleware);

// Billing-API proxy — same-origin escape hatch for hosted plugins.
//
// Hosted Console (apps/console plugins/billing/) lives on app.openma.dev
// while the billing worker lives on billing.openma.dev. Direct browser
// → billing-worker calls would need CORS + a spoofable tenant header,
// since better-auth cookies don't cross subdomain boundaries by default
// and the billing worker has no auth middleware.
//
// Solution: proxy /billing-api/* through here. authMiddleware above has
// already resolved c.var.tenant_id from the session cookie; we forward
// to the USAGE_METER_HTTP service binding and inject x-oma-tenant-id
// server-side so the header is no longer client-controlled.
//
// In self-host (OSS-only) USAGE_METER_HTTP is unbound and this returns
// 404 — the hosted billing plugin isn't loaded there anyway, so no
// browser code reaches this route.
app.all("/billing-api/*", async (c) => {
  const meter = (c.env as { USAGE_METER_HTTP?: Fetcher }).USAGE_METER_HTTP;
  if (!meter) return c.json({ error: "billing not configured" }, 404);
  const tenantId = c.get("tenant_id" as never) as string | undefined;
  if (!tenantId) return c.json({ error: "unauthorized" }, 401);

  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/billing-api/, "");

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oma-tenant-id", tenantId);
  headers.delete("cookie"); // billing worker doesn't need it; reduces leak surface

  const init: RequestInit = {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD"
      ? null
      : await c.req.raw.clone().arrayBuffer(),
  };
  return meter.fetch(url.toString(), init);
});
// MCP proxy bypasses /v1/* authMiddleware (declared in auth.ts as a
// path-prefix skip) — auth is the Bearer oma_* the ACP child sends.
app.route("/v1/mcp-proxy", mcpProxyRoutes);

// /v1/oma/* aliases — OMA-only namespaces re-mounted under an `oma/` prefix
// so the public surface can grow into a clean two-tier API:
//   /v1/<resource>      — Anthropic-compatible (agents, sessions, vaults, ...)
//   /v1/oma/<resource>  — OMA-specific extensions (oauth, tenants, evals, ...)
//
// New code (and external callers) should prefer the /v1/oma/* paths.
// Internal Console/CLI keep using the bare paths until follow-up cleanup
// (the bare mounts above stay live for now). New OMA-only endpoints should
// be added here only, not above.
app.route("/v1/oma/clawhub", clawhubRoutes);
app.route("/v1/oma/api_keys", apiKeysRoutes);
app.route("/v1/oma/me", meRoutes);
app.route("/v1/oma/tenants", tenantsRoutes);
app.route("/v1/oma/evals", evalsRoutes);
app.route("/v1/oma/cost_report", costReportRoutes);
app.route("/v1/oma/integrations", integrationsRoutes);
app.route("/v1/oma/runtimes", runtimesRoutes);
app.route("/v1/oma/oauth", oauthRoutes);
app.route("/v1/oma/model_cards", modelCardsRoutes);
// /v1/mcp-proxy is intentionally NOT aliased: auth.ts path-prefix skip is
// scoped to that exact prefix, and the proxy does its own session-ownership
// check downstream. Re-mounting under /v1/oma/mcp-proxy would route through
// the standard authMiddleware and break the ACP child's transport.
// Daemon-facing routes — outside /v1/* so authMiddleware doesn't run.
// Apply tenantDbMiddleware + servicesMiddleware so daemon endpoints (like
// /agents/runtime/sessions/:sid/bundle) can use c.get("services").
app.use("/agents/runtime/*", tenantDbMiddleware);
app.use("/agents/runtime/*", servicesMiddleware);
app.route("/agents/runtime", runtimeDaemonRoutes);

// /agents/runtime/_attach — WebSocket upgrade for `oma bridge daemon`. We
// validate the runtime bearer token here, then forward to the RuntimeRoom
// DO with x-runtime-id / x-runtime-user headers it trusts.
app.get("/agents/runtime/_attach", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("WebSocket only", 400);
  }
  if (!c.env.RUNTIME_ROOM) return c.text("RUNTIME_ROOM binding missing", 503);
  const auth = c.req.header("authorization") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.text("unauthorized", 401);
  const stub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(ok.runtime_id));
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-attach-role", "daemon");
  fwd.headers.set("x-runtime-id", ok.runtime_id);
  fwd.headers.set("x-runtime-user", ok.user_id);
  return stub.fetch(fwd);
});

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
  // Cron entry — wrangler `triggers.crons` ticks every minute (`* * * * *`).
  // We rebuild the scheduler per tick (CF isolates are short-lived; the
  // builder is cheap), then dispatch by matching `controller.cron`.
  // Each registered handler runs under ctx.waitUntil so a slow tick
  // doesn't block the runtime.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduler = buildCfScheduler(env);
    for (const job of scheduler.list()) {
      if (job.cron !== controller.cron) continue;
      ctx.waitUntil(
        Promise.resolve(job.handler()).catch((err) => {
          logError({ op: `cron.${job.name}`, err }, `cron job ${job.name} failed`);
          recordEvent(env.ANALYTICS, {
            op: `cron.${job.name}.failed`,
            ...errFields(err),
          });
        }),
      );
    }
  },
  // Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
  // The runtime-agnostic dispatcher routes to the main consumer or the
  // DLQ subscriber based on `batch.queue`. Handler bodies live in
  // packages/queue/handlers/* (main) and lib/cf-queue-handlers.ts (DLQ
  // notification + AE recording, which is CF-specific plumbing).
  async queue(batch: MessageBatch<R2EventMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const q = buildCfMemoryQueue(env);
    await dispatchCfMemoryQueueBatch(batch, q);
  },
};

// DO classes must be re-exported from the worker entry so wrangler can find
// them by class_name in durable_objects.bindings + migrations.
export { RuntimeRoom } from "./runtime-room";

/**
 * RPC entrypoint for the agent worker (cloud agent path) to forward MCP
 * requests through main's credential-injection layer without exposing the
 * vault to the agent's DO.
 *
 * Mirrors Anthropic Managed Agents' "credential proxy outside the harness"
 * design: the agent worker (the harness) only knows session_id +
 * server_name; the actual vault lookup, token injection, and upstream call
 * happen here in main, where the secrets already live. This means a
 * cloud-side prompt-injection attack against the agent's DO cannot read
 * any vault credential because the DO doesn't hold one.
 *
 * Auth model: this class is reachable only via wrangler service-binding
 * declarations — Workers without an explicit `services[].entrypoint` block
 * pointing at "McpProxyRpc" cannot invoke `mcpForward`. The binding itself
 * is the authentication primitive; no shared secret needed. The agent
 * worker passes `tenantId` because it has it from the SessionDO context;
 * we trust it the same way we'd trust any in-process function call from
 * sibling code, since the binding scope establishes that the caller is
 * our own deployment.
 *
 * Local-runtime path (claude-agent-acp daemon) keeps using the public
 * /v1/mcp-proxy/<sid>/<server> HTTP endpoint with apiKey auth — the
 * daemon doesn't have a service binding, so it has to authenticate the
 * old way. Both paths converge on the same `resolveProxyTargetByTenant` +
 * `forwardToUpstream` helpers in routes/mcp-proxy.ts.
 */
export class McpProxyRpc extends WorkerEntrypoint<Env> {
  async mcpForward(opts: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    method: string;
    /** Inbound headers from the MCP client. The Authorization header here is
     *  the agent worker's own token (or empty); we always overwrite it with
     *  the upstream credential before forwarding. */
    headers: Record<string, string>;
    /** Stringified JSON-RPC body for POST. Empty / null for GET. */
    body: string | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.serverName,
    );
    if (!target) {
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"error":"forbidden"}',
      };
    }
    const inboundHeaders = new Headers(opts.headers);
    const res = await forwardWithRefresh(
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, serverName: opts.serverName, callerKind: "rpc-mcp" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.text(),
    };
  }

  /**
   * Transparent HTTP proxy for cloud agent MCP traffic. Agent's tools.ts
   * gives AI SDK's MCP HTTP transport a custom fetch that calls
   * `env.MAIN_MCP.fetch(req)` after stamping three metadata headers:
   *   - `x-oma-tenant`
   *   - `x-oma-session`
   *   - `x-oma-mcp-server`
   * We resolve the vault credential by `serverName` (mirrors the legacy
   * `mcpForward` path so inline `authorization_token` still works),
   * strip the metadata, replace the `authorization` header with the
   * upstream bearer, and forward to the URL the agent's transport
   * already knew (request URL is the upstream URL). Body / response
   * status / response headers (including rotated `Mcp-Session-Id`)
   * stream through unchanged.
   *
   * Vault credentials remain main-only — agent worker only sees the
   * Response. The SDK's HTTP transport handles Streamable-HTTP session
   * id rotation, SSE response framing, retries — none of that lives
   * in this Worker anymore. The hand-rolled BindingMCPTransport that
   * preceded this dropped session ids and broke session-ful servers
   * (Notion's tools/list never returned, hanging the whole turn).
   *
   * 401-refresh-and-retry: handled by `forwardWithRefresh` (shared with
   * the legacy mcpForward + HTTP /v1/mcp-proxy paths). When the first
   * upstream response is 401 AND the resolved credential carries
   * `mcp_oauth` refresh metadata (refresh_token + token_endpoint), we
   * hit the token_endpoint, persist the rotated tokens back to D1, and
   * retry the upstream call once with the fresh bearer. Request body
   * is buffered up-front so the retry can replay it.
   */
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return new Response(
        '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const services = await getCfServicesForTenant(this.env, tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      tenantId,
      sessionId,
      serverName,
    );
    if (!target) {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    // Strip routing metadata before forwarding upstream. Everything else
    // (Mcp-Session-Id, content-type, accept, …) flows through.
    // forwardWithRefresh injects/replaces Authorization itself.
    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    // Buffer body so forwardWithRefresh can replay on a 401-then-refresh
    // retry. MCP request bodies are JSON-RPC envelopes — sub-KB in
    // practice — so the buffering cost is negligible. Response body is
    // unaffected and still streams back.
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardWithRefresh(
      services,
      tenantId,
      target,
      request.method,
      inboundHeaders,
      body,
      { sessionId, serverName, callerKind: "rpc-mcp" },
    );
  }

  /**
   * Lightweight credential lookup for the transparent outbound proxy.
   * Returns just the auth token + type for the host, or null if no
   * credential matches. The agent worker injects the Authorization header
   * itself and forwards the request transparently — body and response
   * never cross the RPC boundary, preserving HEAD Content-Length, SigV4
   * signed headers, chunked encoding, streaming, etc.
   *
   * Replaces the body-buffered `outboundForward` for the common-case
   * Bearer-injection path. `outboundForward` remains for callers that
   * need 401-refresh-and-retry (mcp_oauth with refresh_token), since
   * that requires keeping the refresh token in main worker.
   *
   * Security model change: agent worker briefly holds the bearer token
   * in memory during a single request handler invocation. Container
   * still never sees plaintext (auth header is added on agent worker
   * side, the SDK's TLS-MITM re-encrypts back to container). Trade-off
   * vs the body-buffered path: agent worker compromise can leak tokens
   * observed during the brief window; in exchange, we get a working
   * transparent proxy.
   */
  async lookupOutboundCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
  }): Promise<{ type: "bearer"; token: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
    );
    if (!cred) return null;
    return { type: "bearer", token: cred.upstreamToken };
  }

  /**
   * Per-repo GitHub credential lookup for the network-layer proxy.
   *
   * Returns:
   *   - null  → no credential available (caller passes through unauth'd):
   *             host isn't a GitHub host we route, OR session is gone /
   *             archived, OR session has no github_repository resources
   *   - {...} → the chosen token + scheme + owner/repo slug. Slug is for
   *             log correlation; the token never lands in any log.
   *
   * Pick rule: path-matched resource if the request URL has owner/repo
   * AND it matches a resource; otherwise the first declared resource's
   * token. See `resolveGithubCredentials` for the trade-off rationale.
   */
  async lookupGithubCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
    pathname: string;
  }): Promise<{ scheme: "Basic" | "Bearer"; token: string; slug: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    return resolveGithubCredentials(
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
      opts.pathname,
    );
  }

  /**
   * Transparent HTTP proxy for cloud agent MCP traffic. Agent's tools.ts
   * gives AI SDK's MCP HTTP transport a custom fetch that calls
   * `env.MAIN_MCP.fetch(req)` after stamping three metadata headers:
   *   - `x-oma-tenant`
   *   - `x-oma-session`
   *   - `x-oma-mcp-server`
   * We resolve the vault credential by `serverName` (mirrors the legacy
   * `mcpForward` path so inline `authorization_token` still works),
   * strip the metadata, replace the `authorization` header with the
   * upstream bearer, and forward to the URL the agent's transport
   * already knew (request URL is the upstream URL). Body / response
   * status / response headers (including rotated `Mcp-Session-Id`)
   * stream through unchanged.
   *
   * Vault credentials remain main-only — agent worker only sees the
   * Response. The SDK's HTTP transport handles Streamable-HTTP session
   * id rotation, SSE response framing, retries — none of that lives
   * in this Worker anymore. The hand-rolled BindingMCPTransport that
   * preceded this dropped session ids and broke session-ful servers
   * (Notion's tools/list never returned, hanging the whole turn).
   *
   * 401-refresh-and-retry: handled by `forwardWithRefresh` (shared with
   * the legacy mcpForward + HTTP /v1/mcp-proxy paths). When the first
   * upstream response is 401 AND the resolved credential carries
   * `mcp_oauth` refresh metadata (refresh_token + token_endpoint), we
   * hit the token_endpoint, persist the rotated tokens back to D1, and
   * retry the upstream call once with the fresh bearer. Request body
   * is buffered up-front so the retry can replay it.
   */
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return new Response(
        '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const services = await getCfServicesForTenant(this.env, tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      tenantId,
      sessionId,
      serverName,
    );
    if (!target) {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    // Strip routing metadata before forwarding upstream. Everything else
    // (Mcp-Session-Id, content-type, accept, …) flows through.
    // forwardWithRefresh injects/replaces Authorization itself.
    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    // Buffer body so forwardWithRefresh can replay on a 401-then-refresh
    // retry. MCP request bodies are JSON-RPC envelopes — sub-KB in
    // practice — so the buffering cost is negligible. Response body is
    // unaffected and still streams back.
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardWithRefresh(
      services,
      tenantId,
      target,
      request.method,
      inboundHeaders,
      body,
      { sessionId, serverName, callerKind: "rpc-mcp" },
    );
  }

  /**
   * Outbound counterpart to `mcpForward` for sandbox-side HTTPS calls
   * (anything the cloud agent's container does via fetch / curl). The
   * agent worker's outbound interceptor (apps/agent/src/oma-sandbox.ts)
   * passes only `(tenantId, sessionId, hostname, request bytes)`; we
   * resolve the matching vault credential live, inject Authorization,
   * and fetch upstream. The agent's container never sees the credential
   * and the agent worker never even loads it into memory.
   *
   * Body is passed as a string for now (sandbox HTTPS calls in OMA are
   * typically JSON-shaped; binary uploads to upstream APIs are rare and
   * can be added by widening to ArrayBuffer when a real use case lands).
   * Pass-through when no credential matches: same behavior as the legacy
   * snapshot-based path — public APIs and pre-authenticated URLs work.
   */
  async outboundForward(opts: {
    tenantId: string;
    sessionId: string;
    /** Full upstream URL the sandbox is trying to reach. */
    url: string;
    method: string;
    headers: Record<string, string>;
    /**
     * Request body as raw bytes. ArrayBuffer over the RPC wire — preserves
     * binary content (wheels, tarballs, image layers) that string body
     * silently mangled via UTF-8 decode. CF Worker RPC supports
     * ArrayBuffer via structured-clone-like serialization. Per-call size
     * is capped (~32 MB) — multi-GB streaming uploads still need a
     * dedicated path.
     */
    body: ArrayBuffer | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(opts.url);
    } catch {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"error":"invalid url"}').buffer as ArrayBuffer,
      };
    }

    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      parsedUrl.hostname,
    );

    const inboundHeaders = new Headers(opts.headers);

    if (!cred) {
      // No matching credential — pass through without injection. Public
      // APIs and pre-authenticated URLs work this way; matches old
      // behavior of the snapshot interceptor (host miss → no header).
      // We still strip the CF-edge headers for cleanliness.
      inboundHeaders.delete("host");
      inboundHeaders.delete("cf-connecting-ip");
      inboundHeaders.delete("cf-ray");
      inboundHeaders.delete("x-forwarded-for");
      inboundHeaders.delete("x-forwarded-proto");
      inboundHeaders.delete("x-real-ip");
      const upstreamReq = new Request(opts.url, {
        method: opts.method,
        headers: inboundHeaders,
        body: ["GET", "HEAD"].includes(opts.method) ? undefined : opts.body,
      });
      const res = await fetch(upstreamReq);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        status: res.status,
        headers: respHeaders,
        body: await res.arrayBuffer(),
      };
    }

    // Override target.upstreamUrl with the actual URL the sandbox wants
    // to hit (resolveOutboundCredentialByHost only knows the credential's
    // mcp_server_url, but for outbound the caller might be hitting any
    // path on that host). forwardWithRefresh injects token + auto-refreshes
    // on 401 if the credential is mcp_oauth.
    const target = { ...cred, upstreamUrl: opts.url };
    const res = await forwardWithRefresh(
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, callerKind: "rpc-outbound" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.arrayBuffer(),
    };
  }
}
