// Built-in registry of "appendable prompts" — small, named blocks of text
// the platform exposes for agent authors to opt into. They append to the
// system prompt at session start, after `agent.system` and before memory /
// skill additions.
//
// Why this exists: provider-specific syntax (e.g. Linear's @-mention URL
// form) doesn't belong in the agent's generic `system` field — agents are
// reused across providers — but also shouldn't be silently injected by the
// provider on every session, because the agent author may not want it.
// This registry is the middle ground: the platform ships the text, the
// agent config opts in by id.
//
// To add a new entry: append to the registry below. Keep entries short and
// self-contained; they are concatenated verbatim.

export interface AppendablePrompt {
  id: string;
  name: string;
  description: string;
  content: string;
}

const REGISTRY: Record<string, AppendablePrompt> = {
  "linear-mcp": {
    id: "linear-mcp",
    name: "Linear MCP usage",
    description:
      "Teach the agent how to speak in Linear panels and threads via the OMA-hosted Linear MCP tools (linear_say, linear_post_comment, linear_get_issue).",
    content: `Linear: nothing is auto-mirrored. To produce any panel-visible output you MUST call \`linear_say(body, panelId, kind)\` — kind=thought for narration, kind=action for tool-call cards, kind=elicitation to ask the panel creator a question (renders an inline reply box), kind=response to finalize the panel (use sparingly — Linear marks the panel \`complete\` and won't render further activity). The panel id (\`ag_xxx\`) is named in each user message that wakes you. Outside a panel, use \`linear_post_comment(body, parentId?, issueId?)\` to post a thread or top-level comment. Read more context with \`linear_get_issue(issueId?, parentCommentId?)\`. To @-mention a Linear user inside any body, write plain \`@<displayName>\` (e.g. \`@hrhrngxy\`) — Linear server-side parses this into a real mention chip and sends a notification.`,
  },
};

export function resolveAppendablePrompts(ids: readonly string[]): AppendablePrompt[] {
  const seen = new Set<string>();
  const out: AppendablePrompt[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = REGISTRY[id];
    if (entry) out.push(entry);
  }
  return out;
}

export function listAppendablePrompts(): AppendablePrompt[] {
  return Object.values(REGISTRY);
}
