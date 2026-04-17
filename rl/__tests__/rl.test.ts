import { describe, it, expect } from "vitest";
import { eventsToTrajectory } from "../trajectory.js";
import { computeReward, batchRewardStats } from "../reward.js";
import { verify, computeGroupAdvantages, computeAdvantage } from "../verifier.js";
import { loadConfig } from "../config.js";
import { trajectoryToJsonl, parseTrajectoryJsonl } from "../trajectory.js";
import type { RLTask, Trajectory } from "../types.js";
import type { SSEEvent } from "../../test/eval/types.js";

import fileOps from "../tasks/file-ops.json";
import bashOps from "../tasks/bash-ops.json";
import multiStep from "../tasks/multi-step.json";

// --- Task loading ---

describe("task loading", () => {
  it("loads file-ops tasks", () => {
    expect(fileOps.name).toBe("file-ops");
    expect(fileOps.tasks.length).toBe(10);
    for (const task of fileOps.tasks) {
      expect(task.id).toBeTruthy();
      expect(task.message).toBeTruthy();
      expect(task.reward).toBeTruthy();
      expect(task.reward.checks!.length).toBeGreaterThan(0);
    }
  });

  it("loads bash-ops tasks", () => {
    expect(bashOps.name).toBe("bash-ops");
    expect(bashOps.tasks.length).toBe(5);
  });

  it("loads multi-step tasks", () => {
    expect(multiStep.name).toBe("multi-step");
    expect(multiStep.tasks.length).toBe(5);
  });

  it("all 20 tasks use verifiable reward with scores summing to ~1.0", () => {
    const allTasks = [...fileOps.tasks, ...bashOps.tasks, ...multiStep.tasks];
    expect(allTasks.length).toBe(20);
    for (const task of allTasks) {
      expect(task.reward.type).toBe("verifiable");
      const totalScore = task.reward.checks!.reduce((s: number, r: any) => s + r.score, 0);
      expect(totalScore).toBeCloseTo(1.0, 1);
    }
  });
});

// --- Trajectory extraction ---

describe("trajectory extraction", () => {
  const mockTask: RLTask = {
    id: "test-task",
    description: "test",
    message: "do something",
    reward: { type: "verifiable", checks: [] },
  };

  it("extracts user and assistant turns", () => {
    const events: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "agent.message", content: [{ type: "text", text: "hi there" }] },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];

    const traj = eventsToTrajectory(events, mockTask, "sess-1", "test-model", Date.now() - 1000);
    expect(traj.task_id).toBe("test-task");
    expect(traj.traj_uuid).toBeTruthy();
    expect(traj.group_uuid).toBeTruthy();
    expect(traj.turns.length).toBe(2);
    expect(traj.turns[0].role).toBe("user");
    expect(traj.turns[1].role).toBe("assistant");
    expect(traj.completions.length).toBe(1);
    expect(traj.completions[0].content).toBe("hi there");
    expect(traj.outcome).toBe("success");
  });

  it("assigns group_uuid when provided", () => {
    const events: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "agent.message", content: [{ type: "text", text: "hi" }] },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];

    const traj = eventsToTrajectory(events, mockTask, "sess", "model", Date.now(), "group-123");
    expect(traj.group_uuid).toBe("group-123");
  });

  it("creates completions for tool calls", () => {
    const events: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "create a file" }] },
      { type: "agent.tool_use", id: "tc-1", name: "write", input: { path: "/test.txt" } },
      { type: "agent.tool_result", tool_use_id: "tc-1", content: "File written" },
      { type: "agent.message", content: [{ type: "text", text: "Done!" }] },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];

    const traj = eventsToTrajectory(events, mockTask, "sess", "model", Date.now());
    // tool_use + tool_result are flushed together when agent.message arrives
    expect(traj.completions.length).toBeGreaterThanOrEqual(1);
    const toolCompletion = traj.completions.find((c) => c.finish_reason === "tool_calls");
    const stopCompletion = traj.completions.find((c) => c.finish_reason === "stop");
    expect(toolCompletion || stopCompletion).toBeDefined();
  });

  it("accumulates token usage", () => {
    const events: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "span.model_request_end", model_usage: { input_tokens: 100, output_tokens: 50 } },
      { type: "agent.message", content: [{ type: "text", text: "hi" }] },
      { type: "span.model_request_end", model_usage: { input_tokens: 200, output_tokens: 100 } },
      { type: "agent.message", content: [{ type: "text", text: "more" }] },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];

    const traj = eventsToTrajectory(events, mockTask, "sess", "model", Date.now());
    expect(traj.token_usage.input_tokens).toBe(300);
    expect(traj.token_usage.output_tokens).toBe(150);
  });

  it("detects error and timeout outcomes", () => {
    const errorEvents: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "session.error", error: "something went wrong" },
    ];
    expect(eventsToTrajectory(errorEvents, mockTask, "s", "m", Date.now()).outcome).toBe("error");

    const timeoutEvents: SSEEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "session.error", error: "timeout exceeded" },
    ];
    expect(eventsToTrajectory(timeoutEvents, mockTask, "s", "m", Date.now()).outcome).toBe("timeout");
  });
});

