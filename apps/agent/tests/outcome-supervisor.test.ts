// Outcome supervisor unit tests — exercises runOutcomeSupervisor()
// directly with fake deps (no Durable Object, no live LLM, no live
// sandbox). Covers the six scenarios from Phase 4 spec:
//   1. rubric: text → llm_judge verifier path
//   2. verifier: { type: "script", verify_script: "exit 0" } → satisfied
//   3. verifier: { type: "verifiable", scorer: "fileWritten" } →
//      satisfied / needs_revision
//   4. max_iterations exhausted → max_iterations_reached
//   5. verifier throws → failed
//   6. user.interrupt mid-eval → interrupted
//   7. sequential outcomes — second user.define_outcome after first
//      terminates starts fresh
//
// The supervisor is provider-agnostic — these tests do not touch
// `cloudflare:workers` or any DO API surface, just the supervisor
// closure and its injected deps.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  runOutcomeSupervisor,
  type ActiveOutcomeState,
  type OutcomeEvaluationRecord,
  type OutcomeSupervisorDeps,
} from "../src/runtime/outcome-supervisor";
import type { JudgeFn } from "@open-managed-agents/shared";

// ---------- shared fake harness ----------

interface FakeHarness {
  events: any[];
  evaluations: OutcomeEvaluationRecord[];
  state: {
    outcome: ActiveOutcomeState | null;
    outcome_iteration: number;
    outcome_evaluations: OutcomeEvaluationRecord[];
  };
  deps: Partial<OutcomeSupervisorDeps>;
  abortController: AbortController;
}

function makeFakeHarness(opts: {
  outcome: ActiveOutcomeState;
  initialEvents?: any[];
  judge?: JudgeFn;
  runExec?: (cmd: string) => Promise<{ exit_code: number; output: string }>;
  filesBucketGet?: (key: string) => Promise<{ text(): Promise<string> } | null>;
  /** Called after every needs_revision; tests can append a synthetic
   *  agent.message here, simulating the agent reacting to feedback. */
  onHarnessTurn?: (
    msg: any,
    h: FakeHarness,
  ) => Promise<void> | void;
}): FakeHarness {
  const ctrl = new AbortController();
  const h: FakeHarness = {
    events: [...(opts.initialEvents ?? [])],
    evaluations: [],
    state: {
      outcome: opts.outcome,
      outcome_iteration: 0,
      outcome_evaluations: [],
    },
    deps: {},
    abortController: ctrl,
  };

  h.deps = {
    outcome: opts.outcome,
    initialIteration: 0,
    tenantId: "tnt-test",
    filesBucket: opts.filesBucketGet
      ? ({ get: opts.filesBucketGet } as unknown as R2Bucket)
      : null,
    abortSignal: ctrl.signal,
    judgeModelId: "fake-model",
    getEvents: () => h.events,
    appendAndBroadcast: (e) => h.events.push(e),
    broadcastOnly: (e) => h.events.push(e),
    persistState: (delta) => {
      if ("outcome" in delta) h.state.outcome = delta.outcome ?? null;
      if (typeof delta.outcome_iteration === "number")
        h.state.outcome_iteration = delta.outcome_iteration;
      if (delta.outcome_evaluations) {
        h.state.outcome_evaluations = delta.outcome_evaluations;
        h.evaluations = delta.outcome_evaluations;
      }
    },
    readEvaluations: () => h.state.outcome_evaluations,
    makeVerifierContext: () => ({
      sessionId: "sess-test",
      runExec:
        opts.runExec ??
        (async () => ({ exit_code: 0, output: "" })),
    }),
    makeJudgeFn: () =>
      opts.judge ??
      (async () => ({
        text: JSON.stringify({
          result: "satisfied",
          explanation: "default fake judge",
        }),
      })),
    runHarnessTurn: async (msg) => {
      if (opts.onHarnessTurn) await opts.onHarnessTurn(msg, h);
    },
  };
  return h;
}

function agentMessage(text: string, id = `evt-${Math.random()}`) {
  return { type: "agent.message", id, content: [{ type: "text", text }] };
}

// ---------- Scenario 1: rubric: text → llm_judge satisfied ----------

