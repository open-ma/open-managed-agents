import { describe, expect, it } from "vitest";
import { ManagedAcpEventProjector } from "../../../packages/harness-runtime-acp/src/managed-event-projector";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { applyManagedEvents, createProjectionState } from "@open-managed-agents/openai-agents-compat";
import { validateOpenAIAgentsSchema } from "@open-managed-agents/openai-agents-api";
import { sessionEventPageResponseSchema } from "../../../packages/managed-agents-api/src/contracts/session-events";
import { toSessionEventResponse } from "../../../packages/managed-agents-api/src/mappers/session-events";

describe("ACP native subagents through OpenAI projection", () => {
  it("retains root and nested child identities through native codec and strict public history", () => {
    let next = 0;
    const projector = new ManagedAcpEventProjector({ nextEventId: () => `event_${++next}`, now: () => new Date("2026-09-11T00:00:00Z") });
    const source = (event_id: string, type: string, data: unknown, extra = {}) => ({ schema_version: "oma.event.v1", event_id, type, source: { kind: "harness", adapter: "codex" }, session_id: "s", occurred_at: "2026-09-11T00:00:00Z", data, ...extra });
    const raw = [
      source("child", "work_item.started", { kind: "agent", title: "Research" }, { work_item_id: "child", parent_id: "spawn_parent" }),
      source("nested", "work_item.started", { kind: "agent", title: "Nested" }, { work_item_id: "nested", session_thread_id: "child", parent_id: "spawn_nested" }),
      source("root_text", "agent.message_chunk", { text: "Parent result" }, { session_thread_id: "root" }),
      source("child_text", "agent.message_chunk", { text: "Child result" }, { session_thread_id: "child" }),
      source("nested_text", "agent.message_chunk", { text: "Partial nested" }, { session_thread_id: "nested" }),
      source("nested_cancel", "work_item.cancelled", { kind: "agent" }, { work_item_id: "nested" }),
      source("child_done", "work_item.completed", { kind: "agent" }, { work_item_id: "child" }),
    ];
    const wire = raw.flatMap(event => projector.project({ type: "session.event", sessionId: "s", turnId: "run", event }));
    wire.push(...projector.project({ type: "session.complete", sessionId: "s", turnId: "run" }));
    const native = wire.map(event => {
      const decoded = decodeRuntimeProducedSessionEvent(event);
      expect(decoded, JSON.stringify(event)).not.toBeNull();
      return decoded!;
    });
    const history = native.map(toSessionEventResponse);
    expect(sessionEventPageResponseSchema.safeParse({ data: history, next_page: null }).success).toBe(true);
    const result = applyManagedEvents(createProjectionState({ sessionId: "s", agentId: "root_agent", createdAt: 1789084800 }), [
      { id: "initial", type: "user.message", content: [{ type: "text", text: "Delegate" }] }, ...history as Array<{ type: string }>,
    ], { observedAt: 1789084800 });
    for (const event of result.events) expect(validateOpenAIAgentsSchema(event, "agents.AgentSessionEvent"), JSON.stringify(event)).toEqual({ success: true });
    expect(result.state.subagents.child).toMatchObject({ parent_agent_id: "root_agent", status: "active" });
    expect(result.state.subagents.nested).toMatchObject({ parent_agent_id: "child", status: "active", closed_at: null });
    const turns = Object.values(result.state.turns);
    expect(turns.find(turn => turn.subagent_id === "nested")?.status).toBe("cancelled");
    expect(turns.find(turn => turn.subagent_id === "child")?.status).toBe("completed");
    const messages = Object.values(result.state.items).filter(item => item.type === "message" && item.role === "assistant");
    expect(messages).toHaveLength(3);
    expect(messages.find(item => JSON.stringify(item.content).includes("Parent result"))?.turn_id).toBe(turns.find(turn => turn.subagent_id === null)?.id);
    expect(result.state.unresolved).toEqual([]);
  });
});
