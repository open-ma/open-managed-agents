// Linear panel mirror — translates SessionDO broadcastEvent stream into
// Linear AgentActivity entries so the panel UI shows live thinking / tool
// calls / final response, matching the official Linear agent UX.
//
// Stateless: caller supplies the per-turn Linear context (publicationId +
// agentSessionId) on every event. No subscription handles, no instance
// state — survives DO hibernation by construction.
//
// All Linear API access goes through the integrations gateway via service
// binding so the App OAuth token never reaches sandbox-default.

import type { Env, SessionEvent } from "@open-managed-agents/shared";

export interface LinearMirrorContext {
  publicationId: string;
  agentSessionId: string | null;
}

/** Mirror a single SessionEvent into the bound Linear AgentSession panel.
 *  Fire-and-forget — bot runtime doesn't wait on mirror writes. */
export function mirrorEventToLinearPanel(
  env: Env,
  ctx: LinearMirrorContext,
  event: SessionEvent,
): void {
  if (!ctx.agentSessionId) return;
  if (!event || typeof event !== "object" || !("type" in event)) return;
  const t = (event as { type: string }).type;

  let content: Record<string, unknown> | null = null;
  switch (t) {
    case "agent.thinking": {
      const e = event as { type: string; text?: string };
      const text = (e.text ?? "").trim();
      if (!text) return;
      content = { type: "thought", body: truncate(text, 4000) };
      break;
    }
    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      const e = event as { type: string; name?: string; input?: unknown };
      content = {
        type: "action",
        action: e.name ?? "tool",
        parameter: summarizeArgs(e.input),
      };
      break;
    }
    // tool_result + final agent.message intentionally skipped. tool_result
    // is stdout/stderr noise; bot's final answer goes through the
    // linear_reply tool which already posts a type:"response" activity.
    default:
      return;
  }
  if (!content) return;

  if (!env.INTEGRATIONS) {
    console.warn("[linear-mirror] no INTEGRATIONS service binding");
    return;
  }
  if (!env.INTEGRATIONS_INTERNAL_SECRET) {
    console.warn("[linear-mirror] no INTEGRATIONS_INTERNAL_SECRET");
    return;
  }

  env.INTEGRATIONS.fetch("https://gateway/linear/internal/agent-activity", {
    method: "POST",
    headers: {
      "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      publicationId: ctx.publicationId,
      agentSessionId: ctx.agentSessionId,
      content,
    }),
  }).catch((err) => {
    console.warn(`[linear-mirror] post failed: ${(err as Error).message}`);
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function summarizeArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input, 200);
  try {
    return truncate(JSON.stringify(input), 200);
  } catch {
    return "";
  }
}
