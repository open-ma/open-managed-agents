export interface Env {
  CONFIG_KV: KVNamespace;
  AUTH_DB: D1Database;
  SEND_EMAIL?: SendEmail;
  // SESSION_DO and SANDBOX are only in sandbox workers
  SESSION_DO?: DurableObjectNamespace;
  SANDBOX?: DurableObjectNamespace;
  WORKSPACE_BUCKET?: R2Bucket;
  FILES_BUCKET?: R2Bucket;
  // Cloudflare Browser Rendering — only bound on agent worker (sandbox-default)
  BROWSER?: Fetcher;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /** Analytics Engine binding for structured error/event metrics. Optional —
   *  observability writes degrade to no-op when absent (dev / tests). See
   *  packages/shared/src/metrics.ts for the schema convention. */
  ANALYTICS?: AnalyticsEngineDataset;
  /** CF Workers Rate Limiting bindings — declared in wrangler.jsonc.
   *  Each one is a fixed-window counter keyed by .limit({ key }). Period
   *  must be 10 or 60 seconds; tune limits in wrangler config. */
  RL_AUTH_IP?: RateLimit;
  RL_AUTH_SEND_IP?: RateLimit;
  RL_AUTH_SEND_EMAIL?: RateLimit;
  RL_API_USER_WRITE?: RateLimit;
  RL_API_USER_READ?: RateLimit;
  RL_SESSIONS_TENANT?: RateLimit;
  /** Per-tenant cap on R2-writing endpoints (POST /v1/files,
   *  POST /v1/skills/:id/versions). Soft-passes when absent. */
  RL_UPLOAD_TENANT?: RateLimit;
  /** Daily session-creation budget per tenant. KV-backed counter — see
   *  apps/main/src/quotas.ts. The number is the cap; absent or "0" =
   *  feature off (OSS-friendly). Counter key auto-expires next day. */
  SESSION_DAILY_CAP_PER_TENANT?: number;
  /** Single-upload body size cap in bytes for POST /v1/files and
   *  POST /v1/skills/:id/versions. Default 25MB if unset. */
  UPLOAD_MAX_BYTES?: number;
  /** Cloudflare Turnstile public site key. Surfaced to the Console via
   *  /auth-info; the Login page renders the widget when this is present
   *  and skips it (insecure!) when absent. Per CF, this is public —
   *  domain-bound, no secret. */
  TURNSTILE_SITE_KEY?: string;
  /** Cloudflare Turnstile secret key (wrangler secret put). The /auth/*
   *  middleware verifies tokens against CF's siteverify with this. When
   *  absent the middleware soft-passes — used during the brief window
   *  between deploying the code and provisioning the secret. */
  TURNSTILE_SECRET_KEY?: string;
  API_KEY: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  TAVILY_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  KV_NAMESPACE_ID?: string;
  RATE_LIMIT_WRITE?: number;
  RATE_LIMIT_READ?: number;
  // Shared with apps/integrations gateway. Gates /v1/internal/* endpoints.
  // Must match INTEGRATIONS_INTERNAL_SECRET on the integrations worker.
  INTEGRATIONS_INTERNAL_SECRET?: string;
  // Service binding to apps/integrations for proxying install initiation
  // calls from the Console (single-origin, no CORS).
  INTEGRATIONS?: Fetcher;
  // Public URL of the integrations gateway (used to build redirect URLs to
  // OAuth callbacks etc. when the gateway is on a different host).
  INTEGRATIONS_PUBLIC_URL?: string;
  // Used by integrations subsystem to sign tokens at rest. Gateway's value.
  MCP_SIGNING_KEY?: string;
  // Killswitch for per-tenant D1 routing. Unset / "true" / anything else =
  // routing enabled (the default — uses tenant_shard meta table). Set to
  // "false" or "0" to roll back to the shared-AUTH_DB provider without
  // redeploying code. Implemented in
  // packages/services/src/index.ts buildCfTenantDbProvider.
  PER_TENANT_DB_ENABLED?: string;
  // Per-store backend selection. JSON object mapping store key (e.g.
  // "agents", "sessions") to backend name ("cf" | "pg" | "memory"). Missing
  // entries default to "cf". Lets a deployment route a single store to a
  // self-hosted Postgres without touching service or route code — the
  // adapter layer is the only thing that changes.
  // Example: STORE_BACKENDS={"agents":"pg","sessions":"cf"}
  STORE_BACKENDS?: string;
  // Postgres connection string used by any pg-backed store. On Cloudflare
  // Workers, point this at a Hyperdrive connection string for production;
  // direct DSN works in local dev / Node deployments.
  DATABASE_URL?: string;
  /** Local-ACP-runtime control plane DO. Pairs the user's `oma bridge daemon`
   *  WebSocket with the ACP-proxy harness inside SessionDO so a session can
   *  delegate its agent loop to a Claude Code (or other ACP) child running
   *  on the user's machine. Bound only on apps/main. */
  RUNTIME_ROOM?: DurableObjectNamespace;
  /** Service binding from per-env sandbox workers back to the main worker.
   *  AcpProxyHarness uses this to call /v1/internal/runtime-turn — going
   *  through HTTP keeps the auth surface narrow (one internal-secret-gated
   *  endpoint) and avoids a cross-script DO binding. Bound on apps/agent. */
  MAIN?: Fetcher;
}
