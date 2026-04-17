// @ts-nocheck
import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "@open-managed-agents/shared";
import type { Trajectory } from "@open-managed-agents/shared";

function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-04-17T10:00:00Z" };
}

function trajectory(events: any[]): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "tr-1",
    session_id: "sess-1",
    agent_config: {} as any,
    environment_config: {} as any,
    model: { id: "x", provider: "" },
    started_at: "2026-04-17T10:00:00Z",
    outcome: "success",
    events,
    summary: {} as any,
  };
}

describe("toAnthropicMessages projection", () => {
  it("pairs user → assistant text turn", () => {
    const t = trajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "hello" }] }),
      ev(2, "agent.message", { content: [{ type: "text", text: "hi back" }] }),
    ]);
    const msgs = toAnthropicMessages(t);
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    ]);
  });

  it("structures tool_use into assistant content and tool_result into user content", () => {
    const t = trajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "run ls" }] }),
      ev(2, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
      ev(3, "agent.tool_result", { tool_use_id: "tu1", content: "exit=0" }),
      ev(4, "agent.message", { content: [{ type: "text", text: "done" }] }),
    ]);
    const msgs = toAnthropicMessages(t);
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: "run ls" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "exit=0", is_error: undefined }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("preserves is_error on tool_result", () => {
    const t = trajectory([
      ev(1, "user.message", { content: [] }),
      ev(2, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(3, "agent.tool_result", { tool_use_id: "tu1", content: "boom", is_error: true }),
    ]);
    const msgs = toAnthropicMessages(t);
    const result = msgs[msgs.length - 1].content[0] as any;
    expect(result.type).toBe("tool_result");
    expect(result.is_error).toBe(true);
  });

  it("drops lifecycle / span / error events", () => {
    const t = trajectory([
      ev(1, "session.status_running"),
      ev(2, "user.message", { content: [{ type: "text", text: "hi" }] }),
      ev(3, "span.model_request_start"),
      ev(4, "agent.thinking"),
      ev(5, "agent.message", { content: [{ type: "text", text: "ok" }] }),
      ev(6, "span.model_request_end"),
      ev(7, "session.status_idle"),
    ]);
    const msgs = toAnthropicMessages(t);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("handles multiple tool_use in one assistant turn", () => {
    const t = trajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "list and pwd" }] }),
      ev(2, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
      ev(3, "agent.tool_use", { id: "tu2", name: "bash", input: { command: "pwd" } }),
      ev(4, "agent.tool_result", { tool_use_id: "tu1", content: "files" }),
      ev(5, "agent.tool_result", { tool_use_id: "tu2", content: "/" }),
    ]);
    const msgs = toAnthropicMessages(t);
    // Two tool_use blocks should be in one assistant turn (flushed when first tool_result arrives)
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toHaveLength(2);
    expect((assistant?.content[0] as any).type).toBe("tool_use");
    expect((assistant?.content[1] as any).type).toBe("tool_use");
  });

  it("returns empty array for empty trajectory", () => {
    expect(toAnthropicMessages(trajectory([]))).toEqual([]);
  });

  it("handles MCP tool variants", () => {
    const t = trajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "search" }] }),
      ev(2, "agent.mcp_tool_use", { id: "m1", name: "github_search", input: { q: "x" } }),
      ev(3, "agent.mcp_tool_result", { mcp_tool_use_id: "m1", content: "result" }),
    ]);
    const msgs = toAnthropicMessages(t);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect((assistant?.content[0] as any).type).toBe("tool_use");
    expect((assistant?.content[0] as any).id).toBe("m1");
    const userResult = msgs[msgs.length - 1].content[0] as any;
    expect(userResult.type).toBe("tool_result");
    expect(userResult.tool_use_id).toBe("m1");
  });
});
