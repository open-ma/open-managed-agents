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
import { D1AuthoredCommentRepo } from "./d1/authored-comment-repo";
import { D1GitHubAppRepo } from "./d1/github-app-repo";
import { D1InstallationRepo } from "./d1/installation-repo";
import { D1IssueSessionRepo } from "./d1/issue-session-repo";
import { D1PublicationRepo } from "./d1/publication-repo";
import { D1SetupLinkRepo } from "./d1/setup-link-repo";
import { D1WebhookEventStore } from "./d1/webhook-event-store";
import { ServiceBindingSessionCreator } from "./service-binding-session-creator";
import { ServiceBindingVaultManager } from "./service-binding-vault-manager";

/** Env subset needed by buildCfRepos. */
export interface CfReposEnv {
  AUTH_DB: D1Database;
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
  const installations = new D1InstallationRepo(env.AUTH_DB, cryptoImpl, ids);
  const publications = new D1PublicationRepo(env.AUTH_DB, ids);
  const apps = new D1AppRepo(env.AUTH_DB, cryptoImpl, ids);
  const githubApps = new D1GitHubAppRepo(env.AUTH_DB, cryptoImpl, ids);
  const webhookEvents = new D1WebhookEventStore(env.AUTH_DB);
  const issueSessions = new D1IssueSessionRepo(env.AUTH_DB);
  const authoredComments = new D1AuthoredCommentRepo(env.AUTH_DB);
  const setupLinks = new D1SetupLinkRepo(env.AUTH_DB, ids);

  return {
    clock,
    ids,
    crypto: cryptoImpl,
    hmac,
    jwt,
    http,
    installations,
    publications,
    apps,
    githubApps,
    webhookEvents,
    issueSessions,
    authoredComments,
    setupLinks,
  };
}

/**
 * Returns the full integrations Container, ready for an IntegrationProvider.
 * Requires the MAIN service binding so SessionCreator/VaultManager can call
 * apps/main's /v1/internal/* endpoints.
 */
export function buildCfContainer(env: CfContainerEnv): Container {
  const repos = buildCfRepos(env);
  const sessions = new ServiceBindingSessionCreator(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  const vaults = new ServiceBindingVaultManager(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  return { ...repos, sessions, vaults };
}
