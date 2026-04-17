// @ts-nocheck
import { describe, it, expect } from "vitest";
import { buildTrajectory } from "@open-managed-agents/shared";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";

const baseAgent: any = {
  id: "agent-x",
  name: "test",
  model: "MiniMax-M2.7",
  system: "you are helpful",
  tools: [],
  version: 1,
  created_at: "2026-04-17T10:00:00Z",
};

const baseEnv: any = {
  id: "env-x",
  name: "test-env",
  config: { type: "cloud" },
  created_at: "2026-04-17T09:00:00Z",
};

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-001",
    agent_id: "agent-x",
    environment_id: "env-x",
    title: "test",
    status: "idle",
    created_at: "2026-04-17T10:00:00Z",
    agent_snapshot: baseAgent,
    environment_snapshot: baseEnv,
    ...overrides,
  } as SessionRecord;
}

function ev(seq: number, type: string, data: object = {}, ts = "2026-04-17T10:00:01Z") {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts };
}

describe("buildTrajectory", () => {
  it("builds happy-path envelope with summary", async () => {
    const events = [
      ev(1, "user.message", { content: [{ type: "text", text: "hi" }] }),
      ev(2, "session.status_running"),
      ev(3, "agent.tool_use", { name: "bash", input: { command: "ls" } }),
      ev(4, "agent.tool_result", { tool_use_id: "tu1", content: "exit=0" }),
      ev(5, "agent.message", { content: [{ type: "text", text: "done" }] }),
      ev(6, "session.status_idle", {}, "2026-04-17T10:00:30Z"),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async (): Promise<FullStatus> => ({
        status: "idle",
        usage: { input_tokens: 100, output_tokens: 50 },
        outcome_evaluations: [],
      }),
    });

    expect(t.schema_version).toBe("oma.trajectory.v1");
    expect(t.session_id).toBe("sess-001");
    expect(t.outcome).toBe("success");
    expect(t.events).toHaveLength(6);
    expect(t.summary.num_events).toBe(6);
    expect(t.summary.num_turns).toBe(1); // 1 agent.message
    expect(t.summary.num_tool_calls).toBe(1);
    expect(t.summary.num_tool_errors).toBe(0);
    expect(t.summary.num_threads).toBe(0);
    expect(t.summary.token_usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
    });
    expect(t.summary.duration_ms).toBe(30_000);
    expect(t.ended_at).toBe("2026-04-17T10:00:30Z");
    expect(t.trajectory_id).toMatch(/^tr-/);
    expect(t.model.id).toBe("MiniMax-M2.7");
  });

  it("derives outcome=failure on session.error", async () => {
    const events = [
      ev(1, "user.message", { content: [] }),
      ev(2, "session.error", { error: "boom" }),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => null,
    });
    expect(t.outcome).toBe("failure");
  });

  it("derives outcome=interrupted on user.interrupt", async () => {
    const events = [ev(1, "user.message"), ev(2, "user.interrupt")];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => null,
    });
    expect(t.outcome).toBe("interrupted");
  });

  it("derives outcome=running when no terminal event", async () => {
    const events = [ev(1, "user.message"), ev(2, "session.status_running")];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => ({ status: "running" }),
    });
    expect(t.outcome).toBe("running");
    expect(t.ended_at).toBeUndefined();
  });

  it("derives outcome from LAST status event, not just any (warmup bug)", async () => {
    // Simulates: warmup turn (idle) → eval turn (still running)
    const events = [
      ev(1, "user.message"),
      ev(2, "session.status_running"),
      ev(3, "agent.message"),
      ev(4, "session.status_idle"), // warmup done
      ev(5, "user.message"),
      ev(6, "session.status_running"), // eval starts
      ev(7, "agent.tool_use", { name: "bash" }),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => ({ status: "running" }),
    });
    // Last status event is status_running, NOT status_idle from warmup
    expect(t.outcome).toBe("running");
  });

  it("counts tool errors via is_error flag", async () => {
    const events = [
      ev(1, "user.message"),
      ev(2, "agent.tool_use", { name: "bash" }),
      ev(3, "agent.tool_result", { tool_use_id: "x", content: "err", is_error: true }),
      ev(4, "agent.tool_use", { name: "bash" }),
      ev(5, "agent.tool_result", { tool_use_id: "y", content: "ok" }),
      ev(6, "session.status_idle"),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => null,
    });
    expect(t.summary.num_tool_calls).toBe(2);
    expect(t.summary.num_tool_errors).toBe(1);
  });

  it("counts threads from session.thread_created", async () => {
    const events = [
      ev(1, "user.message"),
      ev(2, "session.thread_created", { session_thread_id: "thr-1" }),
      ev(3, "session.thread_created", { session_thread_id: "thr-2" }),
      ev(4, "session.thread_created", { session_thread_id: "thr-1" }), // dup
      ev(5, "session.status_idle"),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => null,
    });
    expect(t.summary.num_threads).toBe(2);
  });

  it("falls back to fetchEnvironmentConfig when snapshot missing", async () => {
    const session = makeSession({ environment_snapshot: undefined });
    const t = await buildTrajectory(session, {
      fetchAllEvents: async () => [ev(1, "session.status_idle")],
      fetchFullStatus: async () => null,
      fetchEnvironmentConfig: async () => baseEnv,
    });
    expect(t.environment_config.id).toBe("env-x");
  });

  it("throws when no env_snapshot and no fallback", async () => {
    const session = makeSession({ environment_snapshot: undefined });
    await expect(
      buildTrajectory(session, {
        fetchAllEvents: async () => [],
        fetchFullStatus: async () => null,
      })
    ).rejects.toThrow(/no environment_snapshot/);
  });

  it("throws when no agent_snapshot", async () => {
    const session = makeSession({ agent_snapshot: undefined });
    await expect(
      buildTrajectory(session, {
        fetchAllEvents: async () => [],
        fetchFullStatus: async () => null,
      })
    ).rejects.toThrow(/no agent_snapshot/);
  });

  it("supports object-shaped model in agent_snapshot", async () => {
    const session = makeSession({
      agent_snapshot: { ...baseAgent, model: { id: "claude-opus-4-7", speed: "standard" } },
    });
    const t = await buildTrajectory(session, {
      fetchAllEvents: async () => [],
      fetchFullStatus: async () => null,
    });
    expect(t.model.id).toBe("claude-opus-4-7");
  });

  it("token_usage uses max(state, span sum) — mid-flight state may lag span", async () => {
    // Simulates: 2 model_request_end spans report usage, but DO state usage
    // hasn't been incremented yet (or only partially).
    const events = [
      ev(1, "user.message"),
      ev(2, "span.model_request_end", { model_usage: { input_tokens: 100, output_tokens: 50 } }),
      ev(3, "span.model_request_end", { model_usage: { input_tokens: 200, output_tokens: 80 } }),
      ev(4, "session.status_idle"),
    ];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      // /full-status reports stale 0 because reportUsage was async + lagged
      fetchFullStatus: async () => ({ status: "idle", usage: { input_tokens: 0, output_tokens: 0 } }),
    });
    // Should fall back to span sum (300/130) instead of stale 0/0
    expect(t.summary.token_usage.input_tokens).toBe(300);
    expect(t.summary.token_usage.output_tokens).toBe(130);
  });

  it("token_usage prefers state when state > span sum (handles state-reported but no spans yet)", async () => {
    const events = [ev(1, "user.message"), ev(2, "session.status_idle")];
    const t = await buildTrajectory(makeSession(), {
      fetchAllEvents: async () => events,
      fetchFullStatus: async () => ({ status: "idle", usage: { input_tokens: 500, output_tokens: 200 } }),
    });
    expect(t.summary.token_usage.input_tokens).toBe(500);
    expect(t.summary.token_usage.output_tokens).toBe(200);
  });
});
