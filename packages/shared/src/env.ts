export interface Env {
  CONFIG_KV: KVNamespace;
  /** @deprecated Pre-shard binding. Equivalent to AUTH_DB_00 (the original
   *  openma-auth database) for back-compat during the shard rollout. New
   *  code MUST use `getShardForTenant(env, tenantId)` from
   *  @open-managed-agents/sql-client to route to the correct shard. */
  AUTH_DB: D1Database;
  /** Tenant→shard routing table. Holds tenant_shard + shard_pool tables.
   *  Every per-tenant query reads this first (cached in SHARD_CACHE_KV
   *  with 1hr TTL). See packages/sql-client/src/shard.ts. */
  ROUTER_DB?: D1Database;
  /** Tenant data shard 0 — the original openma-auth, holds all
   *  pre-shard tenants. */
  AUTH_DB_00?: D1Database;
  AUTH_DB_01?: D1Database;
  AUTH_DB_02?: D1Database;
  AUTH_DB_03?: D1Database;
  /** Integration subsystem D1 (linear_* / github_* / slack_* tables).
   *  Separate database from AUTH_DB to isolate webhook write traffic and
   *  let the integration subsystem evolve schema independently.
   *  Optional on workers that don't touch integration tables (sandbox /
   *  agent workers). Required on apps/main and apps/integrations. */
  INTEGRATIONS_DB?: D1Database;
  SEND_EMAIL?: SendEmail;
  // SESSION_DO and SANDBOX are only in sandbox workers
  SESSION_DO?: DurableObjectNamespace;
  SANDBOX?: DurableObjectNamespace;
  WORKSPACE_BUCKET?: R2Bucket;
  FILES_BUCKET?: R2Bucket;
  /** Memory store content bucket (Anthropic Managed Agents Memory model).
   *  Each memory keyed `<store_id>/<memory_path>`. R2 Event Notifications
   *  on this bucket route to the memory-events queue (see MEMORY_QUEUE).
   *  Mounted into agent sandboxes per attached store via
   *  sandbox.mountBucket(..., { prefix: "/<store_id>/", readOnly?: true }). */
  MEMORY_BUCKET?: R2Bucket;
  /** Optional producer binding for the memory-events queue. The queue is
   *  primarily fed by R2 Event Notifications (configured out-of-band via
   *  `wrangler r2 bucket notification create`); this binding only exists
   *  if some code path needs to enqueue messages directly (none today). */
  MEMORY_QUEUE?: Queue<R2EventMessage>;
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
  // WorkerEntrypoint RPC binding from the agent worker to the main worker's
  // McpProxyRpc class — see apps/main/src/index.ts. Cloud agents call
  // `env.MAIN_MCP.mcpForward({tenantId, sessionId, serverName, ...})` so
  // vault credential lookup + token injection happen in main where the
  // secrets already live, never in the agent's DO. Optional because main
  // worker doesn't have this binding (it's the target, not a caller).
  //
  // `outboundForward` is the sandbox-side equivalent: any HTTPS request
  // the cloud agent's container makes is intercepted by oma-sandbox.ts
  // and routed through here for vault-credential injection by hostname
  // match. Same "credentials only ever live in main" property.
  MAIN_MCP?: {
    mcpForward(opts: {
      tenantId: string;
      sessionId: string;
      serverName: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
    outboundForward(opts: {
      tenantId: string;
      sessionId: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: ArrayBuffer | null;
    }): Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }>;
    /**
     * Lightweight credential lookup for the transparent outbound proxy.
     * Returns the bearer token to inject for `hostname`, or null if no
     * vault credential matches. Used by oma-sandbox.ts inject_vault_creds
     * to keep body + response off the RPC wire (preserves HEAD,
     * streaming, SigV4 signed headers, etc).
     */
    lookupOutboundCredential(opts: {
      tenantId: string;
      sessionId: string;
      hostname: string;
    }): Promise<{ type: "bearer"; token: string } | null>;
  };
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
  /**
   * R2 S3 API credentials for sandbox containers to mount R2 buckets via
   * S3FS-FUSE (sandbox SDK's `RemoteMountBucketOptions`). When all three
   * are present, the sandbox uses FUSE mode (writes flow synchronously
   * over the S3 API and trigger R2 Event Notifications). When absent,
   * mountBucket falls back to `localBucket: true` — fine for `wrangler
   * dev`, but writes silently don't persist to R2 in production.
   *
   * R2 binding (e.g. `MEMORY_BUCKET`) is Worker-only; it can't be reached
   * from inside the sandbox container. These keys give the container
   * direct S3 access. Mint via CF Dashboard → R2 → Manage R2 API Tokens.
   */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  /**
   * Resolved bucket NAMES per environment — needed when mounting via FUSE
   * because the S3 API takes the actual bucket name (not the binding name).
   * Set via `vars` in wrangler.jsonc; overridden in env.staging.
   *   prod:    "managed-agents-memory"
   *   staging: "managed-agents-memory-staging"
   */
  MEMORY_BUCKET_NAME?: string;
  WORKSPACE_BUCKET_NAME?: string;
  /**
   * BACKUP_BUCKET_NAME (also CLOUDFLARE_ACCOUNT_ID above) are required by
   * @cloudflare/sandbox createBackup() in production mode — the SDK
   * mints R2 presigned URLs to upload the squashfs and needs both to
   * construct the URL. Without them createBackup throws
   * InvalidBackupConfigError. See sandbox.ts createWorkspaceBackup.
   */
  BACKUP_BUCKET_NAME?: string;
}

/**
 * Cloudflare R2 Event Notification message body. R2 publishes one of these
 * per object mutation when the bucket is wired to a Queue via
 * `wrangler r2 bucket notification create <bucket> --event-type ... --queue ...`.
 * The shape mirrors the public R2 events spec; if/when @cloudflare/workers-types
 * exports an official type for this, switch to it.
 */
export interface R2EventMessage {
  account: string;
  action:
    | "PutObject"
    | "CopyObject"
    | "CompleteMultipartUpload"
    | "DeleteObject"
    | "LifecycleDeletion";
  bucket: string;
  object: {
    key: string;
    size?: number;
    eTag?: string;
    version?: string;
  };
  eventTime: string;
  copySource?: { bucket: string; object: string };
}
