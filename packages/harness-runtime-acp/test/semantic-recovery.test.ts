import { describe, expect, it } from "vitest";

import {
  buildManagedEventRecoveryPrompt,
  createManagedEventSemanticRecovery,
  type ManagedRecoveryEvent,
} from "../src/semantic-recovery";

describe("Managed Events semantic recovery", () => {
  it("uses the latest compaction boundary and never replays tool inputs", async () => {
    const events: ManagedRecoveryEvent[] = [
      user("discard me"),
      {
        type: "agent.thread_context_compacted",
        original_message_count: 5,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "repository initialized" }],
      },
      {
        type: "agent.tool_use",
        id: "tool_1",
        name: "write",
        input: { token: "must-not-copy" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tool_1",
        content: "wrote README.md",
      },
      user("continue", "current"),
    ];
    const recovery = createManagedEventSemanticRecovery({
      history: { async list() { return events; } },
      maxCharacters: 2_048,
    });

    const prompt = await recovery.build({
      sessionId: "session_1",
      reason: "native-state-missing",
      currentPrompt: "continue",
    });

    expect(prompt).toContain("repository initialized");
    expect(prompt).toContain("Completed tool write: wrote README.md");
    expect(prompt).not.toContain("must-not-copy");
    expect(prompt).not.toContain("discard me");
    expect(prompt.match(/continue/g)).toHaveLength(1);
  });

  it("bounds large recovery history while retaining the current prompt", async () => {
    const recovery = createManagedEventSemanticRecovery({
      history: {
        async list() {
          return Array.from({ length: 20 }, (_, index) =>
            user(`history-${index}-${"x".repeat(200)}`));
        },
      },
      maxCharacters: 1_024,
    });

    const prompt = await recovery.build({
      sessionId: "session_1",
      reason: "native-state-missing",
      currentPrompt: `current-${"y".repeat(2_000)}`,
    });

    expect(prompt.length).toBeLessThanOrEqual(1_024);
    expect(prompt).toContain("[current request truncated]");
    expect(prompt).toContain("</openma-recovery>");
  });

  it("renders every safe event and attachment variant without tool inputs", () => {
    const events: ManagedRecoveryEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "" }] },
      {
        type: "user.message",
        content: [
          { type: "image", source: { file_id: "file_img" } },
          { type: "document", title: "spec", source: { url: "https://files/spec" } },
          { type: "image", source: {} },
        ],
      },
      { type: "agent.message", content: [{ type: "text", text: "answer" }] },
      { type: "agent.message", content: [{ type: "text", text: "" }] },
      { type: "agent.tool_use", id: "tool_known", name: "shell", input: "secret" },
      { type: "agent.custom_tool_use", id: "custom_known", name: "review", input: "secret" },
      {
        type: "agent.mcp_tool_use",
        id: "mcp_known",
        name: "fetch",
        mcp_server_name: "docs",
        input: "secret",
      },
      { type: "agent.tool_result", tool_use_id: "tool_known", content: "done" },
      {
        type: "agent.tool_result",
        tool_use_id: "missing",
        content: [{ type: "text", text: "array result" }],
      },
      { type: "agent.tool_result", tool_use_id: "missing", content: " " },
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "mcp_known",
        content: "fetched",
      },
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "missing",
        content: "failed fetch",
        is_error: true,
      },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "missing", content: "" },
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "custom_known",
        content: [{ type: "text", text: "reviewed" }],
      },
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "missing",
        content: [{ type: "text", text: "unknown custom result" }],
      },
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "missing",
        content: [{ type: "text", text: "" }],
      },
      user("repeat exactly"),
    ];

    const prompt = build(events, "repeat exactly");

    expect(prompt).toContain("User: [image: file_img]");
    expect(prompt).toContain("[document spec: https://files/spec]");
    expect(prompt).toContain("[image]");
    expect(prompt).toContain("Assistant: answer");
    expect(prompt).toContain("Completed tool shell: done");
    expect(prompt).toContain("Completed tool unknown: array result");
    expect(prompt).toContain("Completed tool docs/fetch: fetched");
    expect(prompt).toContain("Failed tool unknown: failed fetch");
    expect(prompt).toContain("Completed tool review: reviewed");
    expect(prompt).toContain("Completed tool unknown: unknown custom result");
    expect(prompt).not.toContain("secret");
    expect(prompt.match(/repeat exactly/g)).toHaveLength(1);
  });

  it("uses full history when no usable compaction summary or current-message duplicate exists", () => {
    const prompt = build([
      { type: "agent.thread_context_compacted" },
      {
        type: "agent.thread_context_compacted",
        summary: [{ type: "text", text: " " }],
      },
      user("earlier"),
    ], "different current");

    expect(prompt).toContain("User: earlier");
    expect(prompt).toContain("different current");
  });

  it("uses defaults for an empty history", async () => {
    const recovery = createManagedEventSemanticRecovery({
      history: { async list(sessionId) {
        expect(sessionId).toBe("session_empty");
        return [];
      } },
    });

    const prompt = await recovery.build({
      sessionId: "session_empty",
      reason: "native-state-missing",
      currentPrompt: "fresh request",
    });
    expect(prompt).toContain("Current request:\nfresh request");
  });

  it("identifies stale native state without changing the bounded recovery envelope", () => {
    const prompt = buildManagedEventRecoveryPrompt([], "resume safely", {
      reason: "native-state-stale",
      maxCharacters: 1_024,
    });

    expect(prompt).toContain('reason="native-state-stale"');
    expect(prompt).toContain("does not cover the latest canonical completed turn");
    expect(prompt).toContain("Current request:\nresume safely");
    expect(prompt.length).toBeLessThanOrEqual(1_024);
  });

  it("handles both partial-history truncation boundaries", () => {
    const slicedSingle = build([user(`old-${"x".repeat(3_000)}`)], "now", 1_024);
    expect(slicedSingle).toContain("…");

    const currentDominates = build(
      [user("old line")],
      `current-${"y".repeat(4_000)}`,
      1_024,
    );
    expect(currentDominates).toContain("User: old line");
    expect(currentDominates).toContain("[current request truncated]");

    const shifted = build([
      user(`first-${"a".repeat(1_000)}`),
      user(`last-${"c".repeat(670)}`),
    ], "now", 1_024);
    expect(shifted).toContain("earlier history omitted");
    expect(shifted.length).toBeLessThanOrEqual(1_024);
  });
});

function build(
  events: readonly ManagedRecoveryEvent[],
  currentPrompt: string,
  maxCharacters?: number,
): string {
  return buildManagedEventRecoveryPrompt(events, currentPrompt, {
    reason: "native-state-missing",
    ...(maxCharacters === undefined ? {} : { maxCharacters }),
  });
}

function user(text: string, id?: string): ManagedRecoveryEvent {
  return {
    ...(id === undefined ? {} : { id }),
    type: "user.message",
    content: [{ type: "text", text }],
  };
}
