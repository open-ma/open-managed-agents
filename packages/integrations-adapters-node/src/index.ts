// @open-managed-agents/integrations-adapters-node
//
// Node sibling of integrations-adapters-cf. Same port shapes; storage moves
// from D1Database to SqlClient, so the adapters work against better-sqlite3
// (single-instance) and pg-postgres (multi-replica) without further changes.
//
// Shared primitives (crypto/hmac/jwt/clock/ids/http) are duplicated rather
// than re-exported from -adapters-cf, because that package depends on
// @cloudflare/workers-types via its D1 imports — pulling it in here would
// drag CF types into Node consumers. The crypto/hmac/jwt code is just
// Web Crypto + global fetch, both available in Node 20+.

export { WebCryptoAesGcm } from "./crypto";
export { WebCryptoHmacVerifier } from "./hmac";
export { WebCryptoJwtSigner } from "./jwt";
export { WorkerHttpClient } from "./http";
export { SystemClock } from "./clock";
export { CryptoIdGenerator } from "./ids";

export { SqlInstallationRepo } from "./sql/installation-repo";
export { SqlPublicationRepo } from "./sql/publication-repo";
export { SqlAppRepo } from "./sql/app-repo";
export { SqlGitHubAppRepo } from "./sql/github-app-repo";
export { SqlGitHubInstallationRepo } from "./sql/github/installation-repo";
export { SqlGitHubPublicationRepo } from "./sql/github/publication-repo";
export { SqlGitHubWebhookEventStore } from "./sql/github/webhook-event-store";
export { SqlLinearEventStore } from "./sql/linear-event-store";
export { SqlIssueSessionRepo } from "./sql/issue-session-repo";
export { SqlSetupLinkRepo } from "./sql/setup-link-repo";
export { SqlDispatchRuleRepo } from "./sql/dispatch-rule-repo";
export { SqlMembershipTenantResolver } from "./sql/membership-tenant-resolver";

export { SqlSlackAppRepo } from "./sql/slack/app-repo";
export { SqlSlackInstallationRepo } from "./sql/slack/installation-repo";
export { SqlSlackPublicationRepo } from "./sql/slack/publication-repo";
export { SqlSlackWebhookEventStore } from "./sql/slack/webhook-event-store";
export { SqlSlackSessionScopeRepo } from "./sql/slack/session-scope-repo";
export { SqlSlackSetupLinkRepo } from "./sql/slack/setup-link-repo";

export { buildNodeRepos, buildNodeContainer } from "./node-container";
export type { NodeReposEnv, NodeContainerEnv } from "./node-container";
