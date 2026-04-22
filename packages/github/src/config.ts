// GitHubProvider configuration. Cleanly separated from runtime ports so the
// provider stays pure and testable.

import type { CapabilityKey } from "@open-managed-agents/integrations-core";

export interface GitHubConfig {
  /**
   * Public origin of the integrations gateway, used to build the GitHub App
   * setup URL and webhook URL surfaced to the user. e.g.
   * "https://integrations.example.com". No trailing slash.
   */
  gatewayOrigin: string;

  /**
   * Default capability set for new publications. Per-publication overrides
   * (which may only further restrict) are stored on the Publication row.
   */
  defaultCapabilities: ReadonlyArray<CapabilityKey>;

  /**
   * GitHub MCP server URL the agent talks back through. Defaults to the
   * official GitHub Copilot-hosted MCP at https://api.githubcopilot.com/mcp/.
   * Override for self-hosted MCPs.
   */
  mcpServerUrl: string;

  /**
   * Public homepage URL embedded in manifests as the GitHub App's `url` field.
   * Shown on the App's GitHub-side page; informational only. Defaults to
   * `https://openma.dev` if not overridden.
   */
  homepageUrl?: string;
}

/**
 * Capabilities granted to a GitHub publication by default. Tilted toward
 * conservative writes — the publication owner can broaden via
 * `oma github update --caps …` if needed.
 *
 * Notably *excludes* destructive ops (`pr.merge`, `repo.branch.delete`,
 * `release.create`, `workflow.dispatch`, `issue.delete`, `comment.delete`)
 * which require explicit opt-in.
 */
export const DEFAULT_GITHUB_CAPABILITIES: ReadonlyArray<CapabilityKey> = [
  "issue.read",
  "issue.create",
  "issue.update",
  "comment.write",
  "label.add",
  "label.remove",
  "assignee.set",
  "status.set",
  "user.mention",
  "search.read",
  "pr.read",
  "pr.create",
  "pr.update",
  "pr.review.write",
  "pr.review.comment",
  "repo.read",
  "repo.write",
  "repo.branch.create",
  "workflow.read",
  "release.read",
] as const;

/** Full capability set including destructive ops — opt-in via `oma github update --caps`. */
export const ALL_GITHUB_CAPABILITIES: ReadonlyArray<CapabilityKey> = [
  ...DEFAULT_GITHUB_CAPABILITIES,
  "issue.delete",
  "comment.delete",
  "pr.merge",
  "pr.close",
  "repo.branch.delete",
  "workflow.dispatch",
  "release.create",
] as const;

/** Default GitHub-hosted MCP server URL. */
export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
