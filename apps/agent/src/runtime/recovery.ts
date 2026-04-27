// Cold-start reconciliation for SessionDO. Pure function over the
// EventLog + StreamRepo ports — no DO/CF dependencies — so it can be
// driven from a unit test with InMemoryEventLog + InMemoryStreamRepo
// adapters and exercised without spinning up workerd.
//
// Two kinds of orphan state get cleaned up here:
//
//   1. Streaming `agent.message` runs that died mid-LLM. Chunks are in
//      the streams table but the final `agent.message` event never
//      landed. We append a partial `agent.message` carrying whatever
//      chunks the previous runtime had buffered (or a placeholder) and
//      finalize the streams row to "interrupted".
//
//   2. `agent.tool_use` (built-in or MCP) without a matching result
//      event. Anthropic strictly requires every tool use be followed
//      by a result; without one the next LLM call 400s. We inject a
//      placeholder `agent.tool_result` / `agent.mcp_tool_result` so the
//      bijection is intact when eventsToMessages projects the next turn.
//
// `agent.custom_tool_use` orphans are NOT auto-resolved — the
// `user.custom_tool_result` is user-driven (SDK confirms a custom
// tool's outcome) and silently completing it on the server would
// fabricate user input. We surface a warning and let the client decide.
//
// Warnings are returned (not appended to the event log) so the caller
// can broadcast them to live WS subscribers without polluting history.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { StreamRepo, EventLogRepo } from "@open-managed-agents/event-log";

export interface RecoveryWarning {
  source: "stream_interrupted" | "tool_call_interrupted" | "custom_tool_call_interrupted";
  message: string;
  details: Record<string, unknown>;
}

export interface RecoveryReport {
  /** Streams that were finalized as 'interrupted' during this scan. */
  finalizedStreams: string[];
  /** Tool-use ids that received an injected placeholder tool_result. */
  injectedToolResults: string[];
  /** Tool-use ids that received an injected placeholder mcp_tool_result. */
  injectedMcpToolResults: string[];
  /** Custom-tool-use ids surfaced as warning-only (no result injected). */
  pendingCustomToolUses: string[];
  /** Warnings to broadcast to live subscribers. */
  warnings: RecoveryWarning[];
}

export async function recoverInterruptedState(
  streams: StreamRepo,
  history: Pick<EventLogRepo, "append" | "getEvents">,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    finalizedStreams: [],
    injectedToolResults: [],
    injectedMcpToolResults: [],
    pendingCustomToolUses: [],
    warnings: [],
  };

  // 1. Streams left mid-flight by the previous runtime.
  const interrupted = await streams.listByStatus("streaming");
  for (const s of interrupted) {
    const partial = s.chunks.join("");
    history.append({
      type: "agent.message",
      message_id: s.message_id,
      content: [
        { type: "text", text: partial || "(interrupted by maintenance restart)" },
      ],
    } as SessionEvent);
    await streams.finalize(s.message_id, "interrupted");
    report.finalizedStreams.push(s.message_id);
    report.warnings.push({
      source: "stream_interrupted",
      message: "LLM stream was cut short by a server restart",
      details: { message_id: s.message_id, partial_length: partial.length },
    });
  }

  // 2. Tool-use rows with no matching result.
  const all = history.getEvents();
  const useTypes = new Map<
    string,
    { type: "agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use"; name?: string }
  >();
  const resolved = new Set<string>();
  for (const e of all) {
    const ev = e as { type: string; id?: string; name?: string; tool_use_id?: string; mcp_tool_use_id?: string };
    switch (ev.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use":
        if (ev.id) {
          useTypes.set(ev.id, {
            type: ev.type as "agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use",
            name: ev.name,
          });
        }
        break;
      case "agent.tool_result":
        if (ev.tool_use_id) resolved.add(ev.tool_use_id);
        break;
      case "agent.mcp_tool_result":
        if (ev.mcp_tool_use_id) resolved.add(ev.mcp_tool_use_id);
        break;
      case "user.custom_tool_result":
        if (ev.id) resolved.add(ev.id);
        break;
    }
  }

  for (const [useId, info] of useTypes) {
    if (resolved.has(useId)) continue;
    const placeholder = "(interrupted by maintenance restart — retry if needed)";
    if (info.type === "agent.tool_use") {
      history.append({
        type: "agent.tool_result",
        tool_use_id: useId,
        content: placeholder,
      } as SessionEvent);
      report.injectedToolResults.push(useId);
    } else if (info.type === "agent.mcp_tool_use") {
      history.append({
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: useId,
        content: placeholder,
        is_error: true,
      } as SessionEvent);
      report.injectedMcpToolResults.push(useId);
    } else {
      report.pendingCustomToolUses.push(useId);
      report.warnings.push({
        source: "custom_tool_call_interrupted",
        message: "Custom tool call was interrupted; client should resend the result",
        details: { tool_use_id: useId, tool_name: info.name },
      });
      continue;
    }
    report.warnings.push({
      source: "tool_call_interrupted",
      message: `${info.type} cut short by a server restart`,
      details: { tool_use_id: useId, tool_name: info.name },
    });
  }

  return report;
}
