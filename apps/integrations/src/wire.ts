// Composition root.
//
// Each provider gets its own Container so installations/publications point at
// the right per-provider table. Linear → linear_*, GitHub → github_*, Slack
// → slack_*. The shared adapters (clock/ids/crypto/hmac/jwt/http/sessions/
// vaults/tenants/githubApps/issueSessions/etc.) come from buildCfContainer
// regardless of provider — only the provider-scoped repos differ.
//
// To add a provider that fits the linear schema verbatim: just instantiate it
// with buildContainer(env). For one with parallel tables (slack/github-style),
// follow buildGitHubContainer / buildSlackContainer below.
//
// DB routing: integrations always run against env.AUTH_DB. Tenant sharding
// (when enabled in apps/main) doesn't apply here — webhook entry can't
// resolve tenant before signature verify, and integration data lives in the
// shared control-plane DB.

import {
  buildCfContainer,
  D1SlackAppRepo,
  D1SlackInstallationRepo,
  D1SlackPublicationRepo,
  D1SlackSessionScopeRepo,
  D1SlackSetupLinkRepo,
  D1SlackWebhookEventStore,
  type CfContainerEnv,
} from "@open-managed-agents/integrations-adapters-cf";
import type { Container } from "@open-managed-agents/integrations-core";
import type { SlackContainer } from "@open-managed-agents/slack";
import type { Env } from "./env";

function cfEnvOf(env: Env): CfContainerEnv {
  return {
    db: env.AUTH_DB,
    controlPlaneDb: env.AUTH_DB,
    MCP_SIGNING_KEY: env.MCP_SIGNING_KEY,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
}

/**
 * Linear container — `installations`/`publications` already point at the
 * linear_* repos via buildCfContainer's default wiring. sessionScopes is
 * Linear-irrelevant but required by the Container shape; we hand it the
 * Slack impl since the slot is unused on the Linear path (Linear uses
 * issueSessions instead).
 */
export function buildContainer(env: Env): Container {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    sessionScopes: new D1SlackSessionScopeRepo(env.AUTH_DB),
  };
}

/**
 * GitHub container — swaps in the github_* installations/publications repos
 * (githubInstallations/githubPublications from buildCfRepos). All other
 * shared adapters (githubApps, webhookEvents, sessions, vaults, etc.) carry
 * over unchanged. sessionScopes follows the same unused-but-required pattern
 * as buildContainer.
 */
export function buildGitHubContainer(env: Env): Container {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    installations: base.githubInstallations,
    publications: base.githubPublications,
    sessionScopes: new D1SlackSessionScopeRepo(env.AUTH_DB),
  };
}

/**
 * Slack container — parallel `slack_*` tables, with the Slack-specific
 * SlackInstallationRepo (adds getUserToken/setUserToken/setBotVaultId/getBotVaultId).
 *
 * Reuses every shared adapter (clock/ids/crypto/hmac/jwt/http/sessions/vaults/
 * tenants/githubApps/issueSessions) from buildCfContainer
 * and only swaps the installations/publications/apps/setupLinks/webhookEvents/
 * sessionScopes ports for slack-specific D1 repos.
 */
export function buildSlackContainer(env: Env): SlackContainer {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    installations: new D1SlackInstallationRepo(env.AUTH_DB, base.crypto, base.ids),
    publications: new D1SlackPublicationRepo(env.AUTH_DB, base.ids),
    apps: new D1SlackAppRepo(env.AUTH_DB, base.crypto, base.ids),
    webhookEvents: new D1SlackWebhookEventStore(env.AUTH_DB),
    sessionScopes: new D1SlackSessionScopeRepo(env.AUTH_DB),
    setupLinks: new D1SlackSetupLinkRepo(env.AUTH_DB, base.ids),
  };
}
