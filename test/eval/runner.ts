import type {
  EvalTask,
  EvalTaskResult,
  EvalSuiteResult,
  EvalReport,
  EvalTrialResult,
  VerifyResult,
  VerifyStatus,
  SSEEvent,
} from "./types.js";
import type { Trajectory, StoredEvent } from "../../packages/shared/src/index.js";
import { DEFAULT_MODEL, DEFAULT_TIMEOUT } from "./types.js";
import {
  createAgent,
  createSession,
  deleteAgent,
  deleteSession,
  getOrCreateEnvironment,
  sendAndWait,
  setupFiles,
  judge,
} from "./client.js";

// ---- Import suites ----

import { toolUseSuite } from "./suites/tool-use.js";
import { codingSuite } from "./suites/coding.js";
import { multiStepSuite } from "./suites/multi-step.js";
import { errorRecoverySuite } from "./suites/error-recovery.js";
import { multiAgentSuite } from "./suites/multi-agent.js";
import { multimodalSuite } from "./suites/multimodal.js";

const ALL_SUITES: Record<string, EvalTask[]> = {
  "tool-use": toolUseSuite,
  coding: codingSuite,
  "multi-step": multiStepSuite,
  "error-recovery": errorRecoverySuite,
  "multi-agent": multiAgentSuite,
  multimodal: multimodalSuite,
};

// ---- CLI arg parsing ----

function parseArgs(): { suite?: string; task?: string; concurrency: number; trials?: number } {
  const args = process.argv.slice(2);
  let suite: string | undefined;
  let task: string | undefined;
  let concurrency = 1;
  let trials: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--suite" && args[i + 1]) suite = args[++i];
    if (args[i] === "--task" && args[i + 1]) task = args[++i];
    if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i], 10);
    if (args[i] === "--trials" && args[i + 1]) trials = parseInt(args[++i], 10);
  }

  return { suite, task, concurrency, trials };
}

// ---- Task execution ----

/**
 * Run a single trial of a task (one independent agent + session).
 * runTask wraps this for multi-trial pass@k / pass^k support.
 */
