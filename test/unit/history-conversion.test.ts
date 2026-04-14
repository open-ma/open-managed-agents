// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { eventsToMessages, InMemoryHistory } from "../../apps/agent/src/runtime/history";
import type {
  SessionEvent,
  UserMessageEvent,
  AgentMessageEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
} from "@open-managed-agents/shared";

// ============================================================
// 1. eventsToMessages — basic conversions
// ============================================================
describe("eventsToMessages — basic conversions", () => {
  it("empty event array returns empty messages", () => {
    const messages = eventsToMessages([]);
    expect(messages).toEqual([]);
  });

  it("single user.message produces one user CoreMessage", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("hello");
  });

  it("single agent.message produces one assistant CoreMessage", () => {
    const events: SessionEvent[] = [
      { type: "agent.message", content: [{ type: "text", text: "hi there" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    const content = messages[0].content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("hi there");
  });

  it("alternating user/agent messages produce correct roles", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "q1" }] },
      { type: "agent.message", content: [{ type: "text", text: "a1" }] },
      { type: "user.message", content: [{ type: "text", text: "q2" }] },
      { type: "agent.message", content: [{ type: "text", text: "a2" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
  });

  it("multiple consecutive user messages produce multiple user messages", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "msg1" }] },
      { type: "user.message", content: [{ type: "text", text: "msg2" }] },
      { type: "user.message", content: [{ type: "text", text: "msg3" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m.role).toBe("user");
    }
  });

  it("multiple consecutive agent messages produce multiple assistant messages", () => {
    const events: SessionEvent[] = [
      { type: "agent.message", content: [{ type: "text", text: "r1" }] },
      { type: "agent.message", content: [{ type: "text", text: "r2" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.role).toBe("assistant");
    }
  });
});

// ============================================================
// 2. eventsToMessages — tool call chains
// ============================================================
describe("eventsToMessages — tool call chains", () => {
  it("tool call chain: user -> tool_use -> tool_result -> agent.message produces 4 messages", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "run ls" }] },
      {
        type: "agent.tool_use",
        id: "tc_1",
        name: "bash",
        input: { command: "ls" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_1",
        content: "file1.txt\nfile2.txt",
      },
      {
        type: "agent.message",
        content: [{ type: "text", text: "Here are the files." }],
      },
    ];
    const messages = eventsToMessages(events);

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");

    // Verify tool-call content
    const assistantContent = messages[1].content as any[];
    expect(assistantContent[0].type).toBe("tool-call");
    expect(assistantContent[0].toolCallId).toBe("tc_1");
    expect(assistantContent[0].toolName).toBe("bash");

    // Verify tool-result content
    const toolContent = messages[2].content as any[];
    expect(toolContent[0].type).toBe("tool-result");
    expect(toolContent[0].toolCallId).toBe("tc_1");
    expect(toolContent[0].output).toEqual({ type: "text", value: "file1.txt\nfile2.txt" });
  });

  it("multiple tool calls batched: user -> tool_use x2 -> tool_result x2 -> agent.message", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "search" }] },
      {
        type: "agent.tool_use",
        id: "tc_a",
        name: "bash",
        input: { command: "ls" },
      },
      {
        type: "agent.tool_use",
        id: "tc_b",
        name: "grep",
        input: { pattern: "TODO" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_a",
        content: "files",
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_b",
        content: "matches",
      },
      {
        type: "agent.message",
        content: [{ type: "text", text: "Done." }],
      },
    ];
    const messages = eventsToMessages(events);

    // user, assistant (2 tool-calls), tool (2 tool-results), assistant
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");

    const toolCalls = messages[1].content as any[];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("bash");
    expect(toolCalls[1].toolName).toBe("grep");

    const toolResults = messages[2].content as any[];
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].output).toEqual({ type: "text", value: "files" });
    expect(toolResults[1].output).toEqual({ type: "text", value: "matches" });
  });

  it("tool_result without matching tool_use uses toolName='unknown'", () => {
    const events: SessionEvent[] = [
      {
        type: "agent.tool_use",
        id: "tc_known",
        name: "bash",
        input: { command: "echo" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_orphan",
        content: "orphan result",
      },
    ];
    const messages = eventsToMessages(events);

    // Should still produce assistant + tool messages
    expect(messages).toHaveLength(2);
    const toolResults = messages[1].content as any[];
    const orphanResult = toolResults.find(
      (r: any) => r.toolCallId === "tc_orphan"
    );
    expect(orphanResult).toBeDefined();
    expect(orphanResult.toolName).toBe("unknown");
  });
});

