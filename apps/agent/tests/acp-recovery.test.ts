import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { describe, expect, it } from "vitest";

import { buildAcpSemanticRecoveryPrompt } from "../src/harness/acp-recovery";

describe("ACP semantic recovery prompt", () => {
  it("honors the last compaction boundary and emits the current request once", () => {
    const current = user("continue", "current");
    const events: SessionEvent[] = [
      user("discarded history"),
      {
        type: "agent.thread_context_compacted",
        original_message_count: 12,
        compacted_message_count: 1,
        summary: [{ type: "text", text: "the repository was initialized" }],
      },
      {
        type: "agent.message",
        content: [{ type: "text", text: "ready for the next change" }],
      },
      current,
    ];

    const prompt = buildAcpSemanticRecoveryPrompt(events, current, {
      reason: "native-state-missing",
    });

    expect(prompt).toContain("<conversation-summary>");
    expect(prompt).toContain("the repository was initialized");
    expect(prompt).toContain("Assistant: ready for the next change");
    expect(prompt).not.toContain("discarded history");
    expect(prompt.match(/continue/g)).toHaveLength(1);
  });

  it("preserves an earlier user turn that happens to equal the current text", () => {
    const prompt = buildAcpSemanticRecoveryPrompt(
      [user("retry the build")],
      user("retry the build"),
      { reason: "native-state-missing" },
    );

    expect(prompt.match(/retry the build/g)).toHaveLength(2);
  });

  it("keeps attachment references without embedding their bytes", () => {
    const prompt = buildAcpSemanticRecoveryPrompt([
      {
        type: "user.message",
        content: [
          { type: "text", text: "inspect these" },
          { type: "image", source: { type: "file", file_id: "file_image" } },
          {
            type: "document",
            title: "spec",
            source: { type: "file", file_id: "file_spec" },
          },
        ],
      },
    ], user("continue"), { reason: "native-state-missing" });

    expect(prompt).toContain("[image: file_image]");
    expect(prompt).toContain("[document spec: file_spec]");
  });

  it("serializes completed built-in, MCP, and custom tool outcomes without inputs", () => {
    const prompt = buildAcpSemanticRecoveryPrompt([
      {
        type: "agent.tool_use",
        id: "builtin",
        name: "write",
        input: { command: "never-copy-this-input" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "builtin",
        content: [
          { type: "text", text: "wrote file" },
          { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
        ],
      },
      {
        type: "agent.mcp_tool_use",
        id: "mcp-ok",
        mcp_server_name: "github",
        name: "create_issue",
        input: { title: "never-copy-this-title" },
      },
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "mcp-ok",
        content: "issue 42 created",
      },
      {
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "missing-use",
        content: "request rejected",
        is_error: true,
      },
      {
        type: "agent.custom_tool_use",
        id: "custom",
        name: "deploy",
        input: { token: "never-copy-this-token" },
      },
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "custom",
        content: [{
          type: "document",
          source: { type: "url", url: "https://example.test/deploy.log" },
        }],
      },
      { type: "agent.message", content: [] },
      { type: "session.status_running" },
    ] as SessionEvent[], user("continue"), { reason: "native-state-missing" });

    expect(prompt).toContain("Completed tool write: wrote file");
    expect(prompt).toContain("[image: https://example.test/a.png]");
    expect(prompt).toContain("Completed tool github/create_issue: issue 42 created");
    expect(prompt).toContain("Failed tool unknown: request rejected");
    expect(prompt).toContain(
      "Completed tool deploy: [document: https://example.test/deploy.log]",
    );
    expect(prompt).not.toContain("never-copy-this");
  });

  it("marks omitted older history while preserving the latest complete lines", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      user(`history-${index}-${"x".repeat(120)}`)
    );
    events.push({
      type: "user.message",
      content: [{ type: "text", text: "" }],
    });

    const prompt = buildAcpSemanticRecoveryPrompt(
      events,
      user("next"),
      { reason: "native-state-missing", maxCharacters: 1_024 },
    );

    expect(prompt).toContain("… earlier history omitted …");
    expect(prompt).toContain("history-11-");
    expect(prompt).not.toContain("history-0-");
    expect(prompt.length).toBeLessThanOrEqual(1_024);
  });

  it("hard-bounds the complete payload even when the current request is huge", () => {
    const maxCharacters = 2_048;
    const prompt = buildAcpSemanticRecoveryPrompt([
      user(`old-${"x".repeat(8_000)}`),
    ], user(`current-${"y".repeat(8_000)}`), {
      reason: "native-state-missing",
      maxCharacters,
    });

    expect(prompt.length).toBeLessThanOrEqual(maxCharacters);
    expect(prompt).toContain("[current request truncated]");
    expect(prompt).toContain("</openma-recovery>");
  });
});

function user(text: string, id?: string): UserMessageEvent {
  return {
    ...(id ? { id } : {}),
    type: "user.message",
    content: [{ type: "text", text }],
  };
}
