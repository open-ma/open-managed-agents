// Routing: given a normalized webhook event and the publications under one
// installation, decide which publication should handle it.
//
// B+ precedence (highest first):
//   1. Explicit slash command in the comment body (e.g. "/coder ...")
//   2. Issue label matching `agent:<name>` for an active publication
//   3. Workspace's default-agent publication
//   4. None — drop the event (recorded but no session created)
//
// A1 mode skips routing entirely: the webhook arrives at a per-app endpoint
// so the publication is implicit.

import type { Publication } from "@open-managed-agents/integrations-core";
import type { NormalizedWebhookEvent } from "./parse";

export interface RoutingDecision {
  publication: Publication | null;
  reason:
    | "slash_command"
    | "agent_label"
    | "default_agent"
    | "no_match"
    | "unsupported_event";
}

export function routeForSharedInstall(
  event: NormalizedWebhookEvent,
  publications: ReadonlyArray<Publication>,
  defaultAgent: Publication | null,
): RoutingDecision {
  if (!event.kind) {
    return { publication: null, reason: "unsupported_event" };
  }

  const live = publications.filter((p) => p.status === "live");

  // 1. Slash command in comment body.
  const slashMatch = matchSlashCommand(event.commentBody, live);
  if (slashMatch) return { publication: slashMatch, reason: "slash_command" };

  // 2. agent:<name> label on the issue.
  const labelMatch = matchAgentLabel(event.labels, live);
  if (labelMatch) return { publication: labelMatch, reason: "agent_label" };

  // 3. Default agent fallback.
  if (defaultAgent && defaultAgent.status === "live") {
    return { publication: defaultAgent, reason: "default_agent" };
  }

  return { publication: null, reason: "no_match" };
}

function matchSlashCommand(
  body: string | null,
  publications: ReadonlyArray<Publication>,
): Publication | null {
  if (!body) return null;
  // Match "/<token>" appearing as a standalone word at any position. We don't
  // require it to be the first thing in the comment (users mix prose and
  // commands), but we do require a slash and a non-empty token.
  const candidates = publications.filter((p) => p.slashCommand);
  for (const pub of candidates) {
    const cmd = pub.slashCommand!.replace(/^\/+/, "");
    // Word boundary so /coder doesn't match /coder-bot.
    const re = new RegExp(`(^|\\s)/${escapeRegex(cmd)}(\\s|$|[.,;!?])`, "i");
    if (re.test(body)) return pub;
  }
  return null;
}

function matchAgentLabel(
  labels: ReadonlyArray<string>,
  publications: ReadonlyArray<Publication>,
): Publication | null {
  if (labels.length === 0) return null;
  // Build "agent:<persona slug>" → publication once.
  const byLabel = new Map<string, Publication>();
  for (const pub of publications) {
    if (pub.slashCommand) {
      // Reuse slashCommand as the routing key (already slugified).
      const cmd = pub.slashCommand.replace(/^\/+/, "");
      byLabel.set(`agent:${cmd}`, pub);
    }
  }
  for (const label of labels) {
    const hit = byLabel.get(label.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
