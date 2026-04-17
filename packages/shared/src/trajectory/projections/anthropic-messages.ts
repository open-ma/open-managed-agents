// Anthropic Messages projection.
//
// Converts an OMA Trajectory's event stream into a list of Anthropic-format
// messages (role + content blocks). Lossy in one direction:
//   - lifecycle events (status, errors, spans) are dropped
//   - multi-agent threads are flattened into the main thread
//   - tool_use/tool_result are paired into proper content blocks
//
// Use this to feed a trajectory into HF datasets / SWE-bench scorers / any
// community Anthropic-shaped consumer.

import type { ContentBlock, StoredEvent } from "../../types.js";
import type { Trajectory } from "../types.js";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | ContentBlock; // image / document blocks pass through unchanged

function parseEventData<T = unknown>(e: StoredEvent): T | null {
  if (typeof e.data === "string") {
    try {
      return JSON.parse(e.data) as T;
    } catch {
      return null;
    }
  }
  return (e.data as T) ?? null;
}

function flushAssistant(buffer: AnthropicContentBlock[], messages: AnthropicMessage[]): void {
  if (buffer.length === 0) return;
  messages.push({ role: "assistant", content: buffer.slice() });
  buffer.length = 0;
}

function flushUser(buffer: AnthropicContentBlock[], messages: AnthropicMessage[]): void {
  if (buffer.length === 0) return;
  messages.push({ role: "user", content: buffer.slice() });
  buffer.length = 0;
}

export function toAnthropicMessages(trajectory: Trajectory): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const assistantBuf: AnthropicContentBlock[] = [];
  const userBuf: AnthropicContentBlock[] = [];

  for (const e of trajectory.events) {
    const data = parseEventData<Record<string, unknown>>(e);
    if (!data) continue;

    switch (e.type) {
      case "user.message": {
        // Flush any pending assistant blocks before starting a user turn
        flushAssistant(assistantBuf, messages);
        const content = (data.content as ContentBlock[] | undefined) || [];
        userBuf.push(...content);
        flushUser(userBuf, messages);
        break;
      }
      case "agent.message": {
        const content = (data.content as ContentBlock[] | undefined) || [];
        assistantBuf.push(...content);
        break;
      }
      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use": {
        assistantBuf.push({
          type: "tool_use",
          id: (data.id as string) || "",
          name: (data.name as string) || "",
          input: (data.input as Record<string, unknown>) || {},
        });
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        // tool_result belongs in a USER message per Anthropic spec
        flushAssistant(assistantBuf, messages);
        const rawContent = data.content;
        const toolResultContent: string | unknown[] =
          typeof rawContent === "string"
            ? rawContent
            : Array.isArray(rawContent)
              ? (rawContent as unknown[]) // Anthropic spec accepts ContentBlock[] for tool_result content
              : JSON.stringify(rawContent ?? "");
        userBuf.push({
          type: "tool_result",
          tool_use_id: (data.tool_use_id as string) || (data.mcp_tool_use_id as string) || "",
          content: toolResultContent as string,
          is_error: data.is_error as boolean | undefined,
        });
        flushUser(userBuf, messages);
        break;
      }
      // Lifecycle / span / outcome events are intentionally dropped from this projection.
      default:
        break;
    }
  }

  // Flush any trailing assistant content
  flushAssistant(assistantBuf, messages);
  flushUser(userBuf, messages);

  return messages;
}
