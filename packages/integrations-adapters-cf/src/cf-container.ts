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
//
// DB routing:
//   - integrationsDb : the per-subsystem D1 holding linear_*/github_*/slack_*
//                      tables. Lives in env.INTEGRATIONS_DB. Replaces the
//                      previous shared AUTH_DB, isolating webhook write
//                      traffic from the auth/sessions/agents control-plane.
//   - controlPlaneDb : env.AUTH_DB. Used ONLY by the TenantResolver to look
//                      up user.tenantId. The better-auth tables never move.

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
import { D1GitHubWebhookEventStore } from "./d1/github/webhook-event-store";
import { D1InstallationRepo } from "./d1/installation-repo";
import { D1IssueSessionRepo } from "./d1/issue-session-repo";
import { D1LinearEventStore } from "./d1/linear-event-store";
import { D1PublicationRepo } from "./d1/publication-repo";
import { D1SetupLinkRepo } from "./d1/setup-link-repo";
import { D1SlackSessionScopeRepo } from "./d1/slack/session-scope-repo";
import { D1TenantResolver } from "./d1/tenant-resolver";
import { ServiceBindingSessionCreator } from "./service-binding-session-creator";
import { ServiceBindingVaultManager } from "./service-binding-vault-manager";

/** Env subset needed by buildCfRepos. */
export interface CfReposEnv {
  /** Integration subsystem D1 — holds linear_* / github_* / slack_* tables.
   *  Separate database from AUTH_DB to isolate write traffic and let
   *  schema evolve independently. All integration repos in this package
   *  read/write here. */
  integrationsDb: D1Database;
  /** Control-plane DB for cross-tenant lookups (TenantResolver).
   *  Always env.AUTH_DB — the better-auth user table never moves. */
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
  const idb = env.integrationsDb;
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
  // separately via the slack-specific helpers in apps/integrations/wire.ts.
  const linearInstallations = new D1InstallationRepo(idb, cryptoImpl, ids);
  const linearPublications = new D1PublicationRepo(idb, ids);
  const githubInstallations = new D1GitHubInstallationRepo(idb, cryptoImpl, ids);
  const githubPublications = new D1GitHubPublicationRepo(idb, ids);
  const apps = new D1AppRepo(idb, cryptoImpl, ids);
  const githubApps = new D1GitHubAppRepo(idb, cryptoImpl, ids);
  // Linear's webhook store is the merged `linear_events` table — narrower
  // type LinearEventStore extends WebhookEventStore with the queue methods.
  // GitHub gets its own (github_webhook_events), completing 0009's split.
  const linearEvents = new D1LinearEventStore(idb);
  const githubWebhookEvents = new D1GitHubWebhookEventStore(idb);
  const issueSessions = new D1IssueSessionRepo(idb);
  const setupLinks = new D1SetupLinkRepo(idb, ids);
  const dispatchRules = new D1DispatchRuleRepo(idb, ids);
  // Slack-specific repo also satisfies the Container's `sessionScopes` slot —
  // Linear/GitHub never call into it (they use issueSessions instead). Still
  // required by the Container interface.
  const sessionScopes = new D1SlackSessionScopeRepo(idb);

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

/**
 * Returns the full integrations Container, ready for an IntegrationProvider.
 * Requires the MAIN service binding so SessionCreator/VaultManager can call
 * apps/main's /v1/internal/* endpoints.
 *
 * The default Container's `installations`/`publications`/`webhookEvents`
 * slots are bound to the LINEAR repos. GitHub callers should swap them
 * for the github-flavored repos before constructing GitHubProvider —
 * wire.ts in apps/integrations does this via buildGitHubContainer.
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
    webhookEvents: repos.linearEvents,
    sessions,
    vaults,
  };
}
