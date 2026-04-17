import type { ModelMessage, ToolModelMessage, AssistantModelMessage } from "ai";
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
 * Convert an array of SessionEvents into AI SDK ModelMessage[] format.
 * Shared by SqliteHistory and InMemoryHistory to avoid duplication.
 * Groups tool_use + tool_result into proper assistant/tool message pairs.
 */
export function eventsToMessages(events: SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  let pendingToolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }> = [];
  let pendingToolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  }> = [];

  const flushTools = () => {
    if (pendingToolCalls.length > 0) {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: pendingToolCalls,
      };
      const toolMsg: ToolModelMessage = {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: e.content.map((b): any => {
            if (b.type === "text") {
              return { type: "text" as const, text: b.text };
            }
            if (b.type === "image") {
              if (b.source.type === "url" && b.source.url) {
                return { type: "image" as const, image: new URL(b.source.url) };
              }
              // base64 or file reference
              return {
                type: "image" as const,
                image: b.source.data || "",
                mimeType: b.source.media_type,
              };
            }
            if (b.type === "document") {
              // ai-sdk uses "file" type for documents
              if (b.source.type === "url" && b.source.url) {
                return {
                  type: "file" as const,
                  data: new URL(b.source.url),
                  mimeType: b.source.media_type,
                };
              }
              if (b.source.type === "text") {
                // Plain text document — send as text with context
                const prefix = b.title ? `[${b.title}]\n` : "";
                return { type: "text" as const, text: prefix + (b.source.data || "") };
              }
              return {
                type: "file" as const,
                data: b.source.data || "",
                mimeType: b.source.media_type || "application/pdf",
              };
            }
            // fallback
            return { type: "text" as const, text: JSON.stringify(b) };
          }),
        });
        break;
      }
      case "agent.message": {
        flushTools();
        const e = event as AgentMessageEvent;
        messages.push({
          role: "assistant",
          content: e.content.map((b) => ({ type: "text" as const, text: b.type === "text" ? b.text : "" })),
        });
        break;
      }
      case "agent.tool_use": {
        const e = event as AgentToolUseEvent;
        pendingToolCalls.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName: e.name,
          input: e.input,
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
          input: e.input,
        });
        break;
      }
      case "agent.tool_result": {
        const e = event as AgentToolResultEvent;
        // Find matching tool call to get toolName
        const matchingCall = pendingToolCalls.find(
          (c) => c.toolCallId === e.tool_use_id
        );
        // content may be string OR ContentBlock[] (multimodal). Convert to AI SDK
        // ToolResultOutput shape accordingly.
        let output: { type: "text"; value: string } | { type: "content"; value: Array<{ type: "text"; text: string } | { type: "media" | "file-data"; data: string; mediaType: string }> };
        if (typeof e.content === "string") {
          output = { type: "text", value: e.content };
        } else if (Array.isArray(e.content)) {
          // Translate Anthropic-shape ContentBlock[] → AI SDK content parts
          const parts = e.content.map((b) => {
            if (b.type === "text") return { type: "text" as const, text: b.text };
            if (b.type === "image" && b.source.type === "base64") {
              return { type: "file-data" as const, data: b.source.data || "", mediaType: b.source.media_type || "image/png" };
            }
            if (b.type === "document" && b.source.type === "base64") {
              return { type: "file-data" as const, data: b.source.data || "", mediaType: b.source.media_type || "application/pdf" };
            }
            return { type: "text" as const, text: JSON.stringify(b) };
          });
          output = { type: "content", value: parts };
        } else {
          output = { type: "text", value: JSON.stringify(e.content) };
        }
        pendingToolResults.push({
          type: "tool-result",
          toolCallId: e.tool_use_id,
          toolName: matchingCall?.toolName ?? "unknown",
          // @ts-expect-error AI SDK ToolResultPart.output union doesn't expose 'content' in our generated types,
          // but the provider does accept it. See ToolResultOutput in @ai-sdk/provider-utils.
          output,
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
          output: { type: "text", value: e.content },
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

  getMessages(): ModelMessage[] {
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

  getMessages(): ModelMessage[] {
    return eventsToMessages(this.events);
  }
}
