// @ts-nocheck
import { describe, it, expect } from "vitest";
import { recoverInterruptedState } from "../../apps/agent/src/runtime/recovery";
import { InMemoryEventLog, InMemoryStreamRepo } from "@open-managed-agents/event-log/memory";
import type { SessionEvent } from "@open-managed-agents/shared";

// ============================================================
// recoverInterruptedState — durability invariants
// ============================================================
//
// The recovery scan runs once per SessionDO cold start. It guards the
// invariants that make event-log replay survive a runtime crash:
//
//   1. Every `agent.message_stream_start` reaches a terminal state in
//      the streams table (completed | aborted | interrupted). A
//      streaming row left dangling would replay to the next harness
//      turn as a hole in conversation history.
//
//   2. Every `agent.tool_use` has a matching `agent.tool_result`. The
//      Anthropic API rejects a turn with an unresolved tool_use.
//
// Tests exercise the pure function with InMemory adapters — no
// SessionDO, no workerd, no LLM. SessionDO is just a thin wrapper that
// glues the broadcast and DO storage to this same logic (see
// session-do.ts: recoverInterruptedState).

describe("recoverInterruptedState — stream finalization", () => {
  it("turns dangling streaming rows into agent.message + interrupted", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);

    // Two sessions died mid-stream — one with chunks buffered, one bare.
    await streams.start("msg_a", Date.now());
    await streams.appendChunk("msg_a", "Hello, ");
    await streams.appendChunk("msg_a", "world!");
    await streams.start("msg_b", Date.now());

    const report = await recoverInterruptedState(streams, history);

    expect(report.finalizedStreams.sort()).toEqual(["msg_a", "msg_b"]);

    const events = history.getEvents();
    const messages = events.filter((e: any) => e.type === "agent.message");
    expect(messages).toHaveLength(2);

    const a = messages.find((m: any) => m.message_id === "msg_a");
    expect(a.content[0].text).toBe("Hello, world!");

    const b = messages.find((m: any) => m.message_id === "msg_b");
    expect(b.content[0].text).toMatch(/interrupted/);

    // Streams left in terminal 'interrupted' state.
    expect((await streams.get("msg_a"))?.status).toBe("interrupted");
    expect((await streams.get("msg_b"))?.status).toBe("interrupted");

    // Warnings carry the message_id so subscribers can deduplicate.
    expect(report.warnings.filter((w) => w.source === "stream_interrupted")).toHaveLength(2);
  });

  it("ignores already-terminal stream rows (idempotent on re-scan)", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);

    await streams.start("msg_done", Date.now());
    await streams.appendChunk("msg_done", "ok");
    await streams.finalize("msg_done", "completed");

    const report = await recoverInterruptedState(streams, history);

    expect(report.finalizedStreams).toEqual([]);
    expect(history.getEvents()).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("recoverInterruptedState — tool_use orphans", () => {
  it("injects agent.tool_result for orphaned built-in tool_use", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);
    history.append({ type: "user.message", content: [{ type: "text", text: "list files" }] } as SessionEvent);
    history.append({ type: "agent.tool_use", id: "tu_bash_1", name: "bash", input: { command: "ls" } } as SessionEvent);
    // No matching agent.tool_result — runtime died before tool returned.

    const report = await recoverInterruptedState(streams, history);

    expect(report.injectedToolResults).toEqual(["tu_bash_1"]);

    const results = history.getEvents().filter((e: any) => e.type === "agent.tool_result");
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe("tu_bash_1");
    expect(results[0].content).toMatch(/interrupted by maintenance restart/);

    expect(report.warnings.find((w) => w.source === "tool_call_interrupted")).toMatchObject({
      details: { tool_use_id: "tu_bash_1", tool_name: "bash" },
    });
  });

  it("injects agent.mcp_tool_result with is_error=true for MCP orphans", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);
    history.append({ type: "agent.mcp_tool_use", id: "mtu_1", name: "search", server_label: "linear" } as SessionEvent);

    const report = await recoverInterruptedState(streams, history);

    expect(report.injectedMcpToolResults).toEqual(["mtu_1"]);
    const results = history.getEvents().filter((e: any) => e.type === "agent.mcp_tool_result");
    expect(results[0].mcp_tool_use_id).toBe("mtu_1");
    expect(results[0].is_error).toBe(true);
  });

  it("warns but does not auto-resolve custom_tool_use orphans", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);
    history.append({ type: "agent.custom_tool_use", id: "ctu_1", name: "user_confirm" } as SessionEvent);

    const report = await recoverInterruptedState(streams, history);

    expect(report.pendingCustomToolUses).toEqual(["ctu_1"]);
    // No fabricated user.custom_tool_result — that input is user-driven.
    expect(history.getEvents().filter((e: any) => e.type === "user.custom_tool_result")).toEqual([]);
    expect(report.warnings.find((w) => w.source === "custom_tool_call_interrupted")).toMatchObject({
      details: { tool_use_id: "ctu_1", tool_name: "user_confirm" },
    });
  });

  it("leaves resolved tool_use rows alone", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);
    history.append({ type: "agent.tool_use", id: "tu_ok", name: "bash" } as SessionEvent);
    history.append({ type: "agent.tool_result", tool_use_id: "tu_ok", content: "fine" } as SessionEvent);
    history.append({ type: "agent.mcp_tool_use", id: "mtu_ok", name: "x", server_label: "y" } as SessionEvent);
    history.append({ type: "agent.mcp_tool_result", mcp_tool_use_id: "mtu_ok", content: "fine" } as SessionEvent);
    history.append({ type: "agent.custom_tool_use", id: "ctu_ok", name: "ask" } as SessionEvent);
    history.append({ type: "user.custom_tool_result", id: "ctu_ok", content: "yes" } as SessionEvent);

    const report = await recoverInterruptedState(streams, history);

    expect(report.injectedToolResults).toEqual([]);
    expect(report.injectedMcpToolResults).toEqual([]);
    expect(report.pendingCustomToolUses).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("recoverInterruptedState — combined", () => {
  it("handles streams + tool_use orphans in the same scan", async () => {
    const streams = new InMemoryStreamRepo();
    const history = new InMemoryEventLog((e) => e);

    await streams.start("msg_x", Date.now());
    await streams.appendChunk("msg_x", "partial response cut off");

    history.append({ type: "user.message", content: [{ type: "text", text: "do stuff" }] } as SessionEvent);
    history.append({ type: "agent.tool_use", id: "tu_x", name: "bash" } as SessionEvent);

    const report = await recoverInterruptedState(streams, history);

    expect(report.finalizedStreams).toEqual(["msg_x"]);
    expect(report.injectedToolResults).toEqual(["tu_x"]);
    expect(report.warnings).toHaveLength(2); // one stream + one tool_call

    // Resulting event log: original 2 + agent.message + agent.tool_result = 4
    const events = history.getEvents();
    expect(events).toHaveLength(4);
    expect(events.find((e: any) => e.type === "agent.message")?.message_id).toBe("msg_x");
    expect(events.find((e: any) => e.type === "agent.tool_result")?.tool_use_id).toBe("tu_x");
  });
});
