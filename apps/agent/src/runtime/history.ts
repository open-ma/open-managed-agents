import type { CoreMessage, CoreToolMessage, CoreAssistantMessage } from "ai";
import type { HistoryStore } from "../harness/interface";
import type {
  SessionEvent,
  AgentMessageEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentMcpToolUseEvent,
  AgentMcpToolResultEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";

/**
 * Convert an array of SessionEvents into AI SDK CoreMessage[] format.
 * Shared by SqliteHistory and InMemoryHistory to avoid duplication.
 * Groups tool_use + tool_result into proper assistant/tool message pairs.
 */
export function eventsToMessages(events: SessionEvent[]): CoreMessage[] {
  const messages: CoreMessage[] = [];

  let pendingToolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }> = [];
  let pendingToolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: string;
  }> = [];

  const flushTools = () => {
    if (pendingToolCalls.length > 0) {
      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: pendingToolCalls,
      };
      const toolMsg: CoreToolMessage = {
        role: "tool",
        content: pendingToolResults,
      };
      messages.push(assistantMsg);
      messages.push(toolMsg);
      pendingToolCalls = [];
      pendingToolResults = [];
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "user.message": {
        flushTools();
        const e = event as UserMessageEvent;
        messages.push({
          role: "user",
          content: e.content.map((b) => ({ type: "text" as const, text: b.text })),
        });
        break;
      }
      case "agent.message": {
        flushTools();
        const e = event as AgentMessageEvent;
        messages.push({
          role: "assistant",
          content: e.content.map((b) => ({ type: "text" as const, text: b.text })),
        });
        break;
      }
      case "agent.tool_use": {
        const e = event as AgentToolUseEvent;
        pendingToolCalls.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName: e.name,
          args: e.input,
        });
        break;
      }
      case "agent.mcp_tool_use": {
        const e = event as AgentMcpToolUseEvent;
        // MCP tools are registered as mcp_{server}_{call|list_tools} in the tool registry
        const toolName = `mcp_${e.mcp_server_name}_call`;
        pendingToolCalls.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName,
          args: e.input,
        });
        break;
      }
      case "agent.tool_result": {
        const e = event as AgentToolResultEvent;
        // Find matching tool call to get toolName
        const matchingCall = pendingToolCalls.find(
          (c) => c.toolCallId === e.tool_use_id
        );
        pendingToolResults.push({
          type: "tool-result",
          toolCallId: e.tool_use_id,
          toolName: matchingCall?.toolName ?? "unknown",
          result: e.content,
        });
        break;
      }
      case "agent.mcp_tool_result": {
        const e = event as AgentMcpToolResultEvent;
        const matchingCall = pendingToolCalls.find(
          (c) => c.toolCallId === e.mcp_tool_use_id
        );
        pendingToolResults.push({
          type: "tool-result",
          toolCallId: e.mcp_tool_use_id,
          toolName: matchingCall?.toolName ?? "unknown",
          result: e.content,
        });
        break;
      }
      // session.status_idle, session.error — not part of messages
    }
  }

  flushTools();
  return messages;
}

/**
 * Stamp an event with id and processed_at if not already set.
 */
function stampEvent(event: SessionEvent): SessionEvent {
  if (!event.id) {
    event.id = generateEventId();
  }
  if (!event.processed_at) {
    event.processed_at = new Date().toISOString();
  }
  return event;
}

export class SqliteHistory implements HistoryStore {
  constructor(private sql: SqlStorage) {}

  append(event: SessionEvent): void {
    stampEvent(event);
    this.sql.exec(
      "INSERT INTO events (type, data) VALUES (?, ?)",
      event.type,
      JSON.stringify(event)
    );
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    let cursor;
    if (afterSeq !== undefined) {
      cursor = this.sql.exec(
        "SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq",
        afterSeq
      );
    } else {
      cursor = this.sql.exec(
        "SELECT seq, type, data, ts FROM events ORDER BY seq"
      );
    }
    const results: SessionEvent[] = [];
    for (const row of cursor) {
      results.push(JSON.parse(row.data as string) as SessionEvent);
    }
    return results;
  }

  getMessages(): CoreMessage[] {
    return eventsToMessages(this.getEvents());
  }
}

/**
 * Lightweight in-memory history for sub-agent threads.
 * No SQLite dependency — thread history lives only for the duration
 * of the sub-agent run and is discarded afterwards.
 */
export class InMemoryHistory implements HistoryStore {
  private events: SessionEvent[] = [];

  append(event: SessionEvent): void {
    stampEvent(event);
    this.events.push(event);
  }

  getEvents(afterSeq?: number): SessionEvent[] {
    return afterSeq ? this.events.slice(afterSeq) : [...this.events];
  }

  getMessages(): CoreMessage[] {
    return eventsToMessages(this.events);
  }
}
