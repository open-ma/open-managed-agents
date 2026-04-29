import { describe, it, expect } from "vitest";
import { parseWebhook, type RawSlackEnvelope } from "../../packages/slack/src/webhook/parse";

function appMentionEvent(opts: {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
}): RawSlackEnvelope {
  return {
    type: "event_callback",
    event_id: "Ev01ABC",
    event_time: 1_700_000_000,
    team_id: "T07TEAM",
    api_app_id: "A07APP",
    event: {
      type: "app_mention",
      channel: opts.channel ?? "C0CHAN",
      ts: opts.ts ?? "1700000000.000100",
      thread_ts: opts.thread_ts,
      user: opts.user ?? "U0USER",
      text: opts.text ?? "<@U07BOT> please look at this",
      event_ts: opts.ts ?? "1700000000.000100",
    },
  };
}

describe("Slack webhook parse", () => {
  describe("envelope routing", () => {
    it("returns null for url_verification (handled separately by the provider)", () => {
      expect(
        parseWebhook({ type: "url_verification", challenge: "xyz" }),
      ).toBeNull();
    });

    it("returns null for app_rate_limited (informational; handled separately)", () => {
      expect(parseWebhook({ type: "app_rate_limited" })).toBeNull();
    });
  });

  describe("scopeKey for per_thread session granularity", () => {
    it("top-level app_mention uses message.ts as the thread root", () => {
      const event = parseWebhook(
        appMentionEvent({ channel: "C0CHAN", ts: "1700000000.000100" }),
      );
      expect(event?.kind).toBe("app_mention");
      expect(event?.threadTs).toBe("1700000000.000100");
      expect(event?.scopeKey).toBe("C0CHAN:1700000000.000100");
    });

    it("threaded reply uses the explicit thread_ts", () => {
      const event = parseWebhook(
        appMentionEvent({
          channel: "C0CHAN",
          ts: "1700000005.000200",
          thread_ts: "1700000000.000100",
        }),
      );
      expect(event?.threadTs).toBe("1700000000.000100");
      expect(event?.scopeKey).toBe("C0CHAN:1700000000.000100");
    });

    it("DM falls back to event.ts when no thread_ts", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev01ABC",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "message",
          channel: "D0DM",
          ts: "1700000000.000200",
          user: "U0USER",
          text: "hi bot",
        },
      });
      expect(event?.scopeKey).toBe("D0DM:1700000000.000200");
    });
  });

  describe("assistant_thread_started", () => {
    it("uses assistant_thread.{channel_id, thread_ts}", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev02",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "assistant_thread_started",
          assistant_thread: {
            user_id: "U0USER",
            channel_id: "D0AI",
            thread_ts: "1700000010.000300",
          },
        },
      });
      expect(event?.kind).toBe("assistant_thread_started");
      expect(event?.scopeKey).toBe("D0AI:1700000010.000300");
      expect(event?.userId).toBe("U0USER");
    });
  });

  describe("revocation events", () => {
    it("tokens_revoked has no scopeKey", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev03",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "tokens_revoked",
          tokens: { oauth: ["U07USER"], bot: ["U07BOT"] },
        },
      });
      expect(event?.kind).toBe("tokens_revoked");
      expect(event?.scopeKey).toBeNull();
      expect(event?.channelId).toBeNull();
    });

    it("app_uninstalled has no scopeKey", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev04",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: { type: "app_uninstalled" },
      });
      expect(event?.kind).toBe("app_uninstalled");
      expect(event?.scopeKey).toBeNull();
    });
  });

  describe("bot loop protection", () => {
    it("flags subtype: bot_message", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev05",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "message",
          channel: "C0CHAN",
          ts: "1700000020.000400",
          subtype: "bot_message",
          bot_id: "B07BOT",
          text: "auto-reply from another bot",
        },
      });
      expect(event?.isBotMessage).toBe(true);
    });

    it("flags messages with bot_id even without subtype", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev06",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "message",
          channel: "C0CHAN",
          ts: "1700000030.000500",
          bot_id: "B07BOT",
          text: "from a bot",
        },
      });
      expect(event?.isBotMessage).toBe(true);
    });

    it("regular user message is not flagged", () => {
      const event = parseWebhook(appMentionEvent({}));
      expect(event?.isBotMessage).toBe(false);
    });
  });

  describe("unknown event kinds", () => {
    it("returns shell event with kind=null so dedup still happens", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev99",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: { type: "team_rename", channel: undefined },
      });
      expect(event?.kind).toBeNull();
      expect(event?.deliveryId).toBe("Ev99");
      expect(event?.eventType).toBe("team_rename");
    });
  });

  describe("malformed envelopes", () => {
    it("returns null when event_callback is missing event_id", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "",
        event_time: 0,
        team_id: "T",
        api_app_id: "A",
        event: { type: "app_mention" },
      });
      expect(event).toBeNull();
    });
  });

  describe("isTopLevel — per_channel scan-arm gate", () => {
    it("flags top-level message (no thread_ts) as isTopLevel", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_TOP",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "message",
          channel: "C0CHAN",
          ts: "1700000000.000100",
          channel_type: "channel",
          user: "U0USER",
          text: "hi",
        },
      });
      expect(event?.isTopLevel).toBe(true);
    });

    it("flags thread reply (thread_ts != ts) as NOT isTopLevel", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_REPLY",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "message",
          channel: "C0CHAN",
          ts: "1700000005.000100",
          thread_ts: "1700000000.000100",
          channel_type: "channel",
          user: "U0USER",
          text: "follow-up",
        },
      });
      expect(event?.isTopLevel).toBe(false);
    });

    it("flags message_changed subtype as NOT isTopLevel (don't re-arm on edits)", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_EDIT",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "message",
          subtype: "message_changed",
          channel: "C0CHAN",
          ts: "1700000010.000100",
          channel_type: "channel",
          user: "U0USER",
          text: "edited",
        },
      });
      expect(event?.isTopLevel).toBe(false);
    });
  });

  describe("member_joined_channel / member_left_channel", () => {
    it("parses member_joined_channel with user + channel", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_JOIN",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "member_joined_channel",
          channel: "C0CHAN",
          user: "U07BOT",
          event_ts: "1700000000.000123",
        },
      });
      expect(event?.kind).toBe("member_joined_channel");
      expect(event?.channelId).toBe("C0CHAN");
      expect(event?.userId).toBe("U07BOT");
      expect(event?.scopeKey).toBeNull();
      expect(event?.isTopLevel).toBe(false);
    });

    it("parses member_left_channel symmetrically", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_LEFT",
        event_time: 1_700_000_000,
        team_id: "T07TEAM",
        api_app_id: "A07APP",
        event: {
          type: "member_left_channel",
          channel: "C0CHAN",
          user: "U07BOT",
        },
      });
      expect(event?.kind).toBe("member_left_channel");
      expect(event?.channelId).toBe("C0CHAN");
      expect(event?.userId).toBe("U07BOT");
    });
  });

  describe("channel lifecycle (archive / unarchive / rename)", () => {
    it("parses channel_archive", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_ARCH",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: { type: "channel_archive", channel: "C0CHAN", user: "U07ADMIN" },
      });
      expect(event?.kind).toBe("channel_archive");
      expect(event?.channelId).toBe("C0CHAN");
      expect(event?.userId).toBe("U07ADMIN");
    });

    it("parses channel_rename with nested channel.{id,name}", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_REN",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "channel_rename",
          channel: { id: "C0CHAN", name: "engineering-v2", created: 1 },
        },
      });
      expect(event?.kind).toBe("channel_rename");
      expect(event?.channelId).toBe("C0CHAN");
      expect(event?.channelName).toBe("engineering-v2");
    });
  });

  describe("reaction_added / reaction_removed", () => {
    it("parses reaction_added with item_user, reaction name, item.ts/channel", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_RX",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "reaction_added",
          user: "U0USER",
          reaction: "white_check_mark",
          item: { type: "message", channel: "C0CHAN", ts: "1700000000.000999" },
          item_user: "U07BOT",
          event_ts: "1700000005.000111",
        },
      });
      expect(event?.kind).toBe("reaction_added");
      expect(event?.channelId).toBe("C0CHAN");
      expect(event?.userId).toBe("U0USER");
      expect(event?.itemUserId).toBe("U07BOT");
      expect(event?.itemTs).toBe("1700000000.000999");
      expect(event?.reactionName).toBe("white_check_mark");
    });

    it("parses reaction_removed symmetrically", () => {
      const event = parseWebhook({
        type: "event_callback",
        event_id: "Ev_RXRM",
        event_time: 1_700_000_000,
        team_id: "T",
        api_app_id: "A",
        event: {
          type: "reaction_removed",
          user: "U0USER",
          reaction: "thumbsdown",
          item: { type: "message", channel: "C0CHAN", ts: "1700000000.000888" },
          item_user: "U07BOT",
        },
      });
      expect(event?.kind).toBe("reaction_removed");
      expect(event?.reactionName).toBe("thumbsdown");
    });
  });
});
