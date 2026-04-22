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
      "Point the agent at the OMA-hosted Linear MCP's linear_reply tool for all responses.",
    content: `Linear: respond via the OMA-hosted Linear MCP. Call \`mcp_linear_call\` with \`tool_name="linear_reply"\` and \`arguments='{"body":"<your reply>"}'\` — the server resolves the right target (agent-session panel response, threaded comment, or top-level comment) from the current trigger. Do NOT call save_comment / agentActivityCreate directly. To @-mention a user, write \`@<displayName>\` (e.g. \`@hrhrngxy\`) inside the body.`,
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
