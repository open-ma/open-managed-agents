// Composition root.
//
// Thin wrapper around buildCfContainer from integrations-adapters-cf so the
// gateway worker has one well-known entrypoint. If you need to override an
// adapter for testing, swap individual ports here before returning.
//
// To add a new provider: implement IntegrationProvider in its own package,
// import here in providers.ts, and instantiate alongside LinearProvider.

import { buildCfContainer, type CfContainerEnv } from "@open-managed-agents/integrations-adapters-cf";
import type { Container } from "@open-managed-agents/integrations-core";

export function buildContainer(env: CfContainerEnv): Container {
  return buildCfContainer(env);
}