// --- Verifier (new module) ---

describe("verifier", () => {
  function makeTrajectory(toolOutput: string, toolName = "bash"): Trajectory {
    return {
      task_id: "test",
      session_id: "sess",
      traj_uuid: "traj-1",
      group_uuid: "group-1",
      turns: [
        { role: "user", content: "do something", timestamp_ms: 0 },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc-1", name: toolName, input: { command: "echo" } }],
          timestamp_ms: 1,
        },
        {
          role: "tool",
          content: toolOutput,
          tool_results: [{ tool_use_id: "tc-1", content: toolOutput }],
          timestamp_ms: 2,
        },
        { role: "assistant", content: "Done", timestamp_ms: 3 },
      ],
      completions: [],
      reward: { raw_rewards: {}, final_reward: 0 },
      reward_breakdown: { total: 0 },
      token_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      num_turns: 1,
      duration_ms: 1000,
      outcome: "success",
      metadata: { model_id: "test", collected_at: new Date().toISOString() },
    };
  }

  it("scores verifiable checks correctly", () => {
    const task: RLTask = {
      id: "test",
      description: "test",
      message: "echo hello",
      reward: {
        type: "verifiable",
        checks: [
          { type: "bash_output_contains", expected: "Hello, World!", score: 0.7 },
          { type: "exit_code", expected: "0", score: 0.3 },
        ],
      },
    };

    const traj = makeTrajectory("Hello, World!");
    const result = verify(traj, task);
    expect(result.final_reward).toBeGreaterThan(0);
    expect(Object.keys(result.raw_rewards).length).toBeGreaterThan(0);
  });

  it("returns 0 for missing content", () => {
    const task: RLTask = {
      id: "test",
      description: "test",
      message: "do something",
      reward: {
        type: "verifiable",
        checks: [{ type: "bash_output_contains", expected: "MISSING", score: 1.0 }],
      },
    };

    const result = verify(makeTrajectory("other output"), task);
    const scores = Object.values(result.raw_rewards).filter((v) => v > 0 && v !== result.raw_rewards.efficiency);
    expect(scores.length).toBe(0); // no check passed
  });

  it("returns 0 for error/timeout trajectories", () => {
    const task: RLTask = {
      id: "test",
      description: "test",
      message: "do something",
      reward: { type: "verifiable", checks: [{ type: "bash_output_contains", expected: "hello", score: 1.0 }] },
    };

    const errorTraj = makeTrajectory("hello");
    errorTraj.outcome = "error";
    expect(verify(errorTraj, task).final_reward).toBe(0);

    const timeoutTraj = makeTrajectory("hello");
    timeoutTraj.outcome = "timeout";
    expect(verify(timeoutTraj, task).final_reward).toBe(0);
  });

  it("supports ground_truth exact match", () => {
    const task: RLTask = {
      id: "test",
      description: "test",
      message: "what is 12+7?",
      reward: { type: "verifiable", ground_truth: "19" },
    };

    const traj = makeTrajectory("The answer is 19.");
    const result = verify(traj, task);
    expect(result.raw_rewards.ground_truth_match).toBe(1.0);
    expect(result.final_reward).toBeGreaterThan(0);
  });

  it("includes efficiency bonus", () => {
    const task: RLTask = {
      id: "test",
      description: "test",
      message: "do something",
      max_turns: 10,
      reward: { type: "verifiable", checks: [{ type: "bash_output_contains", expected: "hello", score: 1.0 }] },
    };

    const fast = makeTrajectory("hello");
    fast.num_turns = 1;
    const slow = makeTrajectory("hello");
    slow.num_turns = 8;

    expect(verify(fast, task).raw_rewards.efficiency).toBeGreaterThan(
      verify(slow, task).raw_rewards.efficiency,
    );
  });
});

// --- GRPO Advantage ---

