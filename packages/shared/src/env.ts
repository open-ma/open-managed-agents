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
}
