// SlackProvider configuration. Cleanly separated from runtime ports so the
// provider remains pure and testable.

/**
 * Slack-specific capability keys gating Web API operations. Stored as opaque
 * strings at the core boundary (CapabilityKey = string) so providers don't
 * collide. Use this union internally for type safety.
 */
export type SlackCapabilityKey =
  | "message.read"
  | "message.write"
  | "message.update"
  | "message.delete"
  | "thread.reply"
  | "reaction.add"
  | "reaction.remove"
  | "user.read"
  | "search.read"
  | "canvas.write";

export interface SlackConfig {
  /**
   * Public origin of the integrations gateway, used to build OAuth callback
   * and Events Request URLs surfaced to Slack. e.g. "https://integrations.example.com".
   */
  gatewayOrigin: string;

  /**
   * Bot scopes requested at install time. The bot token (`xoxb-`) carries
   * these and is used for Web API calls the bot makes (chat.postMessage,
   * reactions.add, etc.) plus receiving Events.
   */
  botScopes: ReadonlyArray<string>;

  /**
   * User scopes requested at install time. The user token (`xoxp-`) carries
   * these and is REQUIRED for `mcp.slack.com/mcp` — Slack's hosted MCP server
   * authenticates with user tokens. Without these, MCP tool calls 401.
   */
  userScopes: ReadonlyArray<string>;

  /**
   * Default capability set for new publications. Per-publication overrides
   * (which may only further restrict) are stored on the Publication row.
   */
  defaultCapabilities: ReadonlyArray<SlackCapabilityKey>;
}

/**
 * Bot scopes for an OMA agent published into Slack. Covers the common path:
 * receive @-mentions and DMs, post messages, react, fetch user/team metadata.
 *
 * - app_mentions:read     — receive `app_mention` events
 * - chat:write            — chat.postMessage as the bot
 * - chat:write.public     — post in channels the bot isn't a member of
 * - channels:history      — read public channel messages (needed for thread context)
 * - groups:history        — read private channel messages
 * - im:history            — read direct messages
 * - mpim:history          — read multi-person DMs
 * - reactions:read/write  — observe + add reactions
 * - users:read            — fetch user profiles (display name, avatar)
 * - users:read.email      — email lookup (handoff/notification flows)
 * - team:read             — workspace metadata for the install row
 */
export const DEFAULT_SLACK_BOT_SCOPES: ReadonlyArray<string> = [
  "app_mentions:read",
  "chat:write",
  "chat:write.public",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
  "team:read",
] as const;

/**
 * User scopes required for `mcp.slack.com/mcp`. Slack's hosted MCP server
 * authenticates with the installing user's token and inherits that user's
 * permissions for search, channel access, canvases, etc.
 *
 * Reference: https://docs.slack.dev/ai/slack-mcp-server/
 */
export const DEFAULT_SLACK_USER_SCOPES: ReadonlyArray<string> = [
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "canvases:read",
  "canvases:write",
] as const;

/**
 * Bot events the App subscribes to via Event Subscriptions. Set in the
 * manifest's settings.event_subscriptions.bot_events. Covers @-mentions,
 * messages in all conversation kinds, the AI assistant pane handshake, and
 * revocation signals.
 */
export const DEFAULT_SLACK_SUBSCRIBED_EVENTS: ReadonlyArray<string> = [
  "app_mention",
  "message.channels",
  "message.im",
  "message.groups",
  "message.mpim",
  "assistant_thread_started",
  "tokens_revoked",
  "app_uninstalled",
] as const;

export const ALL_SLACK_CAPABILITIES: ReadonlyArray<SlackCapabilityKey> = [
  "message.read",
  "message.write",
  "message.update",
  "message.delete",
  "thread.reply",
  "reaction.add",
  "reaction.remove",
  "user.read",
  "search.read",
  "canvas.write",
] as const;
