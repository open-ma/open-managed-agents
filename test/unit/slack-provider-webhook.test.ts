import { describe, it, expect, beforeEach } from "vitest";
import { SlackProvider } from "../../packages/slack/src/provider";
import {
  appMentionPayload,
  buildFakeSlackContainer,
  makeSlackProvider,
  messagePayload,
  seedDedicatedSlackPublication,
  urlVerificationPayload,
  type FakeSlackBundle,
} from "./slack-test-helpers";

const APP_SIGNING_SECRET = "ssec";

/**
 * Build a v0=<hex> signature header using the FakeHmacVerifier convention.
 * The fake compares the signature string to `expected:{secret}:{baseString}`.
 * To make verify() return true, we need the hex part of "v0=<hex>" to equal
 * exactly that. But the parser strips the v0= prefix and lowercases. So we
 * hash a sentinel into hex chars; tests use this helper instead of computing
 * a real HMAC.
 */

describe("SlackProvider — handleWebhook", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;
  let appId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeSlackContainer();
    // Override hmac.verify so it accepts a signature constructed as
    // `v0=valid:{secret}:{baseString}` — we don't try to fit hex; tests use
    // a sentinel that the parser will reject in malformed cases too.
    c.hmac.verify = async (secret: string, baseString: string, hex: string) => {
      return hex === `valid${secret}${baseString}`.toLowerCase().replace(/[^a-f0-9]/g, "");
    };
    provider = makeSlackProvider(c);
    const seeded = await seedDedicatedSlackPublication(c, {
      signingSecret: APP_SIGNING_SECRET,
    });
    appId = seeded.appId;
    pubId = seeded.pubId;
    // Pin time so isTimestampFresh accepts ts="1700000000".
    c.clock.set(1_700_000_000_000);
  });

  function validSig(rawBody: string, ts: string): string {
    const baseString = `v0:${ts}:${rawBody}`;
    const hex = `valid${APP_SIGNING_SECRET}${baseString}`
      .toLowerCase()
      .replace(/[^a-f0-9]/g, "");
    return `v0=${hex}`;
  }

  it("rejects when signature header is missing", async () => {
    const body = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev01",
    });
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-request-timestamp": "1700000000" },
      rawBody: body,
    });
    expect(out).toEqual({ handled: false, reason: "invalid_signature_header" });
  });

  it("rejects stale timestamps (>5 min skew)", async () => {
    const body = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev01",
    });
    const staleTs = "1699999000"; // 1000 sec back, > 300 sec skew
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: {
        "x-slack-signature": validSig(body, staleTs),
        "x-slack-request-timestamp": staleTs,
      },
      rawBody: body,
    });
    expect(out).toEqual({ handled: false, reason: "stale_timestamp" });
  });

  it("echoes the challenge on url_verification (skips dedup)", async () => {
    const body = urlVerificationPayload("xyz123");
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: {
        "x-slack-signature": validSig(body, ts),
        "x-slack-request-timestamp": ts,
      },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.reason).toBe("url_verification");
    expect(out.challengeResponse).toBe("xyz123");
    expect(out.deferredWork).toBeUndefined();
  });

  it("dispatches a session on app_mention via deferredWork (3-sec budget)", async () => {
    const body = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev01",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: {
        "x-slack-signature": validSig(body, ts),
        "x-slack-request-timestamp": ts,
      },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.publicationId).toBe(pubId);
    expect(out.deferredWork).toBeTypeOf("function");
    // No session yet — work was deferred.
    expect(c.sessions.created).toHaveLength(0);

    // Run the deferred work (mimicking executionCtx.waitUntil).
    await out.deferredWork!();

    expect(c.sessions.created).toHaveLength(1);
    const created = c.sessions.created[0];
    expect(created.userId).toBe("usr_a");
    expect(created.agentId).toBe("agt_default");
    expect(created.vaultIds).toEqual(["vlt_user_xoxp", "vlt_bot_xoxb"]);
    expect(created.mcpServers).toEqual([{ name: "slack", url: "https://mcp.slack.com/mcp" }]);

    const scope = await c.sessionScopes.getByScope(pubId, "C0CHAN:1700000000.000100");
    expect(scope?.status).toBe("active");
  });

  it("resumes the same session for a threaded reply", async () => {
    const ts1 = "1700000000";
    const body1 = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev01",
    });
    const out1 = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body1, ts1), "x-slack-request-timestamp": ts1 },
      rawBody: body1,
    });
    await out1.deferredWork!();
    const sid = c.sessions.created[0]; // first creation
    expect(c.sessions.created).toHaveLength(1);

    // Threaded reply → same scopeKey → resume.
    const body2 = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000005.000200",
      thread_ts: "1700000000.000100",
      eventId: "Ev02",
    });
    const out2 = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body2, ts1), "x-slack-request-timestamp": ts1 },
      rawBody: body2,
    });
    await out2.deferredWork!();

    expect(c.sessions.created).toHaveLength(1); // no new create
    expect(c.sessions.resumed).toHaveLength(1);
    expect(c.sessions.resumed[0].sessionId).toBe("sess_1");
    void sid;
  });

  it("dedupes on event_id (Slack retries on 5xx)", async () => {
    const body = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev_DUP",
    });
    const ts = "1700000000";
    const headers = {
      "x-slack-signature": validSig(body, ts),
      "x-slack-request-timestamp": ts,
    };

    const first = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers,
      rawBody: body,
    });
    expect(first.handled).toBe(true);

    const second = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers,
      rawBody: body,
    });
    expect(second).toEqual({ handled: false, reason: "duplicate_delivery" });
  });

  it("skips bot's own messages (loop protection)", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_BOT",
      event_time: 1_700_000_000,
      team_id: "T07TEAM",
      api_app_id: "A07APP",
      event: {
        type: "message",
        channel: "C0CHAN",
        ts: "1700000000.000300",
        bot_id: "B07BOT",
        subtype: "bot_message",
        text: "from another bot",
      },
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out).toEqual(
      expect.objectContaining({ handled: false, reason: "bot_message" }),
    );
    expect(c.sessions.created).toHaveLength(0);
  });

  it("marks installation revoked on tokens_revoked", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_REVOKE",
      event_time: 1_700_000_000,
      team_id: "T07TEAM",
      api_app_id: "A07APP",
      event: {
        type: "tokens_revoked",
        tokens: { oauth: ["U07USER"], bot: ["U07BOT"] },
      },
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.reason).toBe("tokens_revoked");

    // installation marked revoked
    const insts = await c.installations.listByUser("usr_a", "slack");
    expect(insts).toHaveLength(0); // listByUser filters revoked
  });

  it("marks installation revoked on app_uninstalled", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_UNINSTALL",
      event_time: 1_700_000_000,
      team_id: "T07TEAM",
      api_app_id: "A07APP",
      event: { type: "app_uninstalled" },
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.reason).toBe("app_uninstalled");
  });

  it("drops the redundant `message` Slack delivers alongside `app_mention`", async () => {
    // Slack always sends BOTH message.channels and app_mention for an @-bot
    // post in a channel. They reference the same Slack message ts. The
    // provider must drop the message so the OMA session doesn't get a
    // duplicate user.message + so the two events don't race on the
    // per-thread session row.
    const body = messagePayload({
      channel: "C0CHAN",
      ts: "1700000000.000100",
      eventId: "Ev_DUP",
      // U07BOT is the bot user id seeded by seedDedicatedSlackPublication.
      text: "<@U07BOT> hello there",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out).toEqual(
      expect.objectContaining({ handled: false, reason: "redundant_with_app_mention" }),
    );
    expect(c.sessions.created).toHaveLength(0);
  });

  it("drops random channel chatter the bot wasn't invoked for", async () => {
    // Bot is in #C0CHAN but a user posts a regular message that doesn't
    // mention the bot and isn't continuing an existing thread. We must NOT
    // start a new agent session — the bot wasn't addressed.
    const body = messagePayload({
      channel: "C0CHAN",
      ts: "1700000000.000400",
      eventId: "Ev_CHATTER",
      text: "team meeting at 3pm",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out).toEqual(
      expect.objectContaining({ handled: false, reason: "not_addressed_to_bot" }),
    );
    expect(c.sessions.created).toHaveLength(0);
  });

  it("dispatches DM messages without requiring an @-mention", async () => {
    // The DM IS to the bot — channel id starts with D, channel_type is "im".
    const body = messagePayload({
      channel: "D0DM",
      channelType: "im",
      ts: "1700000000.000500",
      eventId: "Ev_DM",
      text: "hi privately",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.deferredWork).toBeTypeOf("function");
    await out.deferredWork!();
    expect(c.sessions.created).toHaveLength(1);
  });

  it("resumes an active thread on continuation messages with no @-mention", async () => {
    await c.sessionScopes.insert({
      tenantId: "tnt_a",
      publicationId: pubId,
      scopeKey: "C0CHAN:1700000000.000100",
      sessionId: "sess_existing",
      status: "active",
      createdAt: 1_700_000_000_000,
    });
    const body = messagePayload({
      channel: "C0CHAN",
      ts: "1700000005.000200",
      thread_ts: "1700000000.000100",
      eventId: "Ev_FOLLOWUP",
      text: "got it, thanks",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    await out.deferredWork!();
    expect(c.sessions.created).toHaveLength(0);
    expect(c.sessions.resumed).toHaveLength(1);
    expect(c.sessions.resumed[0].sessionId).toBe("sess_existing");
  });

  it("recovers from a sessionScope insert race by resuming the winner", async () => {
    // Pre-seed a winner scope row — concurrent dispatcher already bound it.
    await c.sessionScopes.insert({
      tenantId: "tnt_a",
      publicationId: pubId,
      scopeKey: "C0CHAN:1700000000.000700",
      sessionId: "sess_winner",
      status: "active",
      createdAt: 1_700_000_000_000,
    });
    // Stub getByScope so the FIRST call (in classifyDispatch) returns null
    // (so we don't take the early-resume path), but the SECOND call (the
    // post-conflict re-fetch in dispatchEvent) returns the winner.
    const real = c.sessionScopes.getByScope.bind(c.sessionScopes);
    let calls = 0;
    c.sessionScopes.getByScope = async (p: string, k: string) => {
      calls += 1;
      return calls === 1 ? null : real(p, k);
    };
    const body = appMentionPayload({
      channel: "C0CHAN",
      ts: "1700000000.000700",
      eventId: "Ev_RACE",
    });
    const ts = "1700000000";
    const out = await provider.handleWebhook({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers: { "x-slack-signature": validSig(body, ts), "x-slack-request-timestamp": ts },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    await out.deferredWork!();
    // The orphan session WAS created (we lost the race after creation);
    // but the event was routed to the winner via resume.
    expect(c.sessions.resumed).toHaveLength(1);
    expect(c.sessions.resumed[0].sessionId).toBe("sess_winner");
  });
});
