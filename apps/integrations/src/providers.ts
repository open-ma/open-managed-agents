// Builds and caches all integration providers for a given environment.
//
// Providers are light-weight to construct, but caching avoids rebuilding HTTP
// clients + reading config on every request.
//
// Note on container shape: Linear + GitHub share the standard `Container`
// (linear_*/github_* tables); Slack runs against parallel `slack_*` tables and
// builds its own `SlackContainer` internally.

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
import type { Container } from "@open-managed-agents/integrations-core";
import { buildContainer, buildSlackContainer } from "./wire";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
  github: GitHubProvider;
  slack: SlackProvider;
}

/**
 * Build all providers. The optional `sharedContainer` lets callers reuse a
 * pre-built shared container (Linear + GitHub) — handy when a route handler
 * needs both a provider and direct repo access. If omitted, a fresh shared
 * container is built. The Slack container is always built fresh because it
 * uses the parallel `slack_*` tables.
 */
export function buildProviders(env: Env, sharedContainer?: Container): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

  const container = sharedContainer ?? buildContainer(env);

  const linear = new LinearProvider(container, {
    gatewayOrigin,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });

  const github = new GitHubProvider(container, {
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
