// Composition root for the Node runtime.
//
// Mirrors integrations-adapters-cf/cf-container.ts but uses SqlClient
// (sqlite/PG via the existing dispatch) instead of D1Database, and resolves
// tenant via the membership table the auth bootstrap maintains.
//
// Two factories:
//   - buildNodeRepos(env)    : repos + crypto/hmac/jwt/http/clock/ids only.
//                              No SessionCreator/VaultManager. Used by the
//                              read-only integrations endpoints in main-node.
//   - buildNodeContainer(env): full Container including SessionCreator and
//                              VaultManager — wired against in-process
//                              session/vault services rather than a
//                              service-binding stub.
//
// SessionCreator/VaultManager on Node are constructor-injected because
// the in-process services live on apps/main-node. We accept them as
// dependencies rather than building HTTP shims to mirror the CF
// service-binding indirection.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Container,
  SessionCreator,
  VaultManager,
} from "@open-managed-agents/integrations-core";
import { SystemClock } from "./clock";
import { WebCryptoAesGcm } from "./crypto";
import { WebCryptoHmacVerifier } from "./hmac";
import { WorkerHttpClient } from "./http";
import { CryptoIdGenerator } from "./ids";
import { WebCryptoJwtSigner } from "./jwt";
import { SqlAppRepo } from "./sql/app-repo";
import { SqlDispatchRuleRepo } from "./sql/dispatch-rule-repo";
import { SqlGitHubAppRepo } from "./sql/github-app-repo";
import { SqlGitHubInstallationRepo } from "./sql/github/installation-repo";
import { SqlGitHubPublicationRepo } from "./sql/github/publication-repo";
import { SqlGitHubWebhookEventStore } from "./sql/github/webhook-event-store";
import { SqlInstallationRepo } from "./sql/installation-repo";
import { SqlIssueSessionRepo } from "./sql/issue-session-repo";
import { SqlLinearEventStore } from "./sql/linear-event-store";
import { SqlPublicationRepo } from "./sql/publication-repo";
import { SqlSetupLinkRepo } from "./sql/setup-link-repo";
import { SqlSlackSessionScopeRepo } from "./sql/slack/session-scope-repo";
import { SqlMembershipTenantResolver } from "./sql/membership-tenant-resolver";

export interface NodeReposEnv {
  /** Single SqlClient that holds the integration tables (linear_, github_,
   *  and slack_ prefixes) along with the membership table the tenant
   *  resolver reads. Self-host runs one database; we don't split
   *  integrations data into a separate connection. */
  sql: SqlClient;
  PLATFORM_ROOT_SECRET: string;
}

export interface NodeContainerEnv extends NodeReposEnv {
  sessions: SessionCreator;
  vaults: VaultManager;
}

export function buildNodeRepos(env: NodeReposEnv) {
  const sql = env.sql;
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const cryptoImpl = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "integrations.tokens");
  const hmac = new WebCryptoHmacVerifier();
  const jwt = new WebCryptoJwtSigner(env.PLATFORM_ROOT_SECRET);
  const http = new WorkerHttpClient();
  const tenants = new SqlMembershipTenantResolver(sql);
  const linearInstallations = new SqlInstallationRepo(sql, cryptoImpl, ids);
  const linearPublications = new SqlPublicationRepo(sql, ids);
  const githubInstallations = new SqlGitHubInstallationRepo(sql, cryptoImpl, ids);
  const githubPublications = new SqlGitHubPublicationRepo(sql, ids);
  const apps = new SqlAppRepo(sql, cryptoImpl, ids);
  const githubApps = new SqlGitHubAppRepo(sql, cryptoImpl, ids);
  const linearEvents = new SqlLinearEventStore(sql);
  const githubWebhookEvents = new SqlGitHubWebhookEventStore(sql);
  const issueSessions = new SqlIssueSessionRepo(sql);
  const setupLinks = new SqlSetupLinkRepo(sql, ids);
  const dispatchRules = new SqlDispatchRuleRepo(sql, ids);
  const sessionScopes = new SqlSlackSessionScopeRepo(sql);

  return {
    clock,
    ids,
    crypto: cryptoImpl,
    hmac,
    jwt,
    http,
    tenants,
    linearInstallations,
    linearPublications,
    githubInstallations,
    githubPublications,
    apps,
    githubApps,
    linearEvents,
    githubWebhookEvents,
    issueSessions,
    sessionScopes,
    setupLinks,
    dispatchRules,
  };
}

export function buildNodeContainer(
  env: NodeContainerEnv,
): Container & ReturnType<typeof buildNodeRepos> {
  const repos = buildNodeRepos(env);
  return {
    ...repos,
    installations: repos.linearInstallations,
    publications: repos.linearPublications,
    webhookEvents: repos.linearEvents,
    sessions: env.sessions,
    vaults: env.vaults,
  };
}
