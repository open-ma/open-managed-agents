import type { SessionHostEvent } from "@openma/common/session-kernel";
import { describe, expect, it } from "vitest";

import { ManagedAcpEventProjector } from "../src/managed-event-projector";

function fixtureProjector() {
  let id = 0;
  let tick = 0;
  return new ManagedAcpEventProjector({
    nextEventId: () => `event_${++id}`,
    now: () => new Date(1_788_800_000_000 + tick++),
  });
}

function stream(turnId: string, event: unknown): SessionHostEvent {
  return {
    type: "session.event",
    sessionId: "session_1",
    turnId,
    event,
  };
}

describe("ManagedAcpEventProjector", () => {
  it("projects one ACP turn into ordered, canonical and retry-stable events", () => {
    const projector = fixtureProjector();

    expect(projector.project(stream("turn_1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello " },
    }))).toEqual([
      expect.objectContaining({ type: "session.status_running", id: "event_1" }),
      expect.objectContaining({ type: "span.model_request_start", id: "event_2" }),
    ]);
    expect(projector.project(stream("turn_1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world\n" },
    }))).toEqual([]);
    expect(projector.project(stream("turn_1", {
      type: "promptComplete",
      response: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cachedReadTokens: 9,
          cachedWriteTokens: 2,
        },
      },
    }))).toEqual([
      expect.objectContaining({
        type: "agent.message",
        id: "event_3",
        message_id: "event_3",
        content: [{ type: "text", text: "hello world" }],
      }),
      expect.objectContaining({
        type: "span.model_request_end",
        id: "event_4",
        model_request_start_id: "event_2",
        is_error: false,
        model_usage: {
          input_tokens: 12,
          output_tokens: 3,
          cache_read_input_tokens: 9,
          cache_creation_input_tokens: 2,
        },
      }),
    ]);
    expect(projector.project({
      type: "session.complete",
      sessionId: "session_1",
      turnId: "turn_1",
    })).toEqual([
      expect.objectContaining({
        type: "session.status_idle",
        id: "event_5",
        stop_reason: { type: "end_turn" },
      }),
    ]);
    expect(projector.project({
      type: "session.complete",
      sessionId: "session_1",
      turnId: "turn_1",
    })).toEqual([]);
  });

  it("emits one enriched tool use before its result", () => {
    const projector = fixtureProjector();
    projector.project(stream("turn_tools", {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      kind: "execute",
      rawInput: {},
    }));
    expect(projector.project(stream("turn_tools", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      title: "bash",
      rawInput: { command: "pwd" },
      rawOutput: "ok",
      status: "completed",
    }))).toEqual([
      expect.objectContaining({
        type: "agent.tool_use",
        id: "call_1",
        name: "execute",
        input: { command: "pwd" },
      }),
      expect.objectContaining({
        type: "agent.tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "ok" }],
        is_error: false,
      }),
    ]);
  });

  it("closes open state on errors and terminates disposed sessions", () => {
    const projector = fixtureProjector();
    projector.project(stream("turn_error", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
    }));

    expect(projector.project({
      type: "session.error",
      sessionId: "session_1",
      turnId: "turn_error",
      message: "model failed",
    })).toEqual([
      expect.objectContaining({ type: "agent.thinking", id: "event_3" }),
      expect.objectContaining({
        type: "span.model_request_end",
        model_request_start_id: "event_2",
        is_error: true,
      }),
      expect.objectContaining({
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "model failed",
          retry_status: "terminal",
        },
      }),
    ]);

    expect(projector.project({
      type: "session.disposed",
      sessionId: "session_1",
    })).toEqual([
      expect.objectContaining({ type: "session.status_terminated" }),
    ]);
    expect(projector.project({
      type: "session.ready",
      sessionId: "session_1",
      acpSessionId: "acp_1",
    })).toEqual([]);
  });

  it("covers malformed chunks, thought boundaries, prompt errors, and usage defaults", () => {
    const projector = fixtureProjector();
    expect(projector.project(stream("turn_mixed", null))).toHaveLength(2);
    expect(projector.project(stream("turn_mixed", {
      sessionUpdate: "agent_thought_chunk",
      content: {},
    }))).toEqual([]);
    expect(projector.project(stream("turn_mixed", {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "still thinking" },
    }))).toEqual([]);
    expect(projector.project(stream("turn_mixed", {
      sessionUpdate: "agent_message_chunk",
      content: {},
    }))).toEqual([expect.objectContaining({ type: "agent.thinking" })]);
    expect(projector.project(stream("turn_mixed", {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "later" },
    }))).toEqual([expect.objectContaining({ type: "agent.message" })]);
    expect(projector.project(stream("turn_mixed", {
      type: "promptError",
      error: "failed",
    }))).toEqual([
      expect.objectContaining({ type: "agent.thinking" }),
      expect.objectContaining({
        type: "span.model_request_end",
        is_error: true,
        model_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);
    expect(projector.project({
      type: "session.error",
      sessionId: "session_1",
      turnId: "turn_mixed",
      message: "prompt failed",
    })).toEqual([expect.objectContaining({ type: "session.error" })]);
    expect(projector.project(stream("turn_mixed", {
      sessionUpdate: "agent_message_chunk",
      content: { text: "ignored after completion" },
    }))).toEqual([]);

    expect(projector.project({
      type: "session.error",
      sessionId: "session_1",
      message: "startup failed",
    })).toEqual([expect.objectContaining({ type: "session.error" })]);
  });

  it("deduplicates incomplete tools and projects every result representation", () => {
    const projector = fixtureProjector();
    projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call",
      kind: "ignored-without-id",
    }));
    projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call",
      toolCallId: "call_pending",
    }));
    projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pending",
      status: "pending",
    }));
    projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pending",
      status: "in_progress",
    }));
    const nullResult = projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pending",
      rawOutput: null,
      status: "failed",
    }));
    expect(nullResult).toEqual([
      expect.objectContaining({
        type: "agent.tool_use",
        name: "tool",
        input: {},
      }),
      expect.objectContaining({
        type: "agent.tool_result",
        content: [{ type: "text", text: "(status: failed)" }],
        is_error: true,
      }),
    ]);
    expect(projector.project(stream("turn_tools_extra", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pending",
      rawOutput: "duplicate",
      status: "completed",
    }))).toEqual([
      expect.objectContaining({
        type: "agent.tool_result",
        content: [{ type: "text", text: "duplicate" }],
      }),
    ]);

    projector.project(stream("turn_object_result", {
      sessionUpdate: "tool_call",
      toolCallId: "call_object",
      title: "object",
      rawInput: "not-an-object",
    }));
    expect(projector.project(stream("turn_object_result", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_object",
      rawOutput: { ok: true },
      status: "completed",
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.tool_result",
        content: [{ type: "text", text: '{"ok":true}' }],
      }),
    ]));

    projector.project(stream("turn_flush_pending", {
      sessionUpdate: "tool_call",
      toolCallId: "call_unfinished",
      title: "unfinished",
    }));
    expect(projector.project({
      type: "session.complete",
      sessionId: "session_1",
      turnId: "turn_flush_pending",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.tool_use", id: "call_unfinished" }),
    ]));

    projector.project(stream("turn_unknown_status", {
      sessionUpdate: "tool_call",
      toolCallId: "call_unknown_status",
    }));
    expect(projector.project(stream("turn_unknown_status", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_unknown_status",
      rawOutput: null,
      status: null,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.tool_result",
        content: [{ type: "text", text: "(status: unknown)" }],
      }),
    ]));
  });
});
