// @open-managed-agents/integrations-adapters-cf
//
// Cloudflare-specific adapters that implement integrations-core ports against
// D1, KV, service bindings, Web Crypto, and the Workers fetch API.
//
// Consumed by apps/integrations' composition root. Provider packages never
// depend on this — they receive port instances as constructor arguments.

export { WebCryptoAesGcm } from "./crypto";
export { WebCryptoHmacVerifier } from "./hmac";
export { WebCryptoJwtSigner } from "./jwt";
export { WorkerHttpClient } from "./http";
export type { WorkerHttpClientOptions } from "./http";
export { SystemClock } from "./clock";
export { CryptoIdGenerator } from "./ids";
export { D1InstallationRepo } from "./d1/installation-repo";
export { D1PublicationRepo } from "./d1/publication-repo";
export { D1AppRepo } from "./d1/app-repo";
export { D1GitHubAppRepo } from "./d1/github-app-repo";
// GitHub adapters — parallel to Linear's, separate github_* tables.
export { D1GitHubInstallationRepo } from "./d1/github/installation-repo";
export { D1GitHubPublicationRepo } from "./d1/github/publication-repo";
export { D1GitHubWebhookEventStore } from "./d1/github/webhook-event-store";
export { D1LinearEventStore } from "./d1/linear-event-store";
export { D1IssueSessionRepo } from "./d1/issue-session-repo";
export { D1SetupLinkRepo } from "./d1/setup-link-repo";
export { D1DispatchRuleRepo } from "./d1/dispatch-rule-repo";
export { D1TenantResolver } from "./d1/tenant-resolver";
// Slack adapters — parallel to Linear's, separate slack_* tables.
export { D1SlackAppRepo } from "./d1/slack/app-repo";
export { D1SlackInstallationRepo } from "./d1/slack/installation-repo";
export { D1SlackPublicationRepo } from "./d1/slack/publication-repo";
export { D1SlackWebhookEventStore } from "./d1/slack/webhook-event-store";
export { D1SlackSessionScopeRepo } from "./d1/slack/session-scope-repo";
export { D1SlackSetupLinkRepo } from "./d1/slack/setup-link-repo";
export { ServiceBindingSessionCreator } from "./service-binding-session-creator";
export type { ServiceBindingSessionCreatorOptions } from "./service-binding-session-creator";
export { ServiceBindingVaultManager } from "./service-binding-vault-manager";
export type { ServiceBindingVaultManagerOptions } from "./service-binding-vault-manager";
export { buildCfRepos, buildCfContainer } from "./cf-container";
export type { CfReposEnv, CfContainerEnv } from "./cf-container";
