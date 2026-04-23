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
});
