// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  includes,
  regex,
  toolUsed,
  toolNotUsed,
  toolOutcome,
  bashExit,
  bashSuccess,
  bashOutputMarker,
  fileWritten,
  idleNoError,
  agentMessageContains,
  all,
  any,
  weighted,
} from "@open-managed-agents/shared";
import type { Trajectory } from "@open-managed-agents/shared";

function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-04-17T10:00:00Z" };
}

function trajectory(events: any[]): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "tr-test",
    session_id: "sess-test",
    agent_config: {} as any,
    environment_config: {} as any,
    model: { id: "test", provider: "" },
    started_at: "2026-04-17T10:00:00Z",
    outcome: "success",
    events,
    summary: {} as any,
  };
}

// ---------- includes ----------

describe("includes scorer", () => {
  it("matches case-insensitive by default (T3.1 fix)", async () => {
    const t = trajectory([
      ev(1, "agent.message", { content: [{ type: "text", text: "Total Revenue: $6870" }] }),
    ]);
    const score = await includes("revenue")(t);
    expect(score.pass).toBe(true);
  });

  it("respects caseInsensitive: false", async () => {
    const t = trajectory([
      ev(1, "agent.message", { content: [{ type: "text", text: "Total Revenue: $6870" }] }),
    ]);
    const score = await includes("revenue", { caseInsensitive: false })(t);
    expect(score.pass).toBe(false);
  });

  it("searches both agent messages and tool results", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "ALL_TESTS_PASSED" }),
    ]);
    const score = await includes("ALL_TESTS_PASSED")(t);
    expect(score.pass).toBe(true);
  });

  it("fails cleanly when target absent", async () => {
    const t = trajectory([
      ev(1, "agent.message", { content: [{ type: "text", text: "different output" }] }),
    ]);
    const score = await includes("missing")(t);
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
  });
});

// ---------- regex ----------

describe("regex scorer", () => {
  it("matches a regex over collected text", async () => {
    const t = trajectory([
      ev(1, "agent.message", { content: [{ type: "text", text: "Order #1234 confirmed" }] }),
    ]);
    expect((await regex(/Order #\d+/)(t)).pass).toBe(true);
  });

  it("fails when no match", async () => {
    const t = trajectory([ev(1, "agent.message", { content: [{ type: "text", text: "no order" }] })]);
    expect((await regex(/Order #\d+/)(t)).pass).toBe(false);
  });
});

// ---------- toolUsed / toolNotUsed ----------

describe("toolUsed / toolNotUsed", () => {
  it("toolUsed passes when tool present", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "bash" })]);
    expect((await toolUsed("bash")(t)).pass).toBe(true);
  });

  it("toolUsed fails when tool absent", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "write" })]);
    expect((await toolUsed("bash")(t)).pass).toBe(false);
  });

  it("toolNotUsed passes when tool absent", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "write" })]);
    expect((await toolNotUsed("bash")(t)).pass).toBe(true);
  });

  it("toolNotUsed fails when tool present", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "bash" })]);
    expect((await toolNotUsed("bash")(t)).pass).toBe(false);
  });
});

// ---------- toolOutcome ----------

describe("toolOutcome", () => {
  it("invokes predicate on tool result content", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "exit=0\nfile.txt" }),
    ]);
    const score = await toolOutcome("bash", (content) => content.includes("file.txt"))(t);
    expect(score.pass).toBe(true);
  });

  it("fails when no result satisfies predicate", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash", input: {} }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "exit=1" }),
    ]);
    const score = await toolOutcome("bash", (c) => c.includes("success"))(t);
    expect(score.pass).toBe(false);
  });
});

// ---------- bashExit / bashSuccess ----------

describe("bashExit", () => {
  it("passes when last bash matches expected code", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "exit=0\nok" }),
    ]);
    expect((await bashExit(0)(t)).pass).toBe(true);
  });

  it("fails when last bash exited differently", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "exit=1\nerror" }),
    ]);
    expect((await bashExit(0)(t)).pass).toBe(false);
  });

  it("fails when no bash call at all", async () => {
    const t = trajectory([]);
    expect((await bashExit(0)(t)).pass).toBe(false);
  });
});

