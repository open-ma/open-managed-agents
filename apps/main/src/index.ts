import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import { servicesMiddleware, tenantDbMiddleware, getCfServicesForTenant } from "@open-managed-agents/services";
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
import usageRoutes from "./routes/usage";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { runtimesRoutes, runtimeDaemonRoutes, authenticateRuntimeToken } from "./routes/runtimes";
import mcpProxyRoutes, {
  resolveProxyTargetByTenant,
  resolveOutboundCredentialByHost,
  forwardWithRefresh,
} from "./routes/mcp-proxy";
import { tickEvalRuns } from "./eval-runner";
import { handleMemoryEvents } from "./queue/memory-events";
import { handleMemoryEventsDlq } from "./queue/memory-events-dlq";
import { memoryRetentionTick } from "./cron/memory-retention";
import { webhookEventsRetentionTick } from "./cron/webhook-events-retention";
import { log, logError, recordEvent, errFields } from "@open-managed-agents/shared";
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
app.route("/v1/usage", usageRoutes);
app.route("/v1/integrations", integrationsRoutes);
app.route("/v1/runtimes", runtimesRoutes);
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
    // Memory versions retention sweep — daily at 03:00 UTC, no-op other minutes.
    // The cron trigger is `* * * * *` (every minute); the tick gates by hour
    // + minute internally so we only do work once per day.
    ctx.waitUntil(memoryRetentionTick(env));
    // Webhook events retention — daily at 04:00 UTC (offset from 03:00
    // memory sweep so the two don't collide on D1 budget).
    ctx.waitUntil(webhookEventsRetentionTick(env));
    // base_snapshot env-prep tick: REMOVED. Was a cron-driven poll over
    // building envs feeding the (also-removed) prep-tick endpoint. The
    // base_snapshot lazy-install path that came after it was reverted
    // too — dockerfile/CI is now the only build path.
  },
  // Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
  // R2 → Queue → here: we reflect agent FUSE writes on /mnt/memory/<store>/
  // back into D1 (memories index + memory_versions audit) since FUSE writes
  // bypass the REST service. REST writes also produce events but the consumer
  // dedupes by (store_id, path, etag) so they're no-ops.
  //
  // The same worker is also subscribed to the DLQ so messages that
  // exhausted retries don't disappear silently — see queue/memory-events-dlq.
  // batch.queue discriminates which consumer fired.
  async queue(batch: MessageBatch<R2EventMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue.endsWith("-dlq")) {
      await handleMemoryEventsDlq(batch, env);
      return;
    }
    await handleMemoryEvents(batch, env);
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
