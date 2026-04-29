// Slack Events API payload shapes — typed from Slack's documented schema with
// only the fields we consume. Keep narrow: extracting more later is cheap,
// pretending we know fields we don't is expensive.
//
// References:
//   https://docs.slack.dev/apis/events-api/
//   https://docs.slack.dev/reference/events/
//   https://docs.slack.dev/reference/events/url_verification/
//   https://docs.slack.dev/reference/events/member_joined_channel/
//   https://docs.slack.dev/reference/events/reaction_added/
//   https://docs.slack.dev/reference/events/channel_archive/
//   https://docs.slack.dev/ai/developing-ai-apps  (assistant_thread_*)

/**
 * Top-level envelope. Slack's Events API uses a tagged union — the `type`
 * field discriminates between handshake, event_callback, and rate-limit.
 */
export type RawSlackEnvelope =
  | RawUrlVerification
  | RawEventCallback
  | RawAppRateLimited
  | RawUnknown;

export interface RawUrlVerification {
  type: "url_verification";
  /** Random string Slack expects us to echo back within 3 sec. */
  challenge: string;
  token?: string;
}

export interface RawEventCallback {
  type: "event_callback";
  /** Globally-unique delivery id (idempotency key, e.g. `Ev01ABC…`). */
  event_id: string;
  event_time: number;
  /** Workspace id. */
  team_id: string;
  api_app_id: string;
  event: RawEventInner;
}

export interface RawAppRateLimited {
  type: "app_rate_limited";
  team_id?: string;
  api_app_id?: string;
  minute_rate_limited?: number;
}

export interface RawUnknown {
  type: string;
  [k: string]: unknown;
}

export interface RawEventInner {
  type: string;
  user?: string;
  text?: string;
  /** For most events. For channel_rename it's a nested object {id,name,...}. */
  channel?: string | { id?: string; name?: string; [k: string]: unknown };
  /** Top-level message ts. */
  ts?: string;
  /** Set when the message is in a thread. */
  thread_ts?: string;
  event_ts?: string;
  /** Subtype distinguishes bot messages, edits, etc. */
  subtype?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  /** assistant_thread_started events ship the assistant_thread block. */
  assistant_thread?: {
    user_id?: string;
    context?: Record<string, unknown>;
    channel_id?: string;
    thread_ts?: string;
  };
  /** tokens_revoked / app_uninstalled events. */
  tokens?: { oauth?: string[]; bot?: string[] };
  /** reaction_added / reaction_removed payload shape. */
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
    [k: string]: unknown;
  };
  /** reaction_added: Slack id of the user who *authored* item.message. */
  item_user?: string;
  [k: string]: unknown;
}

// ─── Normalized shape consumed by the provider ──────────────────────────

/** Event kinds we route on. Slack emits more — anything else returns null. */
export type SlackEventKind =
  | "app_mention"
  | "message"
  | "assistant_thread_started"
  | "tokens_revoked"
  | "app_uninstalled"
  | "member_joined_channel"
  | "member_left_channel"
  | "channel_archive"
  | "channel_unarchive"
  | "channel_rename"
  | "reaction_added"
  | "reaction_removed";

export interface NormalizedSlackEvent {
  kind: SlackEventKind | null;
  /** Slack's event_id (idempotency key). */
  deliveryId: string;
  /** Workspace / team id. */
  workspaceId: string;
  /** Channel id (C.../G.../D...) — null for tokens_revoked/app_uninstalled. */
  channelId: string | null;
  /**
   * Conversation kind, derived from inner.channel_type when present and from
   * channelId prefix as fallback. Lets the provider decide dispatch policy
   * without re-parsing raw fields.
   *   - "im"      direct message to the bot
   *   - "channel" public channel
   *   - "group"   private channel
   *   - "mpim"    multi-person DM
   *   - null      no channel (tokens_revoked / app_uninstalled / lifecycle events)
   */
  channelType: "im" | "channel" | "group" | "mpim" | null;
  /** thread_ts if in a thread, falls back to ts (top-level message). */
  threadTs: string | null;
  /** Event timestamp (the message's own `ts`). */
  eventTs: string | null;
  /**
   * Conversation scope key for per-thread session granularity:
   *   `${channel_id}:${thread_ts ?? event_ts}`
   * Null when there's no channel/ts (uninstall events). For per_channel
   * granularity the provider composes its own key (`channel:${channel_id}`).
   */
  scopeKey: string | null;
  userId: string | null;
  text: string | null;
  /** True when the event originated from a bot (skip to avoid loops). */
  isBotMessage: boolean;
  /** Raw event type for logging (e.g. "app_mention", "message"). */
  eventType: string;
  /**
   * True for non-thread top-level messages (`thread_ts` is absent or equals
   * the message's own `ts`) of kind `message` or `app_mention`. False for
   * thread replies and non-message events. Only meaningful for `per_channel`
   * granularity, which uses this to decide scan-arm dispatch.
   *
   * Excludes message edits/deletes (subtype `message_changed` / `_deleted`).
   */
  isTopLevel: boolean;
  /** reaction_added / reaction_removed: name of the emoji (no colons). */
  reactionName: string | null;
  /** reaction_added / reaction_removed: ts of the message that was reacted to. */
  itemTs: string | null;
  /** reaction_added / reaction_removed: Slack id of the message's author. */
  itemUserId: string | null;
  /** channel_rename: the channel's new display name (no `#`). */
  channelName: string | null;
}