async function runOneTrial(task: EvalTask, trialIndex: number): Promise<EvalTrialResult> {
  const start = Date.now();
  const turnResults: VerifyResult[] = [];
  const agentIds: string[] = [];
  const sessionIds: string[] = [];

  const trialLabel = (task.trials || 1) > 1 ? ` trial ${trialIndex + 1}/${task.trials}` : "";

  try {
    const envId = await getOrCreateEnvironment();

    // Create sub-agents (for multi-agent tasks)
    const callableAgents: Array<{ type: "agent"; id: string }> = [];
    if (task.subAgents) {
      for (const sub of task.subAgents) {
        const subId = await createAgent({
          name: `eval-sub-${sub.name}-${Date.now()}-${trialIndex}`,
          system: sub.system,
          model: sub.model || DEFAULT_MODEL,
          tools: sub.tools,
        });
        agentIds.push(subId);
        callableAgents.push({ type: "agent", id: subId });
      }
    }

    // Create main agent
    const agentId = await createAgent({
      name: `eval-${task.id}-${Date.now()}-${trialIndex}`,
      system: task.agentConfig.system,
      model: task.agentConfig.model || DEFAULT_MODEL,
      tools: task.agentConfig.tools,
      callable_agents: callableAgents.length > 0 ? callableAgents : undefined,
    });
    agentIds.push(agentId);

    // Create session
    const sessionId = await createSession(agentId, envId);
    sessionIds.push(sessionId);

    // Setup fixture files
    if (task.setupFiles && task.setupFiles.length > 0) {
      log(task.id, `${trialLabel} Setting up fixture files...`);
      await setupFiles(sessionId, task.setupFiles);
    }

    // Execute turns
    const allEvents: SSEEvent[] = [];
    for (let i = 0; i < task.turns.length; i++) {
      const turn = task.turns[i];
      log(task.id, `${trialLabel} Turn ${i + 1}/${task.turns.length}: sending message...`);

      const events = await sendAndWait(sessionId, turn.message, task.timeoutMs || DEFAULT_TIMEOUT);
      allEvents.push(...events);

      const result = turn.verify(events);
      turnResults.push(result);
      log(task.id, `${trialLabel} Turn ${i + 1} → ${result.status}: ${result.message}`);

      // When task.scorer is defined, the scorer is the authoritative judge.
      // Legacy turn-level verify is kept advisory (we still log failures) but
      // does NOT short-circuit. Without this, brittle legacy verify (e.g.
      // case-sensitive substring match) prevents the scorer (case-insensitive)
      // from ever being asked.
      if (result.status === "fail" && !task.scorer) {
        return {
          trialIndex,
          status: "fail",
          message: `Turn ${i + 1} failed: ${result.message}`,
          durationMs: Date.now() - start,
          turnResults,
          error: result.details?.join("\n"),
        };
      }
    }

    // P0b: end-state sandbox verification commands. Asks the agent to run them
    // (one per turn) so their outputs land in the trajectory for scorer review.
    if (task.verifyCommands && task.verifyCommands.length > 0) {
      for (const cmd of task.verifyCommands) {
        log(task.id, `${trialLabel} Verify cmd: ${cmd.slice(0, 80)}`);
        const events = await sendAndWait(
          sessionId,
          `Run: ${cmd}`,
          task.timeoutMs || DEFAULT_TIMEOUT,
        );
        allEvents.push(...events);
      }
    }

    // Final verification (legacy) — also advisory when scorer present
    if (task.finalVerify) {
      const finalResult = task.finalVerify(allEvents);
      turnResults.push(finalResult);
      if (finalResult.status === "fail" && !task.scorer) {
        return {
          trialIndex,
          status: "fail",
          message: `Final verification failed: ${finalResult.message}`,
          durationMs: Date.now() - start,
          turnResults,
        };
      }
    }

    // Layer 2: judge evaluation (legacy path; only used if no scorer)
    if (!task.scorer && task.outcome && allEvents.length > 0) {
      log(task.id, `${trialLabel} Running Layer 2 judge...`);
      const verdict = await judge(allEvents, task.outcome.rubric);
      log(task.id, `${trialLabel} Judge: ${verdict.result} — ${verdict.reasoning}`);
      const judgeResult: VerifyResult = verdict.result === "pass"
        ? { status: "pass", message: `Judge: ${verdict.reasoning}` }
        : { status: "fail", message: `Judge: ${verdict.reasoning}` };
      turnResults.push(judgeResult);
      if (judgeResult.status === "fail") {
        return {
          trialIndex,
          status: "fail",
          message: `Judge failed: ${verdict.reasoning}`,
          durationMs: Date.now() - start,
          turnResults,
          error: verdict.reasoning,
        };
      }
    }

    // Phase 2: Scorer evaluation (canonical path going forward)
    if (task.scorer) {
      log(task.id, `${trialLabel} Running scorer...`);
      const traj = synthesizeTrajectory(task.id, allEvents);
      const score = await task.scorer(traj);
      log(task.id, `${trialLabel} Scorer: ${score.pass ? "PASS" : "FAIL"} — ${score.reason}`);
      const scoreResult: VerifyResult = score.pass
        ? { status: "pass", message: `Scorer: ${score.reason}` }
        : { status: "fail", message: `Scorer: ${score.reason}` };
      turnResults.push(scoreResult);
      if (!score.pass) {
        return {
          trialIndex,
          status: "fail",
          message: `Scorer failed: ${score.reason}`,
          durationMs: Date.now() - start,
          turnResults,
          error: score.reason,
        };
      }
    }

    return {
      trialIndex,
      status: "pass",
      message: task.scorer
        ? "Scorer passed"
        : task.outcome
          ? "All turns + outcome passed"
          : "All turns passed",
      durationMs: Date.now() - start,
      turnResults,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      trialIndex,
      status: "fail",
      message: `Error: ${msg}`,
      durationMs: Date.now() - start,
      turnResults,
      error: msg,
    };
  } finally {
    // Cleanup on success; keep on failure for debugging
    if (turnResults.length > 0 && turnResults.every((r) => r.status === "pass")) {
      for (const sid of sessionIds) await deleteSession(sid);
      for (const aid of agentIds) await deleteAgent(aid);
    } else {
      console.log(`    [cleanup] Keeping for debugging: agents=${agentIds.join(",")} sessions=${sessionIds.join(",")}`);
    }
  }
}

/**
 * Run a task. If task.trials > 1, runs N independent trials and aggregates
 * pass@1, pass@k (any), pass^k (all) — per Anthropic eval blog recommendation.
 */
