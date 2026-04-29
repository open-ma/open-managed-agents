// Slack-specific port extensions.
//
// Slack's install carries TWO tokens (bot xoxb- + user xoxp-) where Linear's
// carries one, plus needs two vault ids (one per token). This narrower repo
// extends InstallationRepo with the additional Slack-only methods. Linear's
// repo doesn't implement it; the SlackContainer wires its own
// SlackInstallationRepo implementation.

import type {
  InstallationRepo,
  SessionScopeRepo,
} from "@open-managed-agents/integrations-core";

export interface SlackInstallationRepo extends InstallationRepo {
  /**
   * Returns the decrypted user (`xoxp-`) token for an installation, or null
   * if the installation is revoked or the token wasn't stored. Required for
   * `mcp.slack.com/mcp` outbound auth — the bot token (`xoxb-`) is rejected
   * by Slack's hosted MCP server.
   */
  getUserToken(id: string): Promise<string | null>;

  /** Persist the encrypted user (xoxp-) token after OAuth completion. */
  setUserToken(id: string, userToken: string): Promise<void>;

  /** Set the secondary vault id holding the bot xoxb- token. */
  setBotVaultId(id: string, botVaultId: string): Promise<void>;

  /** Returns the bot xoxb- vault id for outbound injection on slack.com/api. */
  getBotVaultId(id: string): Promise<string | null>;
}

/**
 * Slack-specific session scope methods on top of the generic SessionScopeRepo.
 * These exist for `per_channel` granularity — debounced channel-scope scan
 * dispatch + cached channel display name. Linear/GitHub providers don't need
 * these and Linear's IssueSessionRepo is a separate type entirely.
 */
export interface SlackSessionScopeRepo extends SessionScopeRepo {
  /**
   * Atomically check-and-set the debounce watermark on a channel scope row.
   *
   * - If the row's `pending_scan_until` is NULL or `<= now`: UPDATE to `until`
   *   and return `{ armed: true, currentUntil: null }`. The caller should
   *   dispatch a `[signal:channel_scan_armed]` event to the agent.
   * - Otherwise: return `{ armed: false, currentUntil: existingValue }`. The
   *   caller should drop this event silently (a scan is already armed).
   *
   * Concurrent callers are serialized by D1's row-level locking — one wins,
   * the other reads the winner's value and gets `armed: false`.
   *
   * No-op (returns `{ armed: false, currentUntil: null }`) when the
   * (publication_id, scope_key) row doesn't yet exist; callers should ensure
   * the channel session row exists before arming.
   */
  armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }>;

  /** Clear the debounce watermark — no-op if not currently armed. */
  clearPendingScan(publicationId: string, scopeKey: string): Promise<void>;

  /** Update the cached channel display name on a channel-scope row. */
  updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void>;

  /**
   * Mark every active scope row for a publication as completed and clear any
   * pending scan watermark. Called from the `tokens_revoked` / `app_uninstalled`
   * lifecycle path when the whole installation is gone — without this, stale
   * `active` rows linger and any agent scheduleWakeups would burn turns
   * 401-ing against a revoked token.
   */
  closeAllForPublication(publicationId: string): Promise<void>;
}