describe("runOutcomeSupervisor", () => {
  it("rubric: text → llm_judge satisfied", async () => {
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test1",
        description: "Print hello world",
        rubric: { type: "text", content: "Output must contain 'hello'" },
        max_iterations: 3,
      },
      initialEvents: [agentMessage("hello world")],
      judge: async () => ({
        text: JSON.stringify({
          result: "satisfied",
          explanation: "Output contains 'hello'.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("satisfied");
    expect(report.terminal.explanation).toMatch(/hello/i);
    expect(report.terminal.usage?.input_tokens).toBe(100);
    expect(h.state.outcome).toBeNull(); // active outcome cleared
    expect(h.state.outcome_evaluations).toHaveLength(1);

    // span events emitted: ongoing + end (start is broadcast-only and
    // also lands in events here because broadcastOnly pushes to the
    // shared events array in this fake)
    const spanTypes = h.events
      .map((e) => e.type)
      .filter((t) => t.startsWith("span.outcome_evaluation"));
    expect(spanTypes).toContain("span.outcome_evaluation_start");
    expect(spanTypes).toContain("span.outcome_evaluation_ongoing");
    expect(spanTypes).toContain("span.outcome_evaluation_end");

    const endSpan = h.events.find(
      (e) => e.type === "span.outcome_evaluation_end",
    );
    expect(endSpan.outcome_id).toBe("outc_test1");
    expect(endSpan.iteration).toBe(0);
    expect(endSpan.usage.input_tokens).toBe(100);
    expect(endSpan.explanation).toBeTruthy();
    expect(endSpan.feedback).toBe(endSpan.explanation); // back-compat alias
  });

  // ---------- Scenario 2: script verifier exit 0 → satisfied ----------

  it("verifier: script exit 0 → satisfied", async () => {
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test2",
        description: "Run pytest",
        verifier: {
          type: "script",
          verify_script: "exit 0",
        },
        max_iterations: 3,
      },
      runExec: async (cmd) => {
        expect(cmd).toBe("exit 0");
        return { exit_code: 0, output: "" };
      },
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("satisfied");
    expect(h.state.outcome).toBeNull();
  });

  // ---------- Scenario 3: verifiable scorer ----------

  it("verifier: verifiable fileWritten → needs_revision then satisfied", async () => {
    let bashCallSent = false;
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test3",
        description: "Write /workspace/x.txt",
        verifier: {
          type: "verifiable",
          scorer: "fileWritten",
          opts: { path: "/workspace/x.txt" },
        },
        max_iterations: 3,
      },
      // No tool_use events yet → fileWritten scorer fails first iteration.
      onHarnessTurn: async (_msg, h) => {
        // Simulate the agent finally writing the file: emit the write
        // tool_use that fileWritten scorer looks for (it filters on
        // name === "write" + input.file_path).
        bashCallSent = true;
        h.events.push({
          type: "agent.tool_use",
          id: "tu-1",
          name: "write",
          input: { file_path: "/workspace/x.txt", content: "done" },
        });
        h.events.push({
          type: "agent.tool_result",
          tool_use_id: "tu-1",
          content: "",
          is_error: false,
        });
      },
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(bashCallSent).toBe(true); // harness was re-invoked
    expect(report.terminal.result).toBe("satisfied");
    expect(report.iterations.length).toBeGreaterThanOrEqual(2);
    expect(report.iterations[0].result).toBe("needs_revision");
  });

  // ---------- Scenario 4: max_iterations exhausted ----------

  it("max_iterations exhausted → max_iterations_reached", async () => {
    let iters = 0;
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test4",
        description: "Always fail",
        rubric: { type: "text", content: "rubric" },
        max_iterations: 2,
      },
      judge: async () => {
        iters++;
        return {
          text: JSON.stringify({
            result: "needs_revision",
            explanation: `still wrong (try ${iters})`,
          }),
        };
      },
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("max_iterations_reached");
    expect(report.iterations.length).toBe(2);
    expect(report.iterations[0].result).toBe("needs_revision");
    expect(report.iterations[1].result).toBe("max_iterations_reached");
    // Iterations are 0-indexed.
    expect(report.iterations[0].iteration).toBe(0);
    expect(report.iterations[1].iteration).toBe(1);
  });

  // ---------- Scenario 5: verifier throws → failed ----------
  //
  // We use a script verifier whose runExec throws synchronously — the
  // ScriptVerifier turns runExec failure into a not-pass score (it
  // catches), but a verifierForSpec on a malformed RewardSpec
  // (`type: "verifiable", scorer: "doesNotExist"`) throws at
  // construction time, which the supervisor surfaces as `failed`.

  it("verifier throws → failed", async () => {
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test5",
        description: "Will crash",
        // verifierForSpec throws at construction time on unknown scorers,
        // which the supervisor catches and surfaces as a "failed" verdict.
        verifier: {
          type: "verifiable",
          scorer: "definitelyDoesNotExist",
        },
        max_iterations: 3,
      },
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("failed");
    expect(report.terminal.explanation).toMatch(/verifier construction failed/);
    expect(h.state.outcome).toBeNull();
  });

  // ---------- Scenario 6: user.interrupt mid-eval → interrupted ----------

  it("user.interrupt mid-eval → interrupted", async () => {
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_test6",
        description: "Slow judge",
        rubric: { type: "text", content: "rubric" },
        max_iterations: 3,
      },
      judge: async (_p, signal) => {
        // Wait for abort, then throw an AbortError-shaped error.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            return reject(err);
          }
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return { text: "" };
      },
    });

    // Fire abort shortly after kicking off the supervisor.
    setTimeout(() => h.abortController.abort(), 5);

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("interrupted");
    expect(h.state.outcome).toBeNull();
  });

  // ---------- Scenario 7: sequential outcomes ----------

  it("sequential outcomes — second user.define_outcome starts fresh", async () => {
    // First outcome: satisfied.
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_first",
        description: "first",
        rubric: { type: "text", content: "rubric" },
        max_iterations: 3,
      },
      judge: async () => ({
        text: JSON.stringify({ result: "satisfied", explanation: "ok" }),
      }),
    });
    const r1 = await runOutcomeSupervisor(h.deps as any);
    expect(r1.terminal.result).toBe("satisfied");
    expect(h.state.outcome_evaluations).toHaveLength(1);
    expect(h.state.outcome_evaluations[0].outcome_id).toBe("outc_first");

    // Now run a SECOND supervisor against the same fake harness state —
    // mirrors what session-do does after the user posts another
    // user.define_outcome. The aggregate keeps growing; the new
    // verdict carries the new outcome_id; iteration restarts at 0.
    const secondOutcome: ActiveOutcomeState = {
      outcome_id: "outc_second",
      description: "second",
      rubric: { type: "text", content: "second rubric" },
      max_iterations: 3,
    };
    h.state.outcome = secondOutcome;
    h.state.outcome_iteration = 0;
    h.deps.outcome = secondOutcome;
    h.deps.initialIteration = 0;
    h.deps.makeJudgeFn = () => async () => ({
      text: JSON.stringify({
        result: "satisfied",
        explanation: "second ok",
      }),
    });

    const r2 = await runOutcomeSupervisor(h.deps as any);
    expect(r2.terminal.result).toBe("satisfied");
    expect(r2.terminal.outcome_id).toBe("outc_second");
    expect(r2.terminal.iteration).toBe(0);
    expect(h.state.outcome_evaluations).toHaveLength(2);
    expect(h.state.outcome_evaluations[0].outcome_id).toBe("outc_first");
    expect(h.state.outcome_evaluations[1].outcome_id).toBe("outc_second");
  });

  // ---------- Scenario 8: file rubric → R2 fetch ----------

  it("rubric: file → resolves via FILES_BUCKET", async () => {
    let getCalls: string[] = [];
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_file",
        description: "from file",
        rubric: { type: "file", file_id: "file-abc" },
        max_iterations: 2,
      },
      filesBucketGet: async (key) => {
        getCalls.push(key);
        return { text: async () => "rubric loaded from R2" };
      },
      judge: async (prompt) => {
        // The resolved markdown should appear in the user-side prompt.
        expect(prompt.user).toContain("rubric loaded from R2");
        return {
          text: JSON.stringify({ result: "satisfied", explanation: "ok" }),
        };
      },
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("satisfied");
    expect(getCalls).toEqual(["t/tnt-test/files/file-abc"]);
  });

  // ---------- Scenario 9: file rubric not found → failed ----------

  it("rubric: file 404 → failed", async () => {
    const h = makeFakeHarness({
      outcome: {
        outcome_id: "outc_file_missing",
        description: "from missing file",
        rubric: { type: "file", file_id: "file-missing" },
        max_iterations: 2,
      },
      filesBucketGet: async () => null, // R2 miss
    });

    const report = await runOutcomeSupervisor(h.deps as any);
    expect(report.terminal.result).toBe("failed");
    expect(report.terminal.explanation).toMatch(/rubric file fetch failed/);
  });
});