async function runTask(task: EvalTask): Promise<EvalTaskResult> {
  const trials = Math.max(1, task.trials || 1);
  const start = Date.now();
  const trialResults: EvalTrialResult[] = [];

  for (let i = 0; i < trials; i++) {
    const trial = await runOneTrial(task, i);
    trialResults.push(trial);
    if (trials > 1) {
      log(task.id, `Trial ${i + 1}/${trials} → ${trial.status}: ${trial.message}`);
    }
  }

  const passCount = trialResults.filter((t) => t.status === "pass").length;
  const passAt1 = trialResults[0]?.status === "pass";
  const passAtK = passCount > 0;
  const passPowK = passCount === trials;
  // Aggregate: pass = pass^k (all trials passed). Mirrors blog's pass^k for
  // tools where consistency matters; flip to passAtK if you only need one.
  const aggregateStatus: VerifyStatus =
    trials === 1
      ? (trialResults[0]?.status ?? "fail")
      : passPowK
        ? "pass"
        : "fail";

  return {
    taskId: task.id,
    category: task.category,
    difficulty: task.difficulty,
    status: aggregateStatus,
    message:
      trials === 1
        ? trialResults[0]?.message || "no trials"
        : `${passCount}/${trials} trials passed (pass^k=${passPowK})`,
    durationMs: Date.now() - start,
    turnResults: trialResults[0]?.turnResults || [],
    error: trialResults.find((t) => t.error)?.error,
    ...(trials > 1 && {
      trials: trialResults,
      passAt1,
      passAtK,
      passPowK,
      trialPassCount: passCount,
      trialTotal: trials,
    }),
  };
}

// ---- Suite execution ----

