// @ts-nocheck
import { describe, it, expect } from "vitest";
import { rlTrajectoryToPlatform, scoreToReward, asReward } from "../scorer-bridge";
import { bashOutputMarker, includes, toolUsed } from "../../packages/shared/src/index";
import type { Trajectory as RLTrajectory } from "../types";

function makeRLTraj(turns: any[], outcome: "success" | "failure" | "error" | "timeout" = "success"): RLTrajectory {
  return {
    task_id: "task-x",
    session_id: "sess-x",
    traj_uuid: "abc123",
    group_uuid: "g1",
    turns,
    completions: [],
    reward: { raw_rewards: {}, final_reward: 0 },
    reward_breakdown: { total: 0 },
    token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    num_turns: turns.length,
    duration_ms: 1000,
    outcome,
    metadata: { model_id: "test-model", collected_at: "2026-04-17T10:00:00Z" },
  };
}

describe("rlTrajectoryToPlatform", () => {
  it("converts user/assistant turns to platform events", () => {
    const traj = makeRLTraj([
      { role: "user", content: "hello", timestamp_ms: 1000 },
      { role: "assistant", content: "hi back", timestamp_ms: 2000 },
    ]);
    const platform = rlTrajectoryToPlatform(traj);
    expect(platform.schema_version).toBe("oma.trajectory.v1");
    const types = platform.events.map((e) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("agent.message");
    expect(types).toContain("session.status_idle"); // synthetic on success
  });

  it("converts tool_calls + tool_results", () => {
    const traj = makeRLTraj([
      { role: "user", content: "run ls", timestamp_ms: 1000 },
      { role: "assistant", content: "", tool_calls: [{ id: "tu1", name: "bash", input: { command: "ls" } }], timestamp_ms: 2000 },
      { role: "tool", content: "", tool_results: [{ tool_use_id: "tu1", content: "file.txt" }], timestamp_ms: 3000 },
    ]);
    const platform = rlTrajectoryToPlatform(traj);
    const toolUseEvent = platform.events.find((e) => e.type === "agent.tool_use");
    const toolResultEvent = platform.events.find((e) => e.type === "agent.tool_result");
    expect(toolUseEvent).toBeDefined();
    expect(toolResultEvent).toBeDefined();
    const useData = JSON.parse(toolUseEvent.data);
    expect(useData.name).toBe("bash");
    expect(useData.input.command).toBe("ls");
  });

  it("emits session.error on failure outcome (so idleNoError fails correctly)", () => {
    const traj = makeRLTraj([{ role: "user", content: "x", timestamp_ms: 1000 }], "failure");
    const platform = rlTrajectoryToPlatform(traj);
    const errs = platform.events.filter((e) => e.type === "session.error");
    expect(errs.length).toBe(1);
  });
});

describe("scoreToReward", () => {
  it("maps Score to RewardResult preserving value", () => {
    const reward = scoreToReward({ pass: true, value: 0.7, reason: "ok" }, "test_pass");
    expect(reward.final_reward).toBe(0.7);
    expect(reward.raw_rewards.test_pass).toBe(0.7);
  });

  it("uses default name when omitted", () => {
    const reward = scoreToReward({ pass: false, value: 0, reason: "fail" });
    expect(reward.raw_rewards.scorer).toBe(0);
  });
});

describe("asReward (Scorer → VerifyFn)", () => {
  it("end-to-end: wraps a Phase 2 scorer as RL reward function", async () => {
    const traj = makeRLTraj([
      { role: "user", content: "test", timestamp_ms: 1000 },
      { role: "assistant", content: "", tool_calls: [{ id: "tu1", name: "bash", input: { command: "pytest" } }], timestamp_ms: 2000 },
      { role: "tool", content: "", tool_results: [{ tool_use_id: "tu1", content: "ALL_TESTS_PASSED\n" }], timestamp_ms: 3000 },
    ]);
    const reward = await asReward(bashOutputMarker("ALL_TESTS_PASSED"), "test_pass")(traj, {} as any);
    expect(reward.final_reward).toBe(1);
    expect(reward.raw_rewards.test_pass).toBe(1);
  });

  it("returns 0 reward when scorer fails", async () => {
    const traj = makeRLTraj([{ role: "user", content: "test", timestamp_ms: 1000 }]);
    const reward = await asReward(includes("missing"), "found")(traj, {} as any);
    expect(reward.final_reward).toBe(0);
  });

  it("composes naturally with all() combinator", async () => {
    const traj = makeRLTraj([
      { role: "user", content: "test", timestamp_ms: 1000 },
      { role: "assistant", content: "", tool_calls: [{ id: "tu1", name: "bash", input: { command: "echo hi" } }], timestamp_ms: 2000 },
      { role: "tool", content: "", tool_results: [{ tool_use_id: "tu1", content: "DONE" }], timestamp_ms: 3000 },
    ]);
    const { all } = await import("../../packages/shared/src/index");
    const reward = await asReward(
      all(toolUsed("bash"), bashOutputMarker("DONE")),
      "combined",
    )(traj, {} as any);
    expect(reward.final_reward).toBe(1);
  });
});
