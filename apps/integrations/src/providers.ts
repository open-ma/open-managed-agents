// Builds and caches the LinearProvider for a given environment.
//
// The provider is light-weight to construct, but caching avoids rebuilding
// the GraphQL client + reading config on every request.

import { LinearProvider, DEFAULT_LINEAR_SCOPES, ALL_CAPABILITIES } from "@open-managed-agents/linear";
import type { Container } from "@open-managed-agents/integrations-core";
import type { Env } from "./env";

export interface ProviderBundle {
  linear: LinearProvider;
}

export function buildProviders(env: Env, container: Container): ProviderBundle {
  // Trim trailing slash so we can safely concatenate paths.
  const gatewayOrigin = env.GATEWAY_ORIGIN.replace(/\/+$/, "");

  const linear = new LinearProvider(container, {
    sharedApp: {
      clientId: env.LINEAR_APP_CLIENT_ID,
      clientSecret: env.LINEAR_APP_CLIENT_SECRET,
      webhookSecret: env.LINEAR_APP_WEBHOOK_SECRET,
    },
    gatewayOrigin,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });

  return { linear };
}