async function runSuite(name: string, tasks: EvalTask[]): Promise<EvalSuiteResult> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Suite: ${name} (${tasks.length} tasks)`);
  console.log("=".repeat(60));

  const results: EvalTaskResult[] = [];

  for (const task of tasks) {
    console.log(`\n  [${task.id}] ${task.description} (${task.difficulty})`);
    const result = await runTask(task);
    results.push(result);

    const icon = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" : "FAIL";
    console.log(`  → ${icon} (${(result.durationMs / 1000).toFixed(1)}s) ${result.message}`);
    if (result.error) {
      console.log(`    Error: ${result.error.slice(0, 200)}`);
    }
  }

  return {
    suite: name,
    tasks: results,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
  };
}

// ---- Report ----

function printReport(report: EvalReport): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`OMA Eval Report — ${report.timestamp}`);
  console.log("=".repeat(60));
  console.log(
    `${"Category".padEnd(22)} ${"Pass".padStart(5)} ${"Fail".padStart(5)} ${"Skip".padStart(5)} ${"Total".padStart(6)}`,
  );
  console.log("-".repeat(48));

  for (const suite of report.suites) {
    const total = suite.pass + suite.fail + suite.skip;
    console.log(
      `${suite.suite.padEnd(22)} ${String(suite.pass).padStart(5)} ${String(suite.fail).padStart(5)} ${String(suite.skip).padStart(5)} ${String(total).padStart(6)}`,
    );
  }

  console.log("-".repeat(48));
  console.log(
    `${"Total".padEnd(22)} ${String(report.totalPass).padStart(5)} ${String(report.totalFail).padStart(5)} ${String(report.totalSkip).padStart(5)} ${String(report.totalTasks).padStart(6)}`,
  );
  console.log(`\nDuration: ${(report.durationMs / 1000).toFixed(1)}s`);

  // Print pass@k / pass^k for tasks that ran multiple trials
  const multiTrial = report.suites.flatMap((s) =>
    s.tasks.filter((t) => t.trials && t.trialTotal && t.trialTotal > 1),
  );
  if (multiTrial.length > 0) {
    console.log(`\nMulti-trial breakdown (pass@k / pass^k):`);
    console.log(
      `${"Task".padEnd(34)} ${"trials".padStart(6)} ${"pass@1".padStart(7)} ${"pass@k".padStart(7)} ${"pass^k".padStart(7)}`,
    );
    console.log("-".repeat(64));
    for (const t of multiTrial) {
      console.log(
        `${t.taskId.padEnd(34)} ${String(t.trialTotal).padStart(6)} ${String(t.passAt1 ? "✓" : "✗").padStart(7)} ${String(t.passAtK ? "✓" : "✗").padStart(7)} ${String(t.passPowK ? "✓" : "✗").padStart(7)}`,
      );
    }
  }

  // Print failures
  const failures = report.suites.flatMap((s) => s.tasks.filter((t) => t.status === "fail"));
  if (failures.length > 0) {
    console.log(`\nFailed Tasks:`);
    for (const f of failures) {
      console.log(`  ${f.taskId} (${f.difficulty}) — ${f.message}`);
      if (f.error) console.log(`    ${f.error.slice(0, 200)}`);
    }
  }
}

// ---- Logging ----

function log(taskId: string, msg: string): void {
  console.log(`    [${taskId}] ${msg}`);
}

// ---- Trajectory synthesis (for in-process scorer) ----
//
// The runner today returns SSEEvent[] from sendAndWait. New scorers consume a
// full Trajectory envelope. We synthesize a minimal Trajectory from events so
// scorers can be developed/used immediately, before the eval CLI is rewritten
// to fetch the canonical /v1/sessions/:id/trajectory endpoint (Phase 1d).

function synthesizeTrajectory(taskId: string, events: SSEEvent[]): Trajectory {
  const stored: StoredEvent[] = events.map((e, i) => ({
    seq: ((e as { _seq?: number })._seq as number) || i + 1,
    type: e.type,
    data: JSON.stringify(e),
    ts: (e as { ts?: string }).ts || new Date().toISOString(),
  }));
  let numTurns = 0;
  let numToolCalls = 0;
  let numToolErrors = 0;
  for (const e of events) {
    if (e.type === "agent.message") numTurns++;
    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use") numToolCalls++;
    if ((e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") && (e as { is_error?: boolean }).is_error) numToolErrors++;
  }
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: `tr-synth-${taskId}-${Date.now()}`,
    session_id: `synth-${taskId}`,
    agent_config: {} as never,
    environment_config: {} as never,
    model: { id: "synthetic", provider: "" },
    started_at: new Date().toISOString(),
    outcome: events.some((e) => e.type === "session.error") ? "failure" : "success",
    events: stored,
    summary: {
      num_events: stored.length,
      num_turns: numTurns,
      num_tool_calls: numToolCalls,
      num_tool_errors: numToolErrors,
      num_threads: 0,
      duration_ms: 0,
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

// ---- Main ----

async function main() {
  const { suite, task, trials } = parseArgs();

  console.log("OMA Eval Runner");
  console.log(`API: ${process.env.OMA_API_URL || "http://localhost:8787"}`);
  console.log(`Filter: ${suite ? `suite=${suite}` : task ? `task=${task}` : "all"}`);
  if (trials !== undefined) console.log(`Trials override: ${trials}`);

  const start = Date.now();
  const suiteResults: EvalSuiteResult[] = [];

  // Filter suites/tasks
  let suitesToRun = Object.entries(ALL_SUITES);
  if (suite) {
    suitesToRun = suitesToRun.filter(([name]) => name === suite);
    if (suitesToRun.length === 0) {
      console.error(`Unknown suite: ${suite}. Available: ${Object.keys(ALL_SUITES).join(", ")}`);
      process.exit(1);
    }
  }

  for (const [name, tasks] of suitesToRun) {
    let filteredTasks = tasks;
    if (task) {
      filteredTasks = tasks.filter((t) => t.id === task);
    }
    if (filteredTasks.length === 0) continue;

    // Apply CLI trials override if set
    if (trials !== undefined) {
      filteredTasks = filteredTasks.map((t) => ({ ...t, trials }));
    }

    const result = await runSuite(name, filteredTasks);
    suiteResults.push(result);
  }

  const report: EvalReport = {
    timestamp: new Date().toISOString().split("T")[0],
    suites: suiteResults,
    totalPass: suiteResults.reduce((sum, s) => sum + s.pass, 0),
    totalFail: suiteResults.reduce((sum, s) => sum + s.fail, 0),
    totalSkip: suiteResults.reduce((sum, s) => sum + s.skip, 0),
    totalTasks: suiteResults.reduce((sum, s) => sum + s.pass + s.fail + s.skip, 0),
    durationMs: Date.now() - start,
  };

  printReport(report);

  // Exit with non-zero if any failures
  process.exit(report.totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
