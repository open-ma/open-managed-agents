// Composition root.
//
// Builds concrete adapter instances from the worker's bindings and assembles
// per-provider containers. Each provider gets its own Container with its own
// repos (parallel `linear_*` vs `slack_*` tables), but they share the same
// underlying infrastructure adapters (clock, ids, crypto, jwt, http, sessions,
// vaults). Sharing infra is harmless; it keeps secrets isolated by use-label
// inside Crypto/JWT but uses one D1 binding for both.

import {
  CryptoIdGenerator,
  D1AppRepo,
  D1InstallationRepo,
  D1LinearSessionScopeRepo,
  D1PublicationRepo,
  D1SetupLinkRepo,
  D1SlackAppRepo,
  D1SlackInstallationRepo,
  D1SlackPublicationRepo,
  D1SlackSessionScopeRepo,
  D1SlackSetupLinkRepo,
  D1SlackWebhookEventStore,
  D1WebhookEventStore,
  ServiceBindingSessionCreator,
  ServiceBindingVaultManager,
  SystemClock,
  WebCryptoAesGcm,
  WebCryptoHmacVerifier,
  WebCryptoJwtSigner,
  WorkerHttpClient,
} from "@open-managed-agents/integrations-adapters-cf";
import type {
  Clock,
  Container,
  Crypto,
  HmacVerifier,
  HttpClient,
  IdGenerator,
  JwtSigner,
  SessionCreator,
  VaultManager,
} from "@open-managed-agents/integrations-core";
import type { SlackContainer } from "@open-managed-agents/slack";
import type { Env } from "./env";

interface SharedInfra {
  clock: Clock;
  ids: IdGenerator;
  crypto: Crypto;
  hmac: HmacVerifier;
  jwt: JwtSigner;
  http: HttpClient;
  sessions: SessionCreator;
  vaults: VaultManager;
}

function buildSharedInfra(env: Env): SharedInfra {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  // Token-at-rest encryption uses a distinct label so the derived key is
  // different from the JWT signing key, even though both seed from the same
  // root secret.
  const crypto = new WebCryptoAesGcm(env.MCP_SIGNING_KEY, "integrations.tokens");
  const hmac = new WebCryptoHmacVerifier();
  const jwt = new WebCryptoJwtSigner(env.MCP_SIGNING_KEY);
  const http = new WorkerHttpClient();
  const sessions = new ServiceBindingSessionCreator(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  const vaults = new ServiceBindingVaultManager(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  return { clock, ids, crypto, hmac, jwt, http, sessions, vaults };
}

/** Linear container — `linear_*` tables. */
export function buildLinearContainer(env: Env): Container {
  const infra = buildSharedInfra(env);
  return {
    ...infra,
    installations: new D1InstallationRepo(env.AUTH_DB, infra.crypto, infra.ids),
    publications: new D1PublicationRepo(env.AUTH_DB, infra.ids),
    apps: new D1AppRepo(env.AUTH_DB, infra.crypto, infra.ids),
    webhookEvents: new D1WebhookEventStore(env.AUTH_DB),
    sessionScopes: new D1LinearSessionScopeRepo(env.AUTH_DB),
    setupLinks: new D1SetupLinkRepo(env.AUTH_DB, infra.ids),
  };
}

/** Slack container — `slack_*` tables, with the Slack-specific
 * SlackInstallationRepo (adds getUserToken/setUserToken/setBotVaultId/getBotVaultId). */
export function buildSlackContainer(env: Env): SlackContainer {
  const infra = buildSharedInfra(env);
  return {
    ...infra,
    installations: new D1SlackInstallationRepo(env.AUTH_DB, infra.crypto, infra.ids),
    publications: new D1SlackPublicationRepo(env.AUTH_DB, infra.ids),
    apps: new D1SlackAppRepo(env.AUTH_DB, infra.crypto, infra.ids),
    webhookEvents: new D1SlackWebhookEventStore(env.AUTH_DB),
    sessionScopes: new D1SlackSessionScopeRepo(env.AUTH_DB),
    setupLinks: new D1SlackSetupLinkRepo(env.AUTH_DB, infra.ids),
  };
}

/**
 * Backward-compat shim — older Linear route handlers call buildContainer(env)
 * expecting the Linear-shaped Container. Keep it as a thin alias so existing
 * code keeps compiling without churn.
 */
export function buildContainer(env: Env): Container {
  return buildLinearContainer(env);
}
