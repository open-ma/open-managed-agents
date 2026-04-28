// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import type { AgentConfig } from "@open-managed-agents/shared";

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_test",
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    system: "You are a test agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  abortSignal: undefined as any,
};

function makeScheduleEnv() {
  const scheduleWakeup = vi.fn(async (a: any) => ({
    id: `sched_${Date.now()}`,
    fire_at: new Date(Date.now() + (a.delay_seconds ?? 60) * 1000).toISOString(),
    cron: a.cron,
    kind: a.cron ? "cron" : "one_shot",
  }));
  const cancelWakeup = vi.fn(async (id: string) => ({
    cancelled: id !== "missing",
  }));
  const listWakeups = vi.fn(() => [
    {
      id: "sched_existing",
      fire_at: "2026-04-28T09:00:00.000Z",
      cron: undefined,
      prompt: "remind me",
      kind: "one_shot" as const,
    },
  ]);
  return { scheduleWakeup, cancelWakeup, listWakeups };
}

describe("schedule tool — registration", () => {
  it("not registered when env closures absent", async () => {
    const sandbox = new TestSandbox();
    const tools = await buildTools(makeAgentConfig(), sandbox);
    expect(tools.schedule).toBeUndefined();
    expect(tools.cancel_schedule).toBeUndefined();
    expect(tools.list_schedules).toBeUndefined();
  });

  it("registered by default in agent_toolset_20260401 when env closures present", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);
    expect(tools.schedule).toBeDefined();
    expect(tools.cancel_schedule).toBeDefined();
    expect(tools.list_schedules).toBeDefined();
  });

  it("explicit per-tool disable removes the tool", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(
      makeAgentConfig({
        tools: [
          {
            type: "agent_toolset_20260401",
            configs: [{ name: "schedule", enabled: false }],
          },
        ],
      }),
      sandbox,
      env,
    );
    expect(tools.schedule).toBeUndefined();
    expect(tools.cancel_schedule).toBeDefined();
    expect(tools.list_schedules).toBeDefined();
  });
});

describe("schedule tool — execution", () => {
  it("forwards delay_seconds + prompt to scheduleWakeup", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const result = await tools.schedule.execute(
      { delay_seconds: 600, prompt: "check the build" },
      TOOL_EXEC_OPTS,
    );

    expect(env.scheduleWakeup).toHaveBeenCalledOnce();
    expect(env.scheduleWakeup).toHaveBeenCalledWith({
      delay_seconds: 600,
      prompt: "check the build",
    });
    expect(result).toMatchObject({ kind: "one_shot" });
    expect(result.id).toMatch(/^sched_/);
  });

  it("forwards cron expression and returns cron kind", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const result = await tools.schedule.execute(
      { cron: "0 9 * * *", prompt: "morning standup" },
      TOOL_EXEC_OPTS,
    );

    expect(env.scheduleWakeup).toHaveBeenCalledWith({
      cron: "0 9 * * *",
      prompt: "morning standup",
    });
    expect(result).toMatchObject({ kind: "cron" });
  });

  it("forwards at(ISO-8601) timestamp", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    await tools.schedule.execute(
      { at: "2026-12-25T09:00:00Z", prompt: "merry christmas" },
      TOOL_EXEC_OPTS,
    );

    expect(env.scheduleWakeup).toHaveBeenCalledWith({
      at: "2026-12-25T09:00:00Z",
      prompt: "merry christmas",
    });
  });

  it("rejects when none of delay_seconds | at | cron provided", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    // Schema validation runs in the AI SDK BEFORE execute() is invoked,
    // so assert at the schema level rather than execute-rejection.
    const r = tools.schedule.inputSchema.safeParse({ prompt: "no when" });
    expect(r.success).toBe(false);
  });

  it("rejects when more than one trigger provided", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const r = tools.schedule.inputSchema.safeParse({
      delay_seconds: 60,
      cron: "0 9 * * *",
      prompt: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-bounds delay_seconds", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const tooSmall = tools.schedule.inputSchema.safeParse({ delay_seconds: 1, prompt: "x" });
    expect(tooSmall.success).toBe(false);

    const tooBig = tools.schedule.inputSchema.safeParse({
      delay_seconds: 8 * 24 * 3600,
      prompt: "x",
    });
    expect(tooBig.success).toBe(false);

    const justRight = tools.schedule.inputSchema.safeParse({
      delay_seconds: 600,
      prompt: "x",
    });
    expect(justRight.success).toBe(true);
  });

  it("requires non-empty prompt", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const r = tools.schedule.inputSchema.safeParse({ delay_seconds: 60, prompt: "" });
    expect(r.success).toBe(false);
  });

  it("safe wrapper converts scheduleWakeup throws into Error: string", async () => {
    const sandbox = new TestSandbox();
    const env = {
      ...makeScheduleEnv(),
      scheduleWakeup: vi.fn(async () => {
        throw new Error("session is terminated; cannot schedule wakeup");
      }),
    };
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const result = await tools.schedule.execute(
      { delay_seconds: 60, prompt: "x" },
      TOOL_EXEC_OPTS,
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("Error: session is terminated");
  });
});

describe("cancel_schedule + list_schedules — execution", () => {
  it("cancel_schedule forwards id and returns cancelled status", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const ok = await tools.cancel_schedule.execute({ id: "sched_abc" }, TOOL_EXEC_OPTS);
    expect(env.cancelWakeup).toHaveBeenCalledWith("sched_abc");
    expect(ok).toEqual({ cancelled: true });

    const miss = await tools.cancel_schedule.execute({ id: "missing" }, TOOL_EXEC_OPTS);
    expect(miss).toEqual({ cancelled: false });
  });

  it("cancel_schedule rejects empty id at schema level", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const r = tools.cancel_schedule.inputSchema.safeParse({ id: "" });
    expect(r.success).toBe(false);
  });

  it("list_schedules returns wrapped schedules array", async () => {
    const sandbox = new TestSandbox();
    const env = makeScheduleEnv();
    const tools = await buildTools(makeAgentConfig(), sandbox, env);

    const result = await tools.list_schedules.execute({}, TOOL_EXEC_OPTS);
    expect(env.listWakeups).toHaveBeenCalledOnce();
    expect(result).toEqual({
      schedules: [
        {
          id: "sched_existing",
          fire_at: "2026-04-28T09:00:00.000Z",
          cron: undefined,
          prompt: "remind me",
          kind: "one_shot",
        },
      ],
    });
  });
});
