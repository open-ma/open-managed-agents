// Builds and caches both LinearProvider and SlackProvider for a given
// environment. Providers are light-weight to construct, but caching avoids
// rebuilding clients + reading config on every request.

import { LinearProvider, DEFAULT_LINEAR_SCOPES, ALL_CAPABILITIES } from "@open-managed-agents/linear";
import {
  SlackProvider,
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "@open-managed-agents/slack";
import { buildLinearContainer, buildSlackContainer } from "./wire";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
  slack: SlackProvider;
}

export function buildProviders(env: Env): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

  const linear = new LinearProvider(buildLinearContainer(env), {
    gatewayOrigin,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });

  const slack = new SlackProvider(buildSlackContainer(env), {
    gatewayOrigin,
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
  });

  return { linear, slack };
}
