// Shared test fixtures for Slack provider tests. Eliminates duplicate
// FakeSlackInstallationRepo / buildFakeSlackContainer / makeProvider blocks
// across slack-provider-*.test.ts.
//
// Mirrors test/unit/github-test-helpers.ts — both keep helper surface narrow
// enough that a test reader doesn't have to chase indirection to follow the
// scenario.

import { SlackProvider, type SlackContainer } from "../../packages/slack/src/provider";
import type {
  SlackInstallationRepo,
  SlackSessionScopeRepo,
} from "../../packages/slack/src/ports";
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
import type { SessionGranularity } from "../../packages/integrations-core/src/domain";

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

/**
 * Slack-flavored in-memory SessionScopeRepo with per_channel methods
 * (armPendingScan / clearPendingScan / updateChannelName) on top of the base
 * SessionScopeRepo contract. Doesn't extend InMemorySessionScopeRepo because
 * the base stores plain SessionScope rows that lose the per_channel fields
 * across updateStatus; cleaner to own the Map directly.
 */
export class FakeSlackSessionScopeRepo implements SlackSessionScopeRepo {
  private rows = new Map<
    string,
    import("../../packages/integrations-core/src/domain").SessionScope
  >();

  private key(publicationId: string, scopeKey: string): string {
    return `${publicationId}:${scopeKey}`;
  }

  async getByScope(
    publicationId: string,
    scopeKey: string,
  ): Promise<import("../../packages/integrations-core/src/domain").SessionScope | null> {
    return this.rows.get(this.key(publicationId, scopeKey)) ?? null;
  }

  async insert(
    row: import("../../packages/integrations-core/src/domain").SessionScope,
  ): Promise<boolean> {
    const k = this.key(row.publicationId, row.scopeKey);
    if (this.rows.has(k)) return false;
    this.rows.set(k, row);
    return true;
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: import("../../packages/integrations-core/src/domain").SessionScopeStatus,
  ): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status });
  }

  async listActive(
    publicationId: string,
  ): Promise<readonly import("../../packages/integrations-core/src/domain").SessionScope[]> {
    return [...this.rows.values()].filter(
      (r) => r.publicationId === publicationId && r.status === "active",
    );
  }

  async armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (!row) return { armed: false, currentUntil: null };
    const current = row.pendingScanUntil ?? null;
    if (current === null || current <= now) {
      this.rows.set(k, { ...row, pendingScanUntil: until });
      return { armed: true, currentUntil: null };
    }
    return { armed: false, currentUntil: current };
  }

  async clearPendingScan(publicationId: string, scopeKey: string): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, pendingScanUntil: null });
  }

  async updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, channelName });
  }

  async closeAllForPublication(publicationId: string): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.publicationId === publicationId && row.status === "active") {
        this.rows.set(k, { ...row, status: "completed", pendingScanUntil: null });
      }
    }
  }
}

export interface FakeSlackBundle extends Omit<FakeContainer, "installations" | "sessionScopes"> {
  installations: FakeSlackInstallationRepo;
  sessionScopes: FakeSlackSessionScopeRepo;
}

export function buildFakeSlackContainer(): FakeSlackBundle {
  const base = buildFakeContainer();
  return {
    ...base,
    installations: new FakeSlackInstallationRepo(base.clock),
    sessionScopes: new FakeSlackSessionScopeRepo(),
  };
}

export function makeSlackProvider(
  c: FakeSlackBundle,
  overrides?: Partial<{ gatewayOrigin: string; defaultSessionGranularity: SessionGranularity }>,
): SlackProvider {
  return new SlackProvider(c as SlackContainer, {
    gatewayOrigin: overrides?.gatewayOrigin ?? "https://gw",
    botScopes: DEFAULT_SLACK_BOT_SCOPES,
    userScopes: DEFAULT_SLACK_USER_SCOPES,
    defaultCapabilities: ALL_SLACK_CAPABILITIES,
    defaultSessionGranularity: overrides?.defaultSessionGranularity,
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
  opts: { signingSecret: string; sessionGranularity?: SessionGranularity },
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
    sessionGranularity: opts.sessionGranularity ?? "per_thread",
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

/** member_joined_channel envelope. user defaults to bot id. */
export function memberJoinedChannelPayload(opts: {
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "member_joined_channel",
      channel: opts.channel,
      user: opts.user ?? "U07BOT",
      event_ts: "1700000000.000100",
    },
  });
}

/** member_left_channel envelope. */
export function memberLeftChannelPayload(opts: {
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "member_left_channel",
      channel: opts.channel,
      user: opts.user ?? "U07BOT",
      event_ts: "1700000000.000200",
    },
  });
}

/** channel_archive / channel_unarchive envelope. */
export function channelLifecyclePayload(opts: {
  type: "channel_archive" | "channel_unarchive";
  channel: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: opts.type,
      channel: opts.channel,
      user: opts.user ?? "U07ADMIN",
      event_ts: "1700000000.000300",
    },
  });
}

/** channel_rename envelope — channel field is `{ id, name }`. */
export function channelRenamePayload(opts: {
  channelId: string;
  newName: string;
  eventId: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "channel_rename",
      channel: { id: opts.channelId, name: opts.newName, created: 1_700_000_000 },
      event_ts: "1700000000.000400",
    },
  });
}

/** reaction_added / reaction_removed envelope. */
export function reactionPayload(opts: {
  type: "reaction_added" | "reaction_removed";
  channel: string;
  itemTs: string;
  itemUser?: string;
  reaction?: string;
  eventId: string;
  user?: string;
}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: opts.type,
      user: opts.user ?? "U0USER",
      reaction: opts.reaction ?? "thumbsup",
      item: {
        type: "message",
        channel: opts.channel,
        ts: opts.itemTs,
      },
      item_user: opts.itemUser ?? "U07BOT",
      event_ts: "1700000000.000500",
    },
  });
}
