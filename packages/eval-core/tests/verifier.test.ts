// Phase 2 acceptance test for the Verifier framework.
//
// Goal: prove that verifierForSpec correctly resolves each RewardSpec
// branch and that the verifiable builtin's SCORER_REGISTRY actually
// reaches the named scorer factory in scorers.ts. Anything more
// elaborate (live /exec, real reward_model HTTP) is integration.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  verifierForSpec,
  SCORER_REGISTRY,
  ScriptVerifier,
  CompositeVerifier,
  VerifiableVerifier,
  RewardModelVerifier,
  NoRunVerifier,
} from "@open-managed-agents/eval-core";
import type { Trajectory } from "@open-managed-agents/eval-core";

function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-04-17T10:00:00Z" };
}

function makeTrajectory(events: any[]): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "tr-1",
    session_id: "sess-1",
    agent_config: {} as any,
    environment_config: {} as any,
    model: { id: "test-model", provider: "" },
    started_at: "2026-04-17T10:00:00Z",
    outcome: "success",
    events,
    summary: {} as any,
  };
}

const dummyCtx = {
  sessionId: "sess-1",
  runExec: async () => ({ exit_code: 0, output: "" }),
};

describe("verifierForSpec dispatch", () => {
  it("resolves type:'script' to ScriptVerifier", () => {
    const v = verifierForSpec({ type: "script", verify_script: "true" }, dummyCtx);
    expect(v).toBeInstanceOf(ScriptVerifier);
    expect(v.id).toBe("script.v1");
  });

  it("resolves type:'composite' to CompositeVerifier", () => {
    const v = verifierForSpec(
      {
        type: "composite",
        components: [
          { name: "a", weight: 1, verifier: { type: "script", verify_script: "true" } },
        ],
      },
      dummyCtx,
    );
    expect(v).toBeInstanceOf(CompositeVerifier);
    expect(v.id).toBe("composite.v1");
  });

  it("resolves type:'verifiable' to VerifiableVerifier with the named scorer", () => {
    const v = verifierForSpec(
      { type: "verifiable", scorer: "bashExit", opts: { expectedCode: 0 } },
      dummyCtx,
    );
    expect(v).toBeInstanceOf(VerifiableVerifier);
    expect(v.id).toBe("verifiable.bashExit.v1");
  });

  it("resolves type:'reward_model' to RewardModelVerifier", () => {
    const v = verifierForSpec(
      { type: "reward_model", endpoint: "https://example.test/score" },
      dummyCtx,
    );
    expect(v).toBeInstanceOf(RewardModelVerifier);
    expect(v.id).toBe("reward_model.v1");
  });

  it("rejects an unknown scorer name with the registry's known list", () => {
    expect(() =>
      verifierForSpec({ type: "verifiable", scorer: "doesNotExist" }, dummyCtx),
    ).toThrow(/unknown scorer "doesNotExist"/);
  });
});

describe("VerifiableVerifier (the bashExit registry path)", () => {
  it("returns pass when the last bash tool call exited 0", async () => {
    const traj = makeTrajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "ls" }] }),
      ev(2, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
      ev(3, "agent.tool_result", { tool_use_id: "tu1", content: "file1\nfile2\nexit=0" }),
      ev(4, "session.status_idle"),
    ]);
    const v = verifierForSpec(
      { type: "verifiable", scorer: "bashExit", opts: { expectedCode: 0 } },
      dummyCtx,
    );
    const score = await v.check(traj);
    expect(score.pass).toBe(true);
    expect(score.value).toBe(1);
  });

  it("returns fail when the last bash tool call exited non-zero", async () => {
    const traj = makeTrajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "false" }] }),
      ev(2, "agent.tool_use", { id: "tu1", name: "bash", input: { command: "false" } }),
      ev(3, "agent.tool_result", { tool_use_id: "tu1", content: "exit=1" }),
      ev(4, "session.status_idle"),
    ]);
    const v = verifierForSpec(
      { type: "verifiable", scorer: "bashExit", opts: { expectedCode: 0 } },
      dummyCtx,
    );
    const score = await v.check(traj);
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
  });

  it("registry exposes all 11 production scorers", () => {
    // Lock the registry surface so adding a scorer to scorers.ts and
    // forgetting to wire it through the JSON RewardSpec layer fails fast.
    expect(Object.keys(SCORER_REGISTRY).sort()).toEqual([
      "agentMessageContains",
      "bashExit",
      "bashOutputMarker",
      "bashSuccess",
      "fileWritten",
      "gaiaMatch",
      "idleNoError",
      "includes",
      "regex",
      "threadCreated",
      "toolNotUsed",
      "toolUsed",
    ]);
  });
});

