// Composition root.
//
// Linear + GitHub run against the shared `linear_*` / `github_*` D1 tables and
// share one Container built via buildCfContainer. Slack runs against parallel
// `slack_*` tables (dual-token model doesn't fit the shared installations
// schema) and gets its own SlackContainer.
//
// To add a provider that fits the shared tables: just instantiate it with
// the result of buildContainer(env). For one with parallel tables (slack-
// style), follow buildSlackContainer's pattern below.
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

/**
 * Shared container — Linear + GitHub use these `linear_*` / `github_*` tables.
 * `provider_id` distinguishes rows in the shared tables.
 *
 * sessionScopes uses D1SlackSessionScopeRepo as the shared impl too — it
 * happens to point at slack_thread_sessions, but Linear/GitHub never call
 * into it (they use issueSessions instead). Concrete impl is required by
 * the Container interface contract.
 */
export function buildContainer(env: Env): Container {
  const cfEnv: CfContainerEnv = {
    db: env.AUTH_DB,
    controlPlaneDb: env.AUTH_DB,
    MCP_SIGNING_KEY: env.MCP_SIGNING_KEY,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
  const base = buildCfContainer(cfEnv);
  return {
    ...base,
    sessionScopes: new D1SlackSessionScopeRepo(env.AUTH_DB),
  };
}

/**
 * Slack container — parallel `slack_*` tables, with the Slack-specific
 * SlackInstallationRepo (adds getUserToken/setUserToken/setBotVaultId/getBotVaultId).
 *
 * Reuses every shared adapter (clock/ids/crypto/hmac/jwt/http/sessions/vaults/
 * tenants/githubApps/issueSessions/authoredComments) from buildCfContainer
 * and only swaps the installations/publications/apps/setupLinks/webhookEvents/
 * sessionScopes ports for slack-specific D1 repos.
 */
export function buildSlackContainer(env: Env): SlackContainer {
  const cfEnv: CfContainerEnv = {
    db: env.AUTH_DB,
    controlPlaneDb: env.AUTH_DB,
    MCP_SIGNING_KEY: env.MCP_SIGNING_KEY,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
  const base = buildCfContainer(cfEnv);
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
