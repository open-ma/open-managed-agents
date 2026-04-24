// Slack-specific port extensions.
//
// Slack's install carries TWO tokens (bot xoxb- + user xoxp-) where Linear's
// carries one, plus needs two vault ids (one per token). This narrower repo
// extends InstallationRepo with the additional Slack-only methods. Linear's
// repo doesn't implement it; the SlackContainer wires its own
// SlackInstallationRepo implementation.

import type { InstallationRepo } from "@open-managed-agents/integrations-core";

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
