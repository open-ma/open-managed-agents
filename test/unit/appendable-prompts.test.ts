// Regression tests for the appendable-prompts registry.
//
// The "linear-mcp" entry is read once at session init by the agent worker
// and concatenated into the system prompt. It's plain text — TypeScript
// can't catch references to renamed/removed tools. These tests guard
// against the merged_bug_003 class of bug, where a tool refactor leaves
// behind stale prompt strings.

import { describe, it, expect } from "vitest";
import {
  listAppendablePrompts,
  resolveAppendablePrompts,
} from "../../apps/agent/src/runtime/appendable-prompts";

describe("appendable-prompts registry", () => {
  it("resolves the linear-mcp entry by id", () => {
    const out = resolveAppendablePrompts(["linear-mcp"]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("linear-mcp");
    expect(out[0].name).toBeTruthy();
    expect(out[0].content.length).toBeGreaterThan(0);
  });

  it("dedupes repeated ids and skips unknown ones", () => {
    const out = resolveAppendablePrompts([
      "linear-mcp",
      "linear-mcp",
      "no-such-prompt-id",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("linear-mcp");
  });

  it("linear-mcp content references current MCP tool surface", () => {
    const entry = listAppendablePrompts().find((p) => p.id === "linear-mcp");
    expect(entry).toBeDefined();
    const body = entry!.content;
    expect(body).toMatch(/\blinear_say\b/);
    expect(body).toMatch(/\blinear_post_comment\b/);
    expect(body).toMatch(/\blinear_get_issue\b/);
    expect(body).toMatch(/kind=elicitation/);
  });

  it("linear-mcp content does NOT mention removed tools (regression for merged_bug_003)", () => {
    const entry = listAppendablePrompts().find((p) => p.id === "linear-mcp");
    const body = entry!.content;
    expect(body).not.toMatch(/\blinear_request_input\b/);
    expect(body).not.toMatch(/\blinear_list_comments\b/);
    expect(body).not.toMatch(/\blinear_enter_panel\b/);
    expect(body).not.toMatch(/\blinear_exit_panel\b/);
  });
});
