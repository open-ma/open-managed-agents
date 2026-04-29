// @open-managed-agents/slack
//
// Slack-specific implementation of integrations-core's IntegrationProvider.
// Pure logic only — no Cloudflare imports, no Hono, no D1. All runtime
// concerns (HTTP, storage, crypto, JWT) are injected via integrations-core
// ports plus the Slack-specific SlackInstallationRepo extension.

export { SlackProvider } from "./provider";
export type { SlackContainer } from "./provider";
export {
  type SlackConfig,
  type SlackCapabilityKey,
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
  DEFAULT_SLACK_SUBSCRIBED_EVENTS,
} from "./config";
export {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
  type SlackTokenResponse,
  type SlackTeamInfo,
  type SlackEnterpriseInfo,
  type SlackAuthedUser,
} from "./oauth/protocol";
export {
  buildManifest,
  buildManifestLaunchUrl,
  type SlackManifestInput,
} from "./oauth/manifest";
export {
  buildBaseString,
  parseSignatureHeader,
  isTimestampFresh,
  MAX_TIMESTAMP_SKEW_SECONDS,
  type ParsedSignature,
} from "./webhook/signature";
export {
  parseWebhook,
  type NormalizedSlackEvent,
  type SlackEventKind,
  type RawSlackEnvelope,
  type RawUrlVerification,
  type RawEventCallback,
  type RawAppRateLimited,
  type RawEventInner,
} from "./webhook/parse";
export { SlackApiClient, SlackApiError, type AuthTestResult } from "./api/client";
export type { SlackInstallationRepo, SlackSessionScopeRepo } from "./ports";
