// Public surface — every mount factory and the shared types.
//
// CF + Node both `import { buildXxxRoutes, type RouteServices } from
// "@open-managed-agents/http-routes"`, build their services bundle, and
// mount the routes under the same paths.

export type {
  RouteServices,
  RouteServicesArg,
  EventStreamHub,
  BackgroundRunner,
  SessionRegistryLike,
} from "./types";
export { resolveServices } from "./types";

export { buildAgentRoutes } from "./agents";
export type { AgentRoutesDeps } from "./agents";

export { buildVaultRoutes } from "./vaults";
export type { VaultRoutesDeps } from "./vaults";

export { buildSessionRoutes } from "./sessions";
export type {
  SessionRoutesDeps,
  SessionLifecycleHooks,
  OutputsAdapter,
} from "./sessions";

export { buildMemoryRoutes } from "./memory";
export type { MemoryRoutesDeps } from "./memory";

export { buildTenantRoutes, buildMeRoutes } from "./tenants";
export type { TenantRoutesDeps, MeRoutesDeps } from "./tenants";

export {
  buildApiKeyRoutes,
  mintApiKeyOnStorage,
  sha256Hex,
} from "./api-keys";
export type {
  ApiKeyRoutesDeps,
  ApiKeyStorage,
  ApiKeyRecord,
  ApiKeyMeta,
} from "./api-keys";

export { buildEvalRoutes } from "./evals";
export type { EvalRoutesDeps, EvalTaskSpec } from "./evals";

export { buildIntegrationsRoutes } from "./integrations";
export type {
  IntegrationsRoutesDeps,
  IntegrationsBags,
  IntegrationsRepoBag,
  InstallProxyForwarder,
} from "./integrations";

export { buildIntegrationsGatewayRoutes } from "./integrations/gateway";
export type {
  IntegrationsGatewayDeps,
  WebhookHandler,
  WebhookHandlers,
  RateLimitHooks,
} from "./integrations/gateway";
