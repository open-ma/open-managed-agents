// Cloudflare bindings for the integrations gateway worker.
//
// Keep this file small. It is the single typed surface for env access; every
// other file should consume Env via the composition root, not directly from
// `c.env`.

export interface Env {
  // Control-plane DB — user / tenant / vault / session metadata. Shared
  // with apps/main.
  AUTH_DB: D1Database;

  // Integration subsystem DB — linear_* / github_* / slack_* tables.
  // Separate D1 database from AUTH_DB. Schema in
  // apps/main/migrations-integrations/.
  INTEGRATIONS_DB: D1Database;

  // Service binding to the main worker for session creation / resume.
  MAIN: Fetcher;

  // Public origin where this gateway worker is reachable. Used to build
  // OAuth callback and webhook URLs surfaced to Linear / Slack / etc.
  // No trailing slash. e.g. "https://integrations.example.com".
  GATEWAY_ORIGIN: string;

  // Signs short-lived JWTs handed to agent sessions for MCP tool calls.
  // Also used as the seed for AES-GCM token-at-rest encryption (with a
  // distinct label per use, so JWT signing keys ≠ token encryption keys).
  MCP_SIGNING_KEY: string;

  // Shared secret with apps/main, gating /v1/internal/* endpoints. Must match
  // INTEGRATIONS_INTERNAL_SECRET on the main worker.
  INTEGRATIONS_INTERNAL_SECRET: string;

  // Optional override for the GitHub MCP server URL. Defaults to the
  // GitHub-hosted MCP at https://api.githubcopilot.com/mcp/. Set to a
  // self-hosted endpoint (e.g. https://github-mcp.internal/) to point
  // agents at a relay you control.
  GITHUB_MCP_URL?: string;

  // TEMP: gates one-shot admin endpoint that dumps a Linear installation's
  // App OAuth access token. Remove after verifying staging end-to-end.
  TEMP_DEBUG_TOKEN?: string;

  // Per-IP and per-tenant rate limit on webhook receivers. Optional —
  // middleware soft-passes when absent so dev / OSS deployments without
  // CF Rate Limiting configured still work. Tuned in wrangler.jsonc.
  RL_WEBHOOK_IP?: RateLimit;
  RL_WEBHOOK_TENANT?: RateLimit;
}
