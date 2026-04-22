// Cloudflare bindings for the integrations gateway worker.
//
// Keep this file small. It is the single typed surface for env access; every
// other file should consume Env via the composition root, not directly from
// `c.env`.

export interface Env {
  // Shared with apps/main — same database, additional tables for integrations.
  AUTH_DB: D1Database;

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
}
