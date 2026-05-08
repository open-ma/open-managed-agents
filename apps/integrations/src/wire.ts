// Composition root.
//
// Each provider gets its own Container so installations/publications/
// webhookEvents point at the right per-provider table. Linear → linear_*,
// GitHub → github_*, Slack → slack_*. The shared adapters
// (clock/ids/crypto/hmac/jwt/http/sessions/vaults/tenants/githubApps/
// issueSessions/etc.) come from buildCfContainer regardless of provider —
// only the provider-scoped repos differ.
//
// To add a provider that fits the linear schema verbatim: just instantiate it
// with buildContainer(env). For one with parallel tables (slack/github-style),
// follow buildGitHubContainer / buildSlackContainer below.
//
// DB routing:
//   - integrationsDb : env.INTEGRATIONS_DB. Holds linear_*/github_*/slack_*.
//   - controlPlaneDb : env.AUTH_DB. TenantResolver looks up user.tenantId here.
// Tenant sharding (per-tenant DB) doesn't apply to integration tables — the
// webhook entry can't resolve tenant before signature verify.

import {
  buildCfContainer,
  D1GitHubWebhookEventStore,
  D1SlackAppRepo,
  D1SlackInstallationRepo,
  D1SlackPublicationRepo,
  D1SlackSessionScopeRepo,
  D1SlackSetupLinkRepo,
  D1SlackWebhookEventStore,
  type CfContainerEnv,
} from "@open-managed-agents/integrations-adapters-cf";
import type { Container } from "@open-managed-agents/integrations-core";
import type { LinearContainer } from "@open-managed-agents/linear";
import type { SlackContainer } from "@open-managed-agents/slack";
import type { Env } from "./env";

function cfEnvOf(env: Env): CfContainerEnv {
  return {
    integrationsDb: env.INTEGRATIONS_DB,
    controlPlaneDb: env.AUTH_DB,
    MCP_SIGNING_KEY: env.MCP_SIGNING_KEY,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
}

/**
 * Linear container — `installations`/`publications`/`webhookEvents`
 * already point at the linear_* repos via buildCfContainer's default
 * wiring (webhookEvents = D1LinearEventStore against the merged
 * linear_events table). sessionScopes is Linear-irrelevant but required
 * by the Container shape; we hand it the Slack impl since the slot is
 * unused on the Linear path (Linear uses issueSessions instead).
 */
export function buildContainer(env: Env): LinearContainer {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    // Narrow the webhookEvents slot from WebhookEventStore (Container shape)
    // to LinearEventStore (LinearContainer shape). The runtime instance is
    // already the narrower type — base.linearEvents — but the spread above
    // erases it back to the wider Container shape, so re-assign explicitly.
    webhookEvents: base.linearEvents,
    sessionScopes: new D1SlackSessionScopeRepo(env.INTEGRATIONS_DB),
  };
}

/**
 * GitHub container — swaps in the github_* installations/publications repos
 * AND the github_webhook_events store (no longer borrows linear_*).
 * All other shared adapters (githubApps, sessions, vaults, etc.) carry over
 * unchanged. sessionScopes follows the same unused-but-required pattern
 * as buildContainer.
 */
export function buildGitHubContainer(env: Env): Container {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    installations: base.githubInstallations,
    publications: base.githubPublications,
    webhookEvents: new D1GitHubWebhookEventStore(env.INTEGRATIONS_DB),
    sessionScopes: new D1SlackSessionScopeRepo(env.INTEGRATIONS_DB),
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
    installations: new D1SlackInstallationRepo(env.INTEGRATIONS_DB, base.crypto, base.ids),
    publications: new D1SlackPublicationRepo(env.INTEGRATIONS_DB, base.ids),
    apps: new D1SlackAppRepo(env.INTEGRATIONS_DB, base.crypto, base.ids),
    webhookEvents: new D1SlackWebhookEventStore(env.INTEGRATIONS_DB),
    sessionScopes: new D1SlackSessionScopeRepo(env.INTEGRATIONS_DB),
    setupLinks: new D1SlackSetupLinkRepo(env.INTEGRATIONS_DB, base.ids),
  };
}