// ============================================================
// 3. eventsToMessages — ignored event types
// ============================================================
describe("eventsToMessages — ignored event types", () => {
  it("session status events ignored (session.status_running, session.status_idle)", () => {
    const events: SessionEvent[] = [
      { type: "session.status_running" } as SessionEvent,
      { type: "session.status_idle" } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(0);
  });

  it("span events ignored (span.model_request_start, span.model_request_end)", () => {
    const events: SessionEvent[] = [
      { type: "span.model_request_start", model: "claude-sonnet-4-6" } as SessionEvent,
      { type: "span.model_request_end", model: "claude-sonnet-4-6", model_usage: { input_tokens: 10, output_tokens: 20 } } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(0);
  });

  it("agent.thinking event ignored", () => {
    const events: SessionEvent[] = [
      { type: "agent.thinking" } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(0);
  });

  it("mixed: user.message + session.status_running + agent.message + session.status_idle produces 2 messages", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
      { type: "session.status_running" } as SessionEvent,
      { type: "agent.message", content: [{ type: "text", text: "hello" }] },
      { type: "session.status_idle" } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("user.interrupt ignored", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "go" }] },
      { type: "user.interrupt" } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("user.tool_confirmation ignored", () => {
    const events: SessionEvent[] = [
      {
        type: "user.tool_confirmation",
        tool_use_id: "tc_1",
        result: "allow",
      } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(0);
  });

  it("user.custom_tool_result ignored", () => {
    const events: SessionEvent[] = [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "ct_1",
        content: [{ type: "text", text: "result" }],
      } as SessionEvent,
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(0);
  });

  it("content with multiple text blocks preserved", () => {
    const events: SessionEvent[] = [
      {
        type: "user.message",
        content: [
          { type: "text", text: "first block" },
          { type: "text", text: "second block" },
        ],
      },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    const content = messages[0].content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe("first block");
    expect(content[1].text).toBe("second block");
  });
});

// ============================================================
// 4. InMemoryHistory
// ============================================================
describe("InMemoryHistory", () => {
  it("getEvents with afterSeq > length returns empty", () => {
    const history = new InMemoryHistory();
    history.append({
      type: "user.message",
      content: [{ type: "text", text: "only one" }],
    });
    const events = history.getEvents(999);
    expect(events).toHaveLength(0);
  });

  it("multiple instances are isolated", () => {
    const history1 = new InMemoryHistory();
    const history2 = new InMemoryHistory();

    history1.append({
      type: "user.message",
      content: [{ type: "text", text: "history1 msg" }],
    });
    history2.append({
      type: "agent.message",
      content: [{ type: "text", text: "history2 msg" }],
    });

    expect(history1.getEvents()).toHaveLength(1);
    expect(history2.getEvents()).toHaveLength(1);
    expect((history1.getEvents()[0] as UserMessageEvent).content[0].text).toBe(
      "history1 msg"
    );
    expect(
      (history2.getEvents()[0] as AgentMessageEvent).content[0].text
    ).toBe("history2 msg");
  });

  it("getMessages with complex tool chain converts correctly", () => {
    const history = new InMemoryHistory();

    history.append({
      type: "user.message",
      content: [{ type: "text", text: "search codebase" }],
    });
    history.append({
      type: "agent.tool_use",
      id: "tc_grep",
      name: "grep",
      input: { pattern: "TODO" },
    } as AgentToolUseEvent);
    history.append({
      type: "agent.tool_result",
      tool_use_id: "tc_grep",
      content: "src/main.ts:42: // TODO: fix",
    } as AgentToolResultEvent);
    history.append({
      type: "agent.tool_use",
      id: "tc_read",
      name: "read",
      input: { path: "/src/main.ts" },
    } as AgentToolUseEvent);
    history.append({
      type: "agent.tool_result",
      tool_use_id: "tc_read",
      content: "file contents",
    } as AgentToolResultEvent);
    history.append({
      type: "agent.message",
      content: [{ type: "text", text: "Found 1 TODO." }],
    });

    const messages = history.getMessages();
    // user, assistant (2 tool-calls), tool (2 tool-results), assistant
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");

    const toolCalls = messages[1].content as any[];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("grep");
    expect(toolCalls[1].toolName).toBe("read");
  });
});
