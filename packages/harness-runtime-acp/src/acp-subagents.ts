import type { ToolEntry } from "@openma/common/session-events/acp";

/** Internal decoding result; persisted output remains the native thread events. */
export interface ChildActivity {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled" | "closed";
  parentToolId?: string;
  parentThreadId?: string;
  name?: string;
  error?: string;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/** Lift the provider metadata already understood by OpenMA's ACP views. Tool
 * names alone are insufficient evidence for Codex collaboration lifecycle. */
export function decodeChildActivities(value: unknown, tool?: ToolEntry): ChildActivity[] {
  const envelope = object(value);
  const data = object(envelope.data);
  if (envelope.schema_version === "oma.event.v1" && data.kind === "agent") {
    const id = string(envelope.work_item_id);
    const statuses: Record<string, ChildActivity["status"]> = {
      "work_item.started": "running", "work_item.completed": "completed",
      "work_item.failed": "failed", "work_item.cancelled": "cancelled",
      "work_item.killed": "closed", "work_item.terminated": "closed",
    };
    const status = statuses[String(envelope.type)];
    return id && status ? [{ id, status, name: string(data.title), parentToolId: string(envelope.parent_id), parentThreadId: string(envelope.session_thread_id), error: string(data.error) ?? string(data.reason) }] : [];
  }
  if (!tool) return [];
  const meta = object(tool.meta);
  const codex = object(meta.codex);
  const subagent = object(codex.subagent);
  const id = string(subagent.threadId);
  if (id && ["started", "interacted", "interrupted"].includes(String(subagent.activity))) {
    return [{ id, status: subagent.activity === "interrupted" ? "cancelled" : "running", parentToolId: tool.toolCallId, name: string(subagent.path)?.split("/").filter(Boolean).at(-1) }];
  }
  const collaboration = object(codex.collaboration);
  const input = object(tool.rawInput);
  const output = object(tool.rawOutput);
  const targets = collaboration.receiverThreadIds ?? input.receiverThreadIds ?? input.receiver_thread_ids;
  const ids = Array.isArray(targets) ? targets.filter((id): id is string => typeof id === "string") : [];
  const operation = string(collaboration.tool);
  if (operation && ids.length > 0) {
    const states = object(input.agentsStates ?? input.agents_states ?? output.status);
    return ids.flatMap<ChildActivity>(id => {
      const state = object(states[id]);
      const status = state.status;
      if (operation === "closeAgent") return tool.status === "completed" ? [{ id, status: "closed" }] : [];
      if (operation === "spawnAgent" || operation === "sendInput" || operation === "resumeAgent") {
        if (tool.status === "failed") return [];
        return [{ id, status: "running", ...(operation === "spawnAgent" ? { parentToolId: tool.toolCallId, name: string(input.agentType ?? input.agent_type) } : {}) }];
      }
      if (operation !== "wait") return [];
      if (status === "completed" || state.completed !== undefined) return [{ id, status: "completed" }];
      if (status === "errored" || status === "failed" || state.failed !== undefined || state.error !== undefined) return [{ id, status: "failed", error: string(state.message ?? state.error ?? state.failed) }];
      if (status === "interrupted" || status === "cancelled" || state.cancelled === true) return [{ id, status: "cancelled" }];
      if (status === "running") return [{ id, status: "running" }];
      return [];
    });
  }
  const name = tool.toolName?.toLowerCase();
  if (name !== "task" && name !== "agent") return [];
  return [{ id: `acp:claude:${tool.toolCallId}`, parentToolId: tool.toolCallId,
    name: string(input.subagent_type) ?? string(input.description) ?? tool.title,
    status: tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : tool.status === "cancelled" ? "cancelled" : "running",
    error: tool.status === "failed" ? string(tool.rawOutput) : undefined,
  }];
}
