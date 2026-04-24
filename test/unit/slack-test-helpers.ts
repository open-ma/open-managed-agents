// Shared test fixtures for Slack provider tests. Eliminates duplicate
// FakeSlackInstallationRepo / buildFakeSlackContainer / makeProvider blocks
// across slack-provider-*.test.ts.
//
// Mirrors test/unit/github-test-helpers.ts — both keep helper surface narrow
// enough that a test reader doesn't have to chase indirection to follow the
// scenario.

import { SlackProvider, type SlackContainer } from "../../packages/slack/src/provider";
import type { SlackInstallationRepo } from "../../packages/slack/src/ports";
import {
  buildFakeContainer,
  InMemoryInstallationRepo,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
} from "../../packages/slack/src/config";

/**
 * Slack-flavored InMemoryInstallationRepo: extends the base with the two
 * Slack-only fields (user_token, bot_vault_id) that aren't part of the core
 * Installation row.
 */
export class FakeSlackInstallationRepo
  extends InMemoryInstallationRepo
  implements SlackInstallationRepo
{
  private userTokens = new Map<string, string>();
  private botVaults = new Map<string, string>();

  async getUserToken(id: string): Promise<string | null> {
    return this.userTokens.get(id) ?? null;
  }

  async setUserToken(id: string, userToken: string): Promise<void> {
    this.userTokens.set(id, userToken);
  }

  async setBotVaultId(id: string, botVaultId: string): Promise<void> {
    this.botVaults.set(id, botVaultId);
  }

  async getBotVaultId(id: string): Promise<string | null> {
    return this.botVaults.get(id) ?? null;
  }
}

export interface FakeSlackBundle extends Omit<FakeContainer, "installations"> {
  installations: FakeSlackInstallationRepo;
}

export function buildFakeSlackContainer(): FakeSlackBundle {
  const base = buildFakeContainer();
  return { ...base, installations: new FakeSlackInstallationRepo(base.clock) };
}

export function makeSlackProvider(
  c: FakeSlackBundle,
  overrides?: Partial<{ gatewayOrigin: string }>,
): SlackProvider {
  return new SlackProvider(c as SlackContainer, {
    gatewayOrigin: overrides?.gatewayOrigin ?? "https://gw",
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
  });
}

/**
 * Token-exchange response fixture. Returns the JSON string the SlackProvider
 * expects from `oauth.v2.access`.
 */
export function tokenResponseBody(opts?: {
  bot?: string;
  user?: string;
  teamId?: string;
  teamName?: string;
}): string {
  return JSON.stringify({
    ok: true,
    access_token: opts?.bot ?? "xoxb-bot-test",
    token_type: "bot",
    scope: "app_mentions:read,chat:write",
    bot_user_id: "U07BOT",
    app_id: "A07APP",
    team: { id: opts?.teamId ?? "T07TEAM", name: opts?.teamName ?? "Acme" },
    enterprise: null,
    authed_user: {
      id: "U07USER",
      scope: "search:read.public,channels:history",
      access_token: opts?.user ?? "xoxp-user-test",
      token_type: "user",
    },
  });
}

/**
 * Seeds a dedicated-mode Slack publication: app row, installation row with
 * vault ids, and a live publication. Returns the ids most tests need.
 *
 * `signingSecret` is stored as the app's webhook secret (Slack's signing
 * secret is per-app, not per-webhook).
 */
export async function seedDedicatedSlackPublication(
  c: FakeSlackBundle,
  opts: { signingSecret: string },
): Promise<{ instId: string; pubId: string; appId: string }> {
  const app = await c.apps.insert({
    publicationId: null,
    clientId: "cid",
    clientSecret: "csec",
    webhookSecret: opts.signingSecret,
  });
  const inst = await c.installations.insert({
    userId: "usr_a",
    providerId: "slack",
    workspaceId: "T07TEAM",
    workspaceName: "Acme",
    installKind: "dedicated",
    appId: app.id,
    accessToken: "xoxb-bot",
    refreshToken: null,
    scopes: ["bot:app_mentions:read", "user:search:read.public"],
    botUserId: "U07BOT",
  });
  await c.installations.setVaultId(inst.id, "vlt_user_xoxp");
  await c.installations.setBotVaultId(inst.id, "vlt_bot_xoxb");
  const pub = await c.publications.insert({
    userId: "usr_a",
    agentId: "agt_default",
    installationId: inst.id,
    environmentId: "env_dev",
    mode: "full",
    status: "live",
    persona: { name: "Triage", avatarUrl: null },
    capabilities: new Set(),
    sessionGranularity: "per_thread",
  });
  await c.apps.setPublicationId(app.id, pub.id);
  return { instId: inst.id, pubId: pub.id, appId: app.id };
}

/** app_mention envelope as a JSON string (for handleWebhook tests). */
export function appMentionPayload(opts: {
  channel: string;
  ts: string;
  thread_ts?: string;
  eventId: string;
  user?: string;
  text?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "app_mention",
      channel: opts.channel,
      ts: opts.ts,
      thread_ts: opts.thread_ts,
      user: opts.user ?? "U0USER",
      text: opts.text ?? "<@U07BOT> hello",
      event_ts: opts.ts,
    },
  });
}

/** url_verification challenge envelope as a JSON string. */
export function urlVerificationPayload(challenge: string): string {
  return JSON.stringify({
    type: "url_verification",
    token: "legacy_token",
    challenge,
  });
}

/**
 * Plain `message` event envelope (NOT an `app_mention`). Use to test
 * channel chatter, thread continuations, and DMs.
 */
export function messagePayload(opts: {
  channel: string;
  channelType?: "channel" | "im" | "group" | "mpim";
  ts: string;
  thread_ts?: string;
  eventId: string;
  user?: string;
  text?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "message",
      channel: opts.channel,
      channel_type: opts.channelType ?? "channel",
      ts: opts.ts,
      thread_ts: opts.thread_ts,
      user: opts.user ?? "U0USER",
      text: opts.text ?? "hello",
      event_ts: opts.ts,
    },
  });
}
