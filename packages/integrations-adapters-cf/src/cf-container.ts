// Composition root helpers for the Cloudflare runtime.
//
// Two factories so consumers don't pay for ports they don't use:
//
//   - buildCfRepos(env)    : repos + crypto/hmac/jwt/http/clock/ids only.
//                            No service bindings required. Used by
//                            apps/main's read-only integrations endpoints,
//                            which never construct sessions or vaults.
//
//   - buildCfContainer(env): full Container including SessionCreator and
//                            VaultManager. Requires the MAIN service binding
//                            (back to apps/main) and INTEGRATIONS_INTERNAL_SECRET.
//                            Used by apps/integrations.
//
// Both go through the same per-port construction. If you change a repo's
// constructor signature, edit only this file.

import type { Container } from "@open-managed-agents/integrations-core";
import { SystemClock } from "./clock";
import { WebCryptoAesGcm } from "./crypto";
import { WebCryptoHmacVerifier } from "./hmac";
import { WorkerHttpClient } from "./http";
import { CryptoIdGenerator } from "./ids";
import { WebCryptoJwtSigner } from "./jwt";
import { D1AppRepo } from "./d1/app-repo";
import { D1DispatchRuleRepo } from "./d1/dispatch-rule-repo";
import { D1GitHubAppRepo } from "./d1/github-app-repo";
import { D1GitHubInstallationRepo } from "./d1/github/installation-repo";
import { D1GitHubPublicationRepo } from "./d1/github/publication-repo";
import { D1InstallationRepo } from "./d1/installation-repo";
import { D1IssueSessionRepo } from "./d1/issue-session-repo";
import { D1PendingEventRepo } from "./d1/pending-event-repo";
import { D1PublicationRepo } from "./d1/publication-repo";
import { D1SetupLinkRepo } from "./d1/setup-link-repo";
import { D1SlackSessionScopeRepo } from "./d1/slack/session-scope-repo";
import { D1TenantResolver } from "./d1/tenant-resolver";
import { D1WebhookEventStore } from "./d1/webhook-event-store";
import { ServiceBindingSessionCreator } from "./service-binding-session-creator";
import { ServiceBindingVaultManager } from "./service-binding-vault-manager";

/** Env subset needed by buildCfRepos. */
export interface CfReposEnv {
  /** Per-tenant D1 database, resolved by the caller via TenantDbProvider.
   *  In Phase 1 this is always env.AUTH_DB. */
  db: D1Database;
  /** Control-plane DB for cross-tenant lookups (TenantResolver). Always
   *  env.AUTH_DB regardless of per-tenant routing. */
  controlPlaneDb: D1Database;
  MCP_SIGNING_KEY: string;
}

/** Env subset needed by buildCfContainer (extends CfReposEnv). */
export interface CfContainerEnv extends CfReposEnv {
  /** Service binding back to apps/main, used by SessionCreator + VaultManager. */
  MAIN: Fetcher;
  /** Shared secret gating apps/main's /v1/internal/* endpoints. */
  INTEGRATIONS_INTERNAL_SECRET: string;
}

/**
 * Returns the persistence + crypto half of the Container — everything that
 * does not depend on a service binding to apps/main.
 *
 * Token-at-rest encryption uses the "integrations.tokens" label so the derived
 * key is distinct from the JWT signing key, even though both seed from the
 * same MCP_SIGNING_KEY root secret.
 */
export function buildCfRepos(env: CfReposEnv) {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const cryptoImpl = new WebCryptoAesGcm(env.MCP_SIGNING_KEY, "integrations.tokens");
  const hmac = new WebCryptoHmacVerifier();
  const jwt = new WebCryptoJwtSigner(env.MCP_SIGNING_KEY);
  const http = new WorkerHttpClient();
  // TenantResolver always queries control-plane (better-auth `user` table) —
  // it must work without per-tenant routing being decided yet (e.g. install
  // callbacks know userId before they know tenantId).
  const tenants = new D1TenantResolver(env.controlPlaneDb);
  // Linear and GitHub each get their own installations/publications repos
  // (linear_* vs github_* tables). Slack lives in slack_* and is wired
  // separately via the slack-specific helpers.
  const linearInstallations = new D1InstallationRepo(env.db, cryptoImpl, ids);
  const linearPublications = new D1PublicationRepo(env.db, ids);
  const githubInstallations = new D1GitHubInstallationRepo(env.db, cryptoImpl, ids);
  const githubPublications = new D1GitHubPublicationRepo(env.db, ids);
  const apps = new D1AppRepo(env.db, cryptoImpl, ids);
  const githubApps = new D1GitHubAppRepo(env.db, cryptoImpl, ids);
  const webhookEvents = new D1WebhookEventStore(env.db);
  const issueSessions = new D1IssueSessionRepo(env.db);
  const setupLinks = new D1SetupLinkRepo(env.db, ids);
  const dispatchRules = new D1DispatchRuleRepo(env.db, ids);
  const pendingEvents = new D1PendingEventRepo(env.db, ids);
  // Slack-specific repo also satisfies the Container's `sessionScopes` slot —
  // Linear/GitHub never call into it (they use issueSessions instead). Still
  // required by the Container interface.
  const sessionScopes = new D1SlackSessionScopeRepo(env.db);

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
    webhookEvents,
    issueSessions,
    sessionScopes,
    setupLinks,
    dispatchRules,
    pendingEvents,
  };
}

/**
 * Returns the full integrations Container, ready for an IntegrationProvider.
 * Requires the MAIN service binding so SessionCreator/VaultManager can call
 * apps/main's /v1/internal/* endpoints.
 *
 * The default Container's `installations`/`publications` slots are bound to
 * the Linear repos. GitHub callers should swap them for the github-flavored
 * repos before constructing GitHubProvider — wire.ts in apps/integrations
 * does this via buildGitHubContainer. The full per-provider bag (linear/
 * github named repos) is also exposed on the return value so consumers can
 * pick the right pair without re-running the factory.
 */
export function buildCfContainer(
  env: CfContainerEnv,
): Container & ReturnType<typeof buildCfRepos> {
  const repos = buildCfRepos(env);
  const sessions = new ServiceBindingSessionCreator(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  const vaults = new ServiceBindingVaultManager(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  return {
    ...repos,
    installations: repos.linearInstallations,
    publications: repos.linearPublications,
    sessions,
    vaults,
  };
}
