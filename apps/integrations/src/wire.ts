// Composition root.
//
// Thin wrapper around buildCfContainer from integrations-adapters-cf so the
// gateway worker has one well-known entrypoint. If you need to override an
// adapter for testing, swap individual ports here before returning.
//
// To add a new provider: implement IntegrationProvider in its own package,
// import here in providers.ts, and instantiate alongside LinearProvider.
//
// DB routing: integrations always run against env.AUTH_DB. Tenant sharding
// (when enabled in apps/main) doesn't apply here — webhook entry can't
// resolve tenant before signature verify, and integration data
// (linear_apps/installations/etc) lives in the shared control-plane DB.

import { buildCfContainer, type CfContainerEnv } from "@open-managed-agents/integrations-adapters-cf";
import type { Container } from "@open-managed-agents/integrations-core";
import type { Env } from "./env";

export function buildContainer(env: Env): Container {
  const cfEnv: CfContainerEnv = {
    db: env.AUTH_DB,
    controlPlaneDb: env.AUTH_DB,
    MCP_SIGNING_KEY: env.MCP_SIGNING_KEY,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
  return buildCfContainer(cfEnv);
}
