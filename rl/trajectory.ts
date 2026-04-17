import type {
  Trajectory,
  TurnRecord,
  ToolCall,
  ToolResult,
  TokenUsage,
  RLTask,
  RewardBreakdown,
} from "./types.js";
import type { SSEEvent } from "../test/eval/types.js";

export function eventsToTrajectory(
  events: SSEEvent[],
  task: RLTask,
  sessionId: string,
  modelId: string,
  startTime: number,
): Trajectory {
  const turns: TurnRecord[] = [];
  const tokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  let pendingToolCalls: ToolCall[] = [];
  let pendingToolResults: ToolResult[] = [];
  let pendingAssistantContent = "";

  const flushAssistant = () => {
    if (pendingAssistantContent || pendingToolCalls.length > 0) {
      turns.push({
        role: "assistant",
        content: pendingAssistantContent,
        tool_calls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
        timestamp_ms: Date.now(),
      });
      pendingAssistantContent = "";
      pendingToolCalls = [];
    }
    if (pendingToolResults.length > 0) {
      turns.push({
        role: "tool",
        content: pendingToolResults.map((r) => r.content).join("\n"),
        tool_results: [...pendingToolResults],
        timestamp_ms: Date.now(),
      });
      pendingToolResults = [];
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "user.message": {
        flushAssistant();
        const content = Array.isArray(event.content)
          ? (event.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text || "")
              .join("\n")
          : String(event.content || "");
        turns.push({ role: "user", content, timestamp_ms: Date.now() });
        break;
      }
      case "agent.message": {
        const content = Array.isArray(event.content)
          ? (event.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text || "")
              .join("\n")
          : String(event.content || "");
        pendingAssistantContent += content;
        break;
      }
      case "agent.tool_use": {
        pendingToolCalls.push({
          id: event.id as string,
          name: event.name as string,
          input: (event.input as Record<string, unknown>) || {},
        });
        break;
      }
      case "agent.tool_result": {
        pendingToolResults.push({
          tool_use_id: event.tool_use_id as string,
          content: String(event.content || ""),
        });
        break;
      }
      case "agent.mcp_tool_use": {
        pendingToolCalls.push({
          id: event.id as string,
          name: `mcp_${event.mcp_server_name}_${event.name}`,
          input: (event.input as Record<string, unknown>) || {},
        });
        break;
      }
      case "agent.mcp_tool_result": {
        pendingToolResults.push({
          tool_use_id: (event as any).mcp_tool_use_id as string,
          content: String(event.content || ""),
          is_error: (event as any).is_error,
        });
        break;
      }
      case "span.model_request_end": {
        const usage = (event as any).model_usage;
        if (usage) {
          tokenUsage.input_tokens += usage.input_tokens || 0;
          tokenUsage.output_tokens += usage.output_tokens || 0;
          tokenUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
        }
        break;
      }
    }
  }

  flushAssistant();

  const hasError = events.some((e) => e.type === "session.error");
  const hasTimeout = events.some(
    (e) => e.type === "session.error" && String((e as any).error).includes("timeout"),
  );

  const numTurns = turns.filter((t) => t.role === "assistant").length;

  return {
    task_id: task.id,
    session_id: sessionId,
    turns,
    reward: { total: 0 },
    token_usage: tokenUsage,
    num_turns: numTurns,
    duration_ms: Date.now() - startTime,
    outcome: hasTimeout ? "timeout" : hasError ? "error" : "success",
    metadata: {
      model_id: modelId,
      collected_at: new Date().toISOString(),
    },
  };
}

export function trajectoryToJsonl(trajectories: Trajectory[]): string {
  return trajectories.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

export function parseTrajectoryJsonl(jsonl: string): Trajectory[] {
  return jsonl
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Trajectory);
}
