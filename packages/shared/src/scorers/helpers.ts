// Internal helpers for scorers — extract structured data from a Trajectory's
// raw event stream. Keeps individual scorer files small.

import type { StoredEvent } from "../types.js";
import type { Trajectory } from "../trajectory/types.js";

function parseData<T = Record<string, unknown>>(e: StoredEvent): T | null {
  if (typeof e.data === "string") {
    try {
      return JSON.parse(e.data) as T;
    } catch {
      return null;
    }
  }
  return (e.data as T) ?? null;
}

export interface ToolUseEvent {
  seq: number;
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  seq: number;
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export function getToolUses(trajectory: Trajectory): ToolUseEvent[] {
  const result: ToolUseEvent[] = [];
  for (const e of trajectory.events) {
    if (
      e.type === "agent.tool_use" ||
      e.type === "agent.custom_tool_use" ||
      e.type === "agent.mcp_tool_use"
    ) {
      const data = parseData(e);
      if (!data) continue;
      result.push({
        seq: e.seq,
        id: data.id as string | undefined,
        name: (data.name as string) || "",
        input: (data.input as Record<string, unknown>) || {},
      });
    }
  }
  return result;
}

export function getToolResults(trajectory: Trajectory): ToolResultEvent[] {
  const result: ToolResultEvent[] = [];
  for (const e of trajectory.events) {
    if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
      const data = parseData(e);
      if (!data) continue;
      const content = data.content;
      const contentStr =
        typeof content === "string" ? content : JSON.stringify(content ?? "");
      result.push({
        seq: e.seq,
        tool_use_id:
          (data.tool_use_id as string) || (data.mcp_tool_use_id as string) || "",
        content: contentStr,
        is_error: data.is_error as boolean | undefined,
      });
    }
  }
  return result;
}

export function getToolResultFor(
  trajectory: Trajectory,
  toolUseId: string,
): ToolResultEvent | undefined {
  return getToolResults(trajectory).find((r) => r.tool_use_id === toolUseId);
}

export function getAgentMessageTexts(trajectory: Trajectory): string[] {
  const out: string[] = [];
  for (const e of trajectory.events) {
    if (e.type !== "agent.message") continue;
    const data = parseData(e);
    if (!data) continue;
    const content = data.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          out.push((block as { text?: string }).text || "");
        }
      }
    }
  }
  return out;
}

export function getUserMessageTexts(trajectory: Trajectory): string[] {
  const out: string[] = [];
  for (const e of trajectory.events) {
    if (e.type !== "user.message") continue;
    const data = parseData(e);
    if (!data) continue;
    const content = data.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          out.push((block as { text?: string }).text || "");
        }
      }
    }
  }
  return out;
}

/** Concatenate all natural-language text the agent produced + all tool results. */
export function collectAllText(trajectory: Trajectory): string {
  const parts: string[] = [];
  for (const t of getAgentMessageTexts(trajectory)) parts.push(t);
  for (const r of getToolResults(trajectory)) parts.push(r.content);
  return parts.join("\n");
}

export function hasSessionError(trajectory: Trajectory): boolean {
  return trajectory.events.some((e) => e.type === "session.error");
}

export function reachedIdle(trajectory: Trajectory): boolean {
  return trajectory.events.some((e) => e.type === "session.status_idle");
}
