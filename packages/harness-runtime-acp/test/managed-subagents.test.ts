import type { SessionHostEvent } from "@openma/common/session-kernel";
import { describe, expect, it } from "vitest";
import { ManagedAcpEventProjector } from "../src/managed-event-projector";

function fixture() {
  let id = 0;
  const projector = new ManagedAcpEventProjector({ nextEventId: () => `event_${++id}`, now: () => new Date("2026-09-11T00:00:00Z") });
  return {
    projector,
    send: (event: unknown) => projector.project({ type: "session.event", sessionId: "session_1", turnId: "turn_1", event }),
    complete: () => projector.project({ type: "session.complete", sessionId: "session_1", turnId: "turn_1" } as SessionHostEvent),
  };
}

function canonical(type: string, fields: Record<string, unknown> = {}) {
  return { schema_version: "oma.event.v1", event_id: `source_${type}`, type, session_id: "session_1", occurred_at: "2026-09-11T00:00:00Z", source: { kind: "harness", adapter: "codex" }, work_item_id: "child_1", parent_id: "spawn_1", data: { kind: "agent", title: "Research" }, ...fields };
}

describe("managed ACP subagent projection", () => {
  it("keeps canonical child text and nested tools out of the parent transcript", () => {
    const f = fixture();
    const opened = f.send(canonical("work_item.started"));
    expect(opened).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.thread_created", session_thread_id: "child_1", parent_tool_use_id: "spawn_1", agent_name: "Research" }),
      expect.objectContaining({ type: "session.thread_status_running", session_thread_id: "child_1" }),
    ]));
    f.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Parent" } });
    f.send(canonical("agent.message_chunk", { session_thread_id: "child_1", data: { text: "Child" } }));
    const tool = f.send({ sessionUpdate: "tool_call", toolCallId: "read_1", title: "Read", rawInput: { path: "a" }, _meta: { claudeCode: { parentToolUseId: "spawn_1" } } });
    expect(tool).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.message", session_thread_id: "child_1", content: [{ type: "text", text: "Child" }] })]));
    const result = f.send({ sessionUpdate: "tool_call_update", toolCallId: "read_1", status: "completed", rawOutput: "file" });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.tool_use", id: "read_1", session_thread_id: "child_1" }),
      expect.objectContaining({ type: "agent.tool_result", tool_use_id: "read_1", session_thread_id: "child_1" }),
    ]));
    const completed = f.send(canonical("work_item.completed"));
    expect(completed).toEqual([expect.objectContaining({ type: "session.thread_status_idle", session_thread_id: "child_1", stop_reason: { type: "end_turn" } })]);
    const parent = f.complete();
    expect(parent.find(event => event.type === "agent.message")).toMatchObject({ content: [{ type: "text", text: "Parent" }] });
    expect(parent.filter(event => event.type.startsWith("session.thread"))).toEqual([]);
  });

  it("uses the existing Claude Task correlation and never completes a child because the parent completes", () => {
    const f = fixture();
    f.send({ sessionUpdate: "tool_call", toolCallId: "task_1", title: "Explore repository", rawInput: { prompt: "Find parser", subagent_type: "Explore" }, _meta: { claudeCode: { toolName: "Task" } } });
    f.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found it" }, _meta: { claudeCode: { parentToolUseId: "task_1" } } });
    const finished = f.complete();
    expect(finished).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.message", session_thread_id: "acp:claude:task_1", content: [{ type: "text", text: "found it" }] })]));
    expect(finished.some(event => event.type === "session.thread_status_idle" || event.type === "session.thread_status_terminated")).toBe(false);
  });

  it("maps Codex spawn, completion, cancellation and explicit close without conflating turn and agent lifecycle", () => {
    const f = fixture();
    const spawn = f.send({ sessionUpdate: "tool_call", toolCallId: "spawn_1", _meta: { codex: { subagent: { threadId: "codex_child", path: "/research", activity: "started" } } } });
    expect(spawn).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.thread_created", session_thread_id: "codex_child", agent_name: "research" })]));
    const wait = f.send({ sessionUpdate: "tool_call_update", toolCallId: "wait_1", status: "completed", rawInput: { agentsStates: { codex_child: { status: "completed", message: "done" } } }, _meta: { codex: { collaboration: { tool: "wait", receiverThreadIds: ["codex_child"] } } } });
    expect(wait).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.thread_status_idle", session_thread_id: "codex_child" })]));
    expect(wait.some(event => event.type === "session.thread_status_terminated")).toBe(false);
    const cancel = f.send(canonical("work_item.cancelled", { work_item_id: "codex_child" }));
    expect(cancel).toEqual([expect.objectContaining({ type: "session.thread_status_idle", session_thread_id: "codex_child", interrupted: true })]);
    const close = f.send({ sessionUpdate: "tool_call_update", toolCallId: "close_1", status: "completed", _meta: { codex: { collaboration: { tool: "closeAgent", receiverThreadIds: ["codex_child"] } } } });
    expect(close).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.thread_status_terminated", session_thread_id: "codex_child" })]));
  });

  it("preserves nested parent lanes and ignores non-agent work item lifecycle", () => {
    const f = fixture();
    f.send(canonical("work_item.started"));
    const nested = f.send(canonical("work_item.started", { event_id: "nested", work_item_id: "child_2", session_thread_id: "child_1", parent_id: "spawn_2" }));
    expect(nested).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.thread_created", session_thread_id: "child_2", parent_thread_id: "child_1", parent_tool_use_id: "spawn_2" })]));
    const background = f.send(canonical("work_item.completed", { work_item_id: "command_1", data: { kind: "command" } }));
    expect(background).toEqual([]);
    const failure = f.send(canonical("work_item.failed", { event_id: "failed_child", work_item_id: "child_2", data: { kind: "agent", error: "rate limited" } }));
    expect(failure).toEqual([expect.objectContaining({ type: "session.error", session_thread_id: "child_2", error: expect.objectContaining({ message: "rate limited", retry_status: "terminal" }) })]);
  });
});
