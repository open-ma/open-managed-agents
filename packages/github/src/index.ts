// @open-managed-agents/github
//
// GitHub-specific implementation of integrations-core's IntegrationProvider.
// Pure logic only — no Cloudflare imports, no Hono, no D1. All runtime
// concerns (HTTP, storage, crypto, JWT) are injected via integrations-core
// ports.

export { GitHubProvider } from "./provider";
export type { GitHubContainer } from "./provider";
export {
  type GitHubConfig,
  ALL_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "./config";
export {
  GitHubApiClient,
  GitHubApiError,
  type AppInfo,
  type InstallationDetail,
  type InstallationAccount,
} from "./api/client";
export {
  buildInstallUrl,
  buildInstallationTokenRequest,
  mintAppJwt,
  parseInstallationTokenResponse,
  type AppJwtClaims,
  type InstallationTokenExchangeRequest,
  type InstallationTokenResponse,
} from "./oauth/protocol";
export {
  buildManifest,
  buildManifestConversionRequest,
  parseManifestConversionResponse,
  type ManifestInput,
  type ManifestConversionResult,
} from "./oauth/manifest";
export {
  parseWebhook,
  type RawWebhookEnvelope,
  type NormalizedWebhookEvent,
  type EventKind,
  type WebhookHeaders,
  type ParseInput,
} from "./webhook/parse";