/** Parses Slack's raw envelope into our normalized shape. Pure function. */
export function parseWebhook(raw: RawSlackEnvelope): NormalizedSlackEvent | null {
  if (raw.type !== "event_callback") return null; // url_verification + app_rate_limited handled separately
  const env = raw as RawEventCallback;
  if (!env.event_id || !env.team_id || !env.event) return null;

  const inner = env.event;
  const kind = mapEventKind(inner.type);
  if (kind === null) {
    // Unknown event type — record for idempotency but don't dispatch.
    const channelId = pickChannelId(inner);
    return {
      kind: null,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs: pickThreadTs(inner),
      eventTs: pickString(inner, "ts") ?? pickString(inner, "event_ts"),
      scopeKey: null,
      userId: pickString(inner, "user"),
      text: pickString(inner, "text"),
      isBotMessage: detectBotMessage(inner),
      eventType: typeof inner.type === "string" ? inner.type : "",
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName: null,
    };
  }

  // Revocation/uninstall events — no channel/ts.
  if (kind === "tokens_revoked" || kind === "app_uninstalled") {
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId: null,
      channelType: null,
      threadTs: null,
      eventTs: null,
      scopeKey: null,
      userId: null,
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName: null,
    };
  }

  // assistant_thread_started — channel_id + thread_ts live under assistant_thread.
  if (kind === "assistant_thread_started") {
    const at = inner.assistant_thread ?? {};
    const channelId = typeof at.channel_id === "string" ? at.channel_id : null;
    const threadTs = typeof at.thread_ts === "string" ? at.thread_ts : null;
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs,
      eventTs: pickString(inner, "event_ts"),
      scopeKey: channelId && threadTs ? `${channelId}:${threadTs}` : null,
      userId: typeof at.user_id === "string" ? at.user_id : null,
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName: null,
    };
  }

  // member_joined_channel / member_left_channel — payload `{ user, channel }`.
  // These are channel-membership lifecycle events; the provider gates dispatch
  // on `userId === installation.botUserId` (only act on the bot's own joins).
  if (kind === "member_joined_channel" || kind === "member_left_channel") {
    const channelId = pickChannelId(inner);
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs: null,
      eventTs: pickString(inner, "event_ts"),
      scopeKey: null,
      userId: pickString(inner, "user"),
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName: null,
    };
  }

  // channel_archive / channel_unarchive — payload `{ channel, user }`. The
  // user is whoever triggered the archive (may not be the bot); dispatch
  // gates on whether *we have an active per_channel session* in this channel.
  if (kind === "channel_archive" || kind === "channel_unarchive") {
    const channelId = pickChannelId(inner);
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs: null,
      eventTs: pickString(inner, "event_ts"),
      scopeKey: null,
      userId: pickString(inner, "user"),
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName: null,
    };
  }

  // channel_rename — payload `{ channel: { id, name, ... } }`.
  if (kind === "channel_rename") {
    const channelObj = typeof inner.channel === "object" && inner.channel ? inner.channel : null;
    const channelId = channelObj && typeof channelObj.id === "string" ? channelObj.id : null;
    const channelName = channelObj && typeof channelObj.name === "string" ? channelObj.name : null;
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs: null,
      eventTs: pickString(inner, "event_ts"),
      scopeKey: null,
      userId: pickString(inner, "user"),
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: null,
      itemTs: null,
      itemUserId: null,
      channelName,
    };
  }

  // reaction_added / reaction_removed — `{ user, reaction, item: { channel, ts }, item_user }`.
  // The provider gates dispatch on `itemUserId === installation.botUserId`
  // (only feedback on bot's own messages matters).
  if (kind === "reaction_added" || kind === "reaction_removed") {
    const item = inner.item ?? {};
    const channelId = typeof item.channel === "string" ? item.channel : null;
    return {
      kind,
      deliveryId: env.event_id,
      workspaceId: env.team_id,
      channelId,
      channelType: pickChannelType(inner, channelId),
      threadTs: null,
      eventTs: pickString(inner, "event_ts"),
      scopeKey: null,
      userId: pickString(inner, "user"),
      text: null,
      isBotMessage: false,
      eventType: inner.type,
      isTopLevel: false,
      reactionName: typeof inner.reaction === "string" ? inner.reaction : null,
      itemTs: typeof item.ts === "string" ? item.ts : null,
      itemUserId: typeof inner.item_user === "string" ? inner.item_user : null,
      channelName: null,
    };
  }

  // app_mention / message — standard channel events.
  const channelId = pickChannelId(inner);
  const channelType = pickChannelType(inner, channelId);
  const ts = pickString(inner, "ts");
  const threadTs = pickThreadTs(inner);
  // For top-level mentions/messages, use the message's own ts as thread_ts —
  // when the bot replies it'll be `thread_ts: ts` and start a thread.
  const effectiveThread = threadTs ?? ts;
  const scopeKey = channelId && effectiveThread ? `${channelId}:${effectiveThread}` : null;
  // True top-level: thread_ts is absent (or equals ts), and not an edit/delete
  // subtype. Edits and deletes carry ts/thread_ts but shouldn't re-arm scans.
  const subtype = pickString(inner, "subtype");
  const isEditOrDelete =
    subtype === "message_changed" || subtype === "message_deleted";
  const isTopLevel =
    !isEditOrDelete &&
    (kind === "message" || kind === "app_mention") &&
    threadTs === null;

  return {
    kind,
    deliveryId: env.event_id,
    workspaceId: env.team_id,
    channelId,
    channelType,
    threadTs: effectiveThread,
    eventTs: ts ?? pickString(inner, "event_ts"),
    scopeKey,
    userId: pickString(inner, "user"),
    text: pickString(inner, "text"),
    isBotMessage: detectBotMessage(inner),
    eventType: inner.type,
    isTopLevel,
    reactionName: null,
    itemTs: null,
    itemUserId: null,
    channelName: null,
  };
}