describe("bashSuccess", () => {
  it("passes when exit=0", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "exit=0\n" }),
    ]);
    expect((await bashSuccess()(t)).pass).toBe(true);
  });

  it("falls back to error-marker scan when exit=N missing", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "clean output" }),
    ]);
    expect((await bashSuccess()(t)).pass).toBe(true);
  });

  it("fails when error markers present without exit code", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "Traceback (most recent call last):" }),
    ]);
    expect((await bashSuccess()(t)).pass).toBe(false);
  });
});

// ---------- bashOutputMarker ----------

describe("bashOutputMarker", () => {
  it("finds marker only in bash results (not other tools)", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "bash" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "ALL_PASSED" }),
    ]);
    expect((await bashOutputMarker("ALL_PASSED")(t)).pass).toBe(true);
  });

  it("ignores marker in non-bash tool results", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { id: "tu1", name: "read" }),
      ev(2, "agent.tool_result", { tool_use_id: "tu1", content: "ALL_PASSED" }),
    ]);
    expect((await bashOutputMarker("ALL_PASSED")(t)).pass).toBe(false);
  });
});

// ---------- fileWritten ----------

describe("fileWritten", () => {
  it("matches exact file_path on write tool", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "write", input: { file_path: "/x/foo.py" } })]);
    expect((await fileWritten("/x/foo.py")(t)).pass).toBe(true);
  });

  it("fails on different path", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "write", input: { file_path: "/x/foo.py" } })]);
    expect((await fileWritten("/x/bar.py")(t)).pass).toBe(false);
  });
});

// ---------- idleNoError ----------

describe("idleNoError", () => {
  it("passes when idle and no error", async () => {
    const t = trajectory([ev(1, "session.status_idle")]);
    expect((await idleNoError()(t)).pass).toBe(true);
  });

  it("fails on session.error", async () => {
    const t = trajectory([
      ev(1, "session.status_idle"),
      ev(2, "session.error", { error: "boom" }),
    ]);
    expect((await idleNoError()(t)).pass).toBe(false);
  });

  it("fails when never idle", async () => {
    const t = trajectory([ev(1, "session.status_running")]);
    expect((await idleNoError()(t)).pass).toBe(false);
  });
});

// ---------- agentMessageContains ----------

describe("agentMessageContains", () => {
  it("case-insensitive by default", async () => {
    const t = trajectory([
      ev(1, "agent.message", { content: [{ type: "text", text: "Done!" }] }),
    ]);
    expect((await agentMessageContains("done")(t)).pass).toBe(true);
  });
});

// ---------- combinators ----------

describe("all() combinator", () => {
  it("passes when all sub-scorers pass", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { name: "bash" }),
      ev(2, "session.status_idle"),
    ]);
    const score = await all(toolUsed("bash"), idleNoError())(t);
    expect(score.pass).toBe(true);
    expect(score.value).toBe(1);
  });

  it("fails when any sub-scorer fails, includes failure list in metadata", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "bash" })]);
    const score = await all(toolUsed("bash"), toolUsed("write"))(t);
    expect(score.pass).toBe(false);
    expect(score.metadata?.failures).toBeDefined();
  });
});

describe("any() combinator", () => {
  it("passes when any sub-scorer passes", async () => {
    const t = trajectory([ev(1, "agent.tool_use", { name: "bash" })]);
    const score = await any(toolUsed("write"), toolUsed("bash"))(t);
    expect(score.pass).toBe(true);
  });

  it("fails when all sub-scorers fail", async () => {
    const t = trajectory([]);
    const score = await any(toolUsed("write"), toolUsed("bash"))(t);
    expect(score.pass).toBe(false);
  });
});

describe("weighted() combinator", () => {
  it("passes when weighted sum >= threshold", async () => {
    const t = trajectory([
      ev(1, "agent.tool_use", { name: "bash" }),
      ev(2, "session.status_idle"),
    ]);
    const score = await weighted(
      [
        { scorer: toolUsed("bash"), weight: 1 },
        { scorer: toolUsed("write"), weight: 1 }, // fails (value 0)
      ],
      0.4,
    )(t);
    // (1*1 + 1*0) / 2 = 0.5 >= 0.4
    expect(score.pass).toBe(true);
    expect(score.value).toBeCloseTo(0.5);
  });

  it("fails when weighted sum < threshold", async () => {
    const t = trajectory([]);
    const score = await weighted([{ scorer: toolUsed("bash"), weight: 1 }], 0.5)(t);
    expect(score.pass).toBe(false);
  });
});
