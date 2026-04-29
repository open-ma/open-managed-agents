// Per_channel granularity tests for SlackProvider. Covers:
//   - lifecycle dispatch: member_joined/left, channel_archive/unarchive/rename
//   - debounce throttle on top-level scan-arm events
//   - reactions on bot-authored messages
//   - direct_invocation routing to channel-scoped session
//
// These exercise the `per_channel` paths that classifyDispatch + dispatchEvent
// added on top of the legacy `per_thread` flow. Reuses signing-secret + clock
// scaffolding from slack-test-helpers.

import { describe, it, expect, beforeEach } from "vitest";
import { SlackProvider } from "../../packages/slack/src/provider";
import {
  appMentionPayload,
  buildFakeSlackContainer,
  channelLifecyclePayload,
  channelRenamePayload,
  makeSlackProvider,
  memberJoinedChannelPayload,
  memberLeftChannelPayload,
  messagePayload,
  reactionPayload,
  seedDedicatedSlackPublication,
  type FakeSlackBundle,
} from "./slack-test-helpers";

const APP_SIGNING_SECRET = "ssec";
const CHANNEL = "C0CHAN";
const CHANNEL_SCOPE = `channel:${CHANNEL}`;
const BOT_USER_ID = "U07BOT";

describe("SlackProvider — per_channel granularity", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;
  let appId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeSlackContainer();
    c.hmac.verify = async (secret: string, baseString: string, hex: string) =>
      hex === `valid${secret}${baseString}`.toLowerCase().replace(/[^a-f0-9]/g, "");
    provider = makeSlackProvider(c);
    const seeded = await seedDedicatedSlackPublication(c, {
      signingSecret: APP_SIGNING_SECRET,
      sessionGranularity: "per_channel",
    });
    appId = seeded.appId;
    pubId = seeded.pubId;
    c.clock.set(1_700_000_000_000);
  });

  function validSig(rawBody: string, ts: string): string {
    const baseString = `v0:${ts}:${rawBody}`;
    const hex = `valid${APP_SIGNING_SECRET}${baseString}`
      .toLowerCase()
      .replace(/[^a-f0-9]/g, "");
    return `v0=${hex}`;
  }

  async function deliver(rawBody: string) {
    const ts = "1700000000";
    return await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: {
        "x-slack-signature": validSig(rawBody, ts),
        "x-slack-request-timestamp": ts,
      },
      rawBody,
    });
  }

  // ─── member_joined_channel ────────────────────────────────────────────

  describe("member_joined_channel", () => {
    it("creates a channel-session and emits joined_channel signal when bot itself joins", async () => {
      const out = await deliver(
        memberJoinedChannelPayload({ channel: CHANNEL, eventId: "Ev_J1", user: BOT_USER_ID }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.created).toHaveLength(1);
      const created = c.sessions.created[0];
      expect(created.metadata?.slack).toMatchObject({ channelId: CHANNEL });
      const text = (created.initialEvent.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="joined_channel">`);
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.status).toBe("active");
    });

    it("drops member_joined_channel for non-bot users", async () => {
      const out = await deliver(
        memberJoinedChannelPayload({ channel: CHANNEL, eventId: "Ev_J2", user: "U0USER" }),
      );
      expect(out).toMatchObject({ handled: false, reason: "non_bot_member_joined" });
      expect(c.sessions.created).toHaveLength(0);
    });
  });

  // ─── member_left_channel + channel_archive (close_session) ───────────

  describe("close_session lifecycle", () => {
    beforeEach(async () => {
      // Pre-seed an active channel-session for the close-path tests.
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "active",
        createdAt: c.clock.nowMs(),
      });
    });

    it("member_left_channel for bot closes channel-session and emits session_closed signal", async () => {
      const out = await deliver(
        memberLeftChannelPayload({ channel: CHANNEL, eventId: "Ev_L1", user: BOT_USER_ID }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.status).toBe("completed");
      expect(c.sessions.resumed).toHaveLength(1);
      const text = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="session_closed">`);
    });

    it("drops member_left_channel for non-bot users", async () => {
      const out = await deliver(
        memberLeftChannelPayload({ channel: CHANNEL, eventId: "Ev_L2", user: "U0USER" }),
      );
      expect(out).toMatchObject({ handled: false, reason: "non_bot_member_left" });
      expect(c.sessions.resumed).toHaveLength(0);
    });

    it("channel_archive closes the active channel-session", async () => {
      const out = await deliver(
        channelLifecyclePayload({ type: "channel_archive", channel: CHANNEL, eventId: "Ev_A1" }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.status).toBe("completed");
    });

    it("channel_archive drops if no active session for the channel", async () => {
      // No active session for C0OTHER.
      const out = await deliver(
        channelLifecyclePayload({ type: "channel_archive", channel: "C0OTHER", eventId: "Ev_A2" }),
      );
      expect(out).toMatchObject({ handled: false, reason: "no_active_channel_session" });
    });
  });

  // ─── channel_unarchive (reopen_session) ──────────────────────────────

  describe("channel_unarchive", () => {
    it("reopens a previously-completed channel-session", async () => {
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "completed",
        createdAt: c.clock.nowMs(),
      });
      const out = await deliver(
        channelLifecyclePayload({ type: "channel_unarchive", channel: CHANNEL, eventId: "Ev_U1" }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.status).toBe("active");
      expect(c.sessions.resumed).toHaveLength(1);
      const text = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="joined_channel">`);
      expect(text).toContain("added back to");
    });

    it("drops channel_unarchive when no prior session exists", async () => {
      const out = await deliver(
        channelLifecyclePayload({ type: "channel_unarchive", channel: CHANNEL, eventId: "Ev_U2" }),
      );
      expect(out).toMatchObject({ handled: false, reason: "no_prior_channel_session" });
    });
  });

  // ─── channel_rename (metadata_only) ──────────────────────────────────

  describe("channel_rename", () => {
    it("updates cached channel_name without waking the agent", async () => {
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "active",
        createdAt: c.clock.nowMs(),
      });
      const out = await deliver(
        channelRenamePayload({ channelId: CHANNEL, newName: "engineering-v2", eventId: "Ev_REN" }),
      );
      expect(out).toMatchObject({ handled: true, reason: "metadata_only" });
      expect(out.deferredWork).toBeUndefined();
      expect(c.sessions.resumed).toHaveLength(0);
      expect(c.sessions.created).toHaveLength(0);
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.channelName).toBe("engineering-v2");
    });

    it("drops channel_rename when no channel session exists", async () => {
      const out = await deliver(
        channelRenamePayload({ channelId: CHANNEL, newName: "renamed", eventId: "Ev_REN2" }),
      );
      expect(out).toMatchObject({ handled: false, reason: "no_channel_session" });
    });
  });

  // ─── scan_arm (top-level message debounce) ───────────────────────────

  describe("scan_arm debounce", () => {
    beforeEach(async () => {
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "active",
        createdAt: c.clock.nowMs(),
      });
    });

    it("first top-level message arms scan and resumes with channel_scan_armed signal", async () => {
      const out = await deliver(
        messagePayload({
          channel: CHANNEL,
          ts: "1700000010.000100",
          eventId: "Ev_M1",
          text: "anyone seen this stack trace?",
        }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.resumed).toHaveLength(1);
      const text = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="channel_scan_armed">`);
      expect(text).toContain("scheduleWakeup");
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.pendingScanUntil).not.toBeNull();
    });

    it("second top-level message inside debounce window throttles silently", async () => {
      // First arm.
      const first = await deliver(
        messagePayload({ channel: CHANNEL, ts: "1700000010.000100", eventId: "Ev_M1" }),
      );
      await first.deferredWork!();
      // Second within window — should not resume again.
      const out = await deliver(
        messagePayload({ channel: CHANNEL, ts: "1700000015.000100", eventId: "Ev_M2" }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      // Only the first message woke the agent.
      expect(c.sessions.resumed).toHaveLength(1);
      // The second's webhook event row carries the throttle reason.
      // (Handled via attachError — surfaces as a soft drop reason in logs.)
    });

    it("re-arms after pending_scan_until lapses", async () => {
      const first = await deliver(
        messagePayload({ channel: CHANNEL, ts: "1700000010.000100", eventId: "Ev_M1" }),
      );
      await first.deferredWork!();
      // Advance past the 90s debounce window.
      c.clock.set(1_700_000_000_000 + 91_000);
      const second = await deliver(
        messagePayload({ channel: CHANNEL, ts: "1700000091.000100", eventId: "Ev_M2" }),
      );
      await second.deferredWork!();
      expect(c.sessions.resumed).toHaveLength(2);
    });
  });

  // ─── reaction_added on bot's own message ─────────────────────────────

  describe("reactions on bot-authored messages", () => {
    beforeEach(async () => {
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "active",
        createdAt: c.clock.nowMs(),
      });
    });

    it("dispatches reaction_added on bot's message with reaction_on_bot_message signal", async () => {
      const out = await deliver(
        reactionPayload({
          type: "reaction_added",
          channel: CHANNEL,
          itemTs: "1700000005.000100",
          itemUser: BOT_USER_ID,
          reaction: "white_check_mark",
          eventId: "Ev_RX1",
        }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.resumed).toHaveLength(1);
      const text = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="reaction_on_bot_message">`);
      expect(text).toContain("white_check_mark");
    });

    it("dispatches reactions on non-bot messages too when per_channel session is active", async () => {
      // Under per_channel, any reaction in a channel the bot inhabits is
      // perceived — `treat agent like human`. Item_user comparison is
      // unreliable because mcp.slack.com posts via user xoxp- token, so
      // bot-authored messages report item_user as the installer not the bot.
      const out = await deliver(
        reactionPayload({
          type: "reaction_added",
          channel: CHANNEL,
          itemTs: "1700000005.000100",
          itemUser: "U0OTHER",
          eventId: "Ev_RX2",
        }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.resumed).toHaveLength(1);
      const text = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(text).toContain(`<oma_signal kind="reaction_on_bot_message">`);
    });

    it("drops reaction when no active per_channel session exists for the channel", async () => {
      // Reaction in a channel where bot has no session (we don't observe
      // channels we're not inhabiting).
      const out = await deliver(
        reactionPayload({
          type: "reaction_added",
          channel: "C0OTHER",
          itemTs: "1700000005.000100",
          itemUser: "U0OTHER",
          eventId: "Ev_RX3",
        }),
      );
      expect(out.handled).toBe(false);
      expect(out.reason).toBe("reaction_not_on_bot_message");
      expect(c.sessions.resumed).toHaveLength(0);
    });
  });

  // ─── direct_invocation routing under per_channel ────────────────────

  describe("direct invocation under per_channel", () => {
    it("@mention in a per_channel publication routes to the channel-session (lazy create)", async () => {
      // No pre-seeded scope — provider should lazy-create the channel-session
      // when it sees a direct invocation in a channel it didn't bootstrap via
      // member_joined_channel.
      const out = await deliver(
        appMentionPayload({
          channel: CHANNEL,
          ts: "1700000020.000100",
          eventId: "Ev_M3",
          text: `<@${BOT_USER_ID}> what's this channel for?`,
        }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.created).toHaveLength(1);
      const scope = await c.sessionScopes.getByScope(pubId, CHANNEL_SCOPE);
      expect(scope?.status).toBe("active");
      // Lazy-created sessions get the joined_channel onboarding signal first,
      // then a follow-up resume with the actual direct_invocation event.
      expect(c.sessions.resumed).toHaveLength(1);
      const followup = (c.sessions.resumed[0].event.content[0] as { text: string }).text;
      expect(followup).toContain(`<oma_signal kind="direct_invocation"`);
    });

    it("@mention in an existing channel-session resumes (not creates)", async () => {
      await c.sessionScopes.insert({
        tenantId: "tnt_a",
        publicationId: pubId,
        scopeKey: CHANNEL_SCOPE,
        sessionId: "sess_channel",
        status: "active",
        createdAt: c.clock.nowMs(),
      });
      const out = await deliver(
        appMentionPayload({
          channel: CHANNEL,
          ts: "1700000020.000100",
          eventId: "Ev_M4",
          text: `<@${BOT_USER_ID}> hi`,
        }),
      );
      expect(out.handled).toBe(true);
      await out.deferredWork!();
      expect(c.sessions.created).toHaveLength(0);
      expect(c.sessions.resumed).toHaveLength(1);
      expect(c.sessions.resumed[0].sessionId).toBe("sess_channel");
    });
  });
});