describe("GRPO advantage estimation", () => {
  function makeTraj(groupUuid: string, reward: number): Trajectory {
    return {
      task_id: "t",
      session_id: "s",
      traj_uuid: `traj-${Math.random()}`,
      group_uuid: groupUuid,
      turns: [],
      completions: [],
      reward: { raw_rewards: {}, final_reward: reward },
      reward_breakdown: { total: reward },
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      num_turns: 1,
      duration_ms: 100,
      outcome: "success",
      metadata: { model_id: "m", collected_at: "" },
    };
  }

  it("computes group stats correctly", () => {
    const trajs = [
      makeTraj("g1", 1.0),
      makeTraj("g1", 0.0),
      makeTraj("g1", 1.0),
      makeTraj("g1", 1.0),
    ];

    const stats = computeGroupAdvantages(trajs);
    const g1 = stats.get("g1")!;
    expect(g1.reward_mean).toBeCloseTo(0.75);
    expect(g1.finished_num).toBe(4);
    expect(g1.pass_rate).toBe(0.75);
    expect(g1.reward_std).toBeGreaterThan(0);

    // group_stats written back to trajectories
    expect(trajs[0].group_stats).toBeDefined();
    expect(trajs[0].group_stats!.reward_mean).toBeCloseTo(0.75);
  });

  it("computes per-trajectory advantage", () => {
    const stats = { group_uuid: "g1", reward_mean: 0.75, reward_std: 0.43, finished_num: 4, pass_rate: 0.75 };

    const advHigh = computeAdvantage(1.0, stats);
    const advLow = computeAdvantage(0.0, stats);
    expect(advHigh).toBeGreaterThan(0);
    expect(advLow).toBeLessThan(0);
  });

  it("handles multiple groups independently", () => {
    const trajs = [
      makeTraj("g1", 1.0),
      makeTraj("g1", 0.0),
      makeTraj("g2", 0.5),
      makeTraj("g2", 0.5),
    ];

    const stats = computeGroupAdvantages(trajs);
    expect(stats.size).toBe(2);
    expect(stats.get("g2")!.reward_std).toBeLessThan(0.01); // all same reward
  });
});

// --- Backward compat (reward.ts wrapper) ---

describe("reward backward compat", () => {
  function makeTrajectory(output: string): Trajectory {
    return {
      task_id: "test",
      session_id: "s",
      traj_uuid: "t",
      group_uuid: "g",
      turns: [
        { role: "user", content: "do", timestamp_ms: 0 },
        { role: "assistant", content: "", tool_calls: [{ id: "tc", name: "bash", input: {} }], timestamp_ms: 1 },
        { role: "tool", content: output, tool_results: [{ tool_use_id: "tc", content: output }], timestamp_ms: 2 },
      ],
      completions: [],
      reward: { raw_rewards: {}, final_reward: 0 },
      reward_breakdown: { total: 0 },
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      num_turns: 1,
      duration_ms: 100,
      outcome: "success",
      metadata: { model_id: "m", collected_at: "" },
    };
  }

  it("computeReward returns RewardBreakdown", async () => {
    const task: RLTask = {
      id: "t",
      description: "t",
      message: "t",
      reward: { type: "verifiable", checks: [{ type: "bash_output_contains", expected: "hello", score: 1.0 }] },
    };
    const result = await computeReward(makeTrajectory("hello"), task);
    expect(result.total).toBeGreaterThan(0);
    expect(typeof result.rules).toBe("number");
    expect(typeof result.efficiency).toBe("number");
  });

  it("batchRewardStats works", () => {
    const stats = batchRewardStats([{ total: 0.8 }, { total: 0.6 }, { total: 1.0 }, { total: 0.0 }]);
    expect(stats.mean).toBeCloseTo(0.6);
    expect(stats.min).toBe(0.0);
    expect(stats.max).toBe(1.0);
  });
});

// --- Serialization ---

describe("trajectory serialization", () => {
  it("round-trips through JSONL", () => {
    const trajectories: Trajectory[] = [
      {
        task_id: "t1",
        session_id: "s1",
        traj_uuid: "tj1",
        group_uuid: "g1",
        turns: [{ role: "user", content: "hello", timestamp_ms: 0 }],
        completions: [],
        reward: { raw_rewards: { check: 1.0 }, final_reward: 0.8 },
        reward_breakdown: { total: 0.8 },
        token_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
        num_turns: 1,
        duration_ms: 1000,
        outcome: "success",
        metadata: { model_id: "test", collected_at: "2024-01-01" },
      },
    ];

    const jsonl = trajectoryToJsonl(trajectories);
    const parsed = parseTrajectoryJsonl(jsonl);
    expect(parsed[0].task_id).toBe("t1");
    expect(parsed[0].reward.final_reward).toBe(0.8);
    expect(parsed[0].traj_uuid).toBe("tj1");
    expect(parsed[0].group_uuid).toBe("g1");
  });
});

// --- Config ---

describe("config", () => {
  it("returns defaults", () => {
    const config = loadConfig();
    expect(config.api_url).toBe("http://localhost:8787");
    expect(config.concurrency).toBe(8);
    expect(config.group_size).toBe(4);
  });

  it("accepts overrides", () => {
    const config = loadConfig({ model: "qwen-7b", model_compat: "oai-compatible" });
    expect(config.model).toBe("qwen-7b");
    expect(config.model_compat).toBe("oai-compatible");
  });
});
