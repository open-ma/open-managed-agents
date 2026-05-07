// Builds and caches all integration providers for a given environment.
//
// Providers are light-weight to construct, but caching avoids rebuilding HTTP
// clients + reading config on every request.
//
// Note on container shape: each provider gets its own per-provider Container
// so the `installations`/`publications` slots resolve to the right backing
// table (linear_*/github_*/slack_*). See wire.ts.

import { LinearProvider, DEFAULT_LINEAR_SCOPES, ALL_CAPABILITIES } from "@open-managed-agents/linear";
import {
  GitHubProvider,
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "@open-managed-agents/github";
import {
  SlackProvider,
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "@open-managed-agents/slack";
import type { LinearContainer } from "@open-managed-agents/linear";
import { buildContainer, buildGitHubContainer, buildSlackContainer } from "./wire";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
  github: GitHubProvider;
  slack: SlackProvider;
}

/**
 * Build all providers. The optional `linearContainer` lets callers reuse a
 * pre-built Linear container — handy when a Linear route handler already
 * built one for direct repo access. The github / slack containers are
 * always built fresh because they target different per-provider tables.
 */
export function buildProviders(env: Env, linearContainer?: LinearContainer): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

  const linear = new LinearProvider(linearContainer ?? buildContainer(env), {
    gatewayOrigin,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });

  const github = new GitHubProvider(buildGitHubContainer(env), {
    gatewayOrigin,
    defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
    // Override per-deploy via env to point at a self-hosted MCP if needed.
    mcpServerUrl: env.GITHUB_MCP_URL ?? DEFAULT_GITHUB_MCP_URL,
  });

  const slack = new SlackProvider(buildSlackContainer(env), {
    gatewayOrigin,
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
  });

  return { linear, github, slack };
}
