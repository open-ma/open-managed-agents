import { describe, expect, it } from "vitest";
import type { SessionEventView } from "../src/index";
import { sessionEventPageResponseSchema } from "../src/contracts/session-events";
import { toSessionEventResponse } from "../src/mappers/session-events";

describe("native child event facts", () => {
  it.each([
    { type: "session.thread_created", native: { agentName: "Nested", parentThreadId: "parent", parentToolUseId: "spawn", content: [{ type: "text", text: "Research instructions" }] }, wire: { agent_name: "Nested", parent_thread_id: "parent", parent_tool_use_id: "spawn", content: [{ type: "text", text: "Research instructions" }] } },
    { type: "session.thread_status_idle", native: { agentName: "Nested", stopReason: { type: "end_turn" }, interrupted: true }, wire: { agent_name: "Nested", stop_reason: { type: "end_turn" }, interrupted: true } },
    { type: "session.error", native: { error: { type: "unknown_error", message: "child failed", retryStatus: "terminal" } }, wire: { error: { type: "unknown_error", message: "child failed", retry_status: { type: "terminal" } } } },
    { type: "agent.message", native: { content: [{ type: "text", text: "child answer" }] }, wire: { content: [{ type: "text", text: "child answer" }] } },
    { type: "agent.thinking", native: {}, wire: {} },
    { type: "span.model_request_start", native: {}, wire: {} },
    { type: "span.model_request_end", native: { isError: false, modelRequestStartId: "child_span", modelUsage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 } }, wire: { is_error: false, model_request_start_id: "child_span", model_usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } },
    { type: "agent.thread_message_received", native: { fromSessionThreadId: "parent", fromMessageId: "sent_1", content: [{ type: "text", text: "task" }] }, wire: { from_session_thread_id: "parent", from_message_id: "sent_1", content: [{ type: "text", text: "task" }] } },
    { type: "agent.thread_message_sent", native: { toSessionThreadId: "parent", content: [{ type: "text", text: "result" }] }, wire: { to_session_thread_id: "parent", content: [{ type: "text", text: "result" }] } },
    { type: "agent.tool_result", native: { toolUseId: "child_call", content: [{ type: "text", text: "done" }] }, wire: { tool_use_id: "child_call", content: [{ type: "text", text: "done" }] } },
    { type: "agent.mcp_tool_result", native: { mcpToolUseId: "child_mcp", content: [{ type: "text", text: "done" }] }, wire: { mcp_tool_use_id: "child_mcp", content: [{ type: "text", text: "done" }] } },
  ])("preserves child identity and facts for $type in strict public history", fields => {
    const wire = { id: "event_1", type: fields.type, processed_at: "2026-09-11T00:00:00Z", session_thread_id: "child", ...fields.wire };
    const response = toSessionEventResponse({ id: "event_1", type: fields.type, processedAt: "2026-09-11T00:00:00Z", sessionThreadId: "child", ...fields.native } as SessionEventView);
    expect(response).toEqual(wire);
    expect(sessionEventPageResponseSchema.safeParse({ data: [response], next_page: null }).success).toBe(true);
  });
});
