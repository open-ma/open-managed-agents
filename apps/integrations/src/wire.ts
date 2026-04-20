// Composition root.
//
// Builds concrete adapter instances from the worker's bindings and assembles
// providers. This is the only file in the integrations gateway that reaches
// across the layering boundary — every other file consumes the abstract
// ports.
//
// To add a new provider: implement IntegrationProvider in its own package,
// import here, and instantiate alongside LinearProvider.

import {
  CryptoIdGenerator,
  D1AppRepo,
  D1InstallationRepo,
  D1IssueSessionRepo,
  D1PublicationRepo,
  D1SetupLinkRepo,
  D1WebhookEventStore,
  ServiceBindingSessionCreator,
  ServiceBindingVaultManager,
  SystemClock,
  WebCryptoAesGcm,
  WebCryptoHmacVerifier,
  WebCryptoJwtSigner,
  WorkerHttpClient,
} from "@open-managed-agents/integrations-adapters-cf";
import type { Container } from "@open-managed-agents/integrations-core";
import type { Env } from "./env";

export function buildContainer(env: Env): Container {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  // Token-at-rest encryption uses a distinct label so the derived key is
  // different from the JWT signing key, even though both seed from the same
  // root secret.
  const cryptoImpl = new WebCryptoAesGcm(env.MCP_SIGNING_KEY, "integrations.tokens");
  const hmac = new WebCryptoHmacVerifier();
  const jwt = new WebCryptoJwtSigner(env.MCP_SIGNING_KEY);
  const http = new WorkerHttpClient();
  const sessions = new ServiceBindingSessionCreator(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  const vaults = new ServiceBindingVaultManager(env.MAIN, {
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET,
  });
  const installations = new D1InstallationRepo(env.AUTH_DB, cryptoImpl, ids);
  const publications = new D1PublicationRepo(env.AUTH_DB, ids);
  const apps = new D1AppRepo(env.AUTH_DB, cryptoImpl, ids);
  const webhookEvents = new D1WebhookEventStore(env.AUTH_DB);
  const issueSessions = new D1IssueSessionRepo(env.AUTH_DB);
  const setupLinks = new D1SetupLinkRepo(env.AUTH_DB, ids);

  return {
    clock,
    ids,
    crypto: cryptoImpl,
    hmac,
    jwt,
    http,
    sessions,
    vaults,
    installations,
    publications,
    apps,
    webhookEvents,
    issueSessions,
    setupLinks,
  };
}