function mapEventKind(type: string | undefined): SlackEventKind | null {
  switch (type) {
    case "app_mention":
    case "message":
    case "assistant_thread_started":
    case "tokens_revoked":
    case "app_uninstalled":
    case "member_joined_channel":
    case "member_left_channel":
    case "channel_archive":
    case "channel_unarchive":
    case "channel_rename":
    case "reaction_added":
    case "reaction_removed":
      return type;
    default:
      return null;
  }
}

function pickThreadTs(inner: RawEventInner): string | null {
  return typeof inner.thread_ts === "string" ? inner.thread_ts : null;
}

/**
 * Read inner.channel as a string id. Most events carry it as a flat string;
 * channel_rename nests it as `{ id, name, ... }`. Returns null for shapes
 * we don't recognize.
 */
function pickChannelId(inner: RawEventInner): string | null {
  if (typeof inner.channel === "string") return inner.channel;
  if (
    inner.channel &&
    typeof inner.channel === "object" &&
    typeof inner.channel.id === "string"
  ) {
    return inner.channel.id;
  }
  return null;
}

/**
 * Determine the conversation kind. Slack provides `channel_type` on most
 * `message.*` events; falls back to channel id prefix when absent (e.g. on
 * `app_mention` payloads which don't include channel_type).
 */
function pickChannelType(
  inner: RawEventInner,
  channelId: string | null,
): "im" | "channel" | "group" | "mpim" | null {
  const ct = typeof inner.channel_type === "string" ? inner.channel_type : null;
  if (ct === "im" || ct === "channel" || ct === "group" || ct === "mpim") {
    return ct;
  }
  if (!channelId) return null;
  // Slack id prefixes: D=direct message, G=private group/mpim, C=public channel.
  // mpim shares the G prefix with private groups; channel_type would
  // disambiguate if it were present, otherwise we return "group" for both.
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  if (channelId.startsWith("C")) return "channel";
  return null;
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const value = o[key];
  return typeof value === "string" ? value : null;
}

function detectBotMessage(inner: RawEventInner): boolean {
  if (inner.subtype === "bot_message") return true;
  if (typeof inner.bot_id === "string" && inner.bot_id.length > 0) return true;
  return false;
}