describe("ScriptVerifier", () => {
  it("returns pass when ctx.runExec exits 0", async () => {
    const ctx = {
      sessionId: "sess-1",
      runExec: async () => ({ exit_code: 0, output: "all tests passed" }),
    };
    const v = verifierForSpec({ type: "script", verify_script: "pytest" }, ctx);
    const score = await v.check({} as any);
    expect(score.pass).toBe(true);
    expect(score.value).toBe(1);
    expect((score.metadata as any).exit_code).toBe(0);
  });

  it("returns fail when ctx.runExec exits non-zero, surfaces output tail", async () => {
    const longOutput = "a".repeat(5000) + "FAIL line";
    const ctx = {
      sessionId: "sess-1",
      runExec: async () => ({ exit_code: 1, output: longOutput }),
    };
    const v = verifierForSpec({ type: "script", verify_script: "pytest" }, ctx);
    const score = await v.check({} as any);
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect((score.metadata as any).exit_code).toBe(1);
    // Truncated to 4000 chars (tail kept where pytest summary lives)
    expect((score.metadata as any).output.length).toBe(4000);
    expect((score.metadata as any).output.endsWith("FAIL line")).toBe(true);
  });

  it("returns fail with reason on runExec throw", async () => {
    const ctx = {
      sessionId: "sess-1",
      runExec: async () => {
        throw new Error("network unreachable");
      },
    };
    const v = verifierForSpec({ type: "script", verify_script: "pytest" }, ctx);
    const score = await v.check({} as any);
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toMatch(/network unreachable/);
  });
});

describe("CompositeVerifier", () => {
  it("aggregates child scores by weighted average", async () => {
    let callCount = 0;
    const ctx = {
      sessionId: "sess-1",
      // Two script children — first passes (1.0), second fails (0.0)
      runExec: async () => {
        callCount++;
        return { exit_code: callCount === 1 ? 0 : 1, output: "" };
      },
    };
    const v = verifierForSpec(
      {
        type: "composite",
        components: [
          { name: "tests", weight: 3, verifier: { type: "script", verify_script: "pytest" } },
          { name: "lint", weight: 1, verifier: { type: "script", verify_script: "ruff check" } },
        ],
      },
      ctx,
    );
    const score = await v.check({} as any);
    // Weighted average = (3*1 + 1*0) / 4 = 0.75
    expect(score.value).toBeCloseTo(0.75, 5);
    // pass=false because at least one child failed
    expect(score.pass).toBe(false);
    expect((score.metadata as any).criteria).toEqual({ tests: 1, lint: 0 });
  });

  it("returns 0 with empty components array", async () => {
    const v = verifierForSpec({ type: "composite", components: [] }, dummyCtx);
    const score = await v.check({} as any);
    expect(score.value).toBe(0);
    expect(score.pass).toBe(false);
  });
});

describe("NoRunVerifier", () => {
  it("always returns 0 with stable verifier_id", async () => {
    const v = new NoRunVerifier("setup_files write failed");
    const score = await v.check({} as any);
    expect(v.id).toBe("no-run.v1");
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toMatch(/no-run: setup_files write failed/);
  });
});
