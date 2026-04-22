// Builds and caches the integration providers for a given environment.
//
// The providers are light-weight to construct, but caching avoids rebuilding
// HTTP clients + reading config on every request.

import { LinearProvider, DEFAULT_LINEAR_SCOPES, ALL_CAPABILITIES } from "@open-managed-agents/linear";
import {
  GitHubProvider,
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "@open-managed-agents/github";
import type { Container } from "@open-managed-agents/integrations-core";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
  github: GitHubProvider;
}

export function buildProviders(env: Env, container: Container): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

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

  return { linear, github };
}
