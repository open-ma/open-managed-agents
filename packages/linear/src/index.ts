// @open-managed-agents/linear
//
// Linear-specific implementation of integrations-core's IntegrationProvider.
// Pure logic only — no Cloudflare imports, no Hono, no D1. All runtime
// concerns (HTTP, storage, crypto, JWT) are injected via integrations-core
// ports.

export { LinearProvider } from "./provider";
export type { LinearContainer } from "./provider";
export {
  type LinearConfig,
  ALL_CAPABILITIES,
  DEFAULT_LINEAR_SCOPES,
} from "./config";
export {
  LinearGraphQLClient,
  LinearGraphQLError,
  type ViewerInfo,
  type OrganizationInfo,
} from "./graphql/client";
