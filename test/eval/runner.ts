import type {
  EvalTask,
  EvalTaskResult,
  EvalSuiteResult,
  EvalReport,
  VerifyResult,
  SSEEvent,
} from "./types.js";
import { DEFAULT_MODEL, DEFAULT_TIMEOUT } from "./types.js";
import {
  createAgent,
  createSession,
  deleteAgent,
  deleteSession,
  getOrCreateEnvironment,
  sendAndWait,
  setupFiles,
} from "./client.js";

// ---- Import suites ----

import { toolUseSuite } from "./suites/tool-use.js";
import { codingSuite } from "./suites/coding.js";
import { multiStepSuite } from "./suites/multi-step.js";
import { errorRecoverySuite } from "./suites/error-recovery.js";
import { multiAgentSuite } from "./suites/multi-agent.js";

const ALL_SUITES: Record<string, EvalTask[]> = {
  "tool-use": toolUseSuite,
  coding: codingSuite,
  "multi-step": multiStepSuite,
  "error-recovery": errorRecoverySuite,
  "multi-agent": multiAgentSuite,
};

// ---- CLI arg parsing ----

function parseArgs(): { suite?: string; task?: string; concurrency: number } {
  const args = process.argv.slice(2);
  let suite: string | undefined;
  let task: string | undefined;
  let concurrency = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--suite" && args[i + 1]) suite = args[++i];
    if (args[i] === "--task" && args[i + 1]) task = args[++i];
    if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i], 10);
  }

  return { suite, task, concurrency };
}

// ---- Task execution ----

async function runTask(task: EvalTask): Promise<EvalTaskResult> {
  const start = Date.now();
  const turnResults: VerifyResult[] = [];
  const agentIds: string[] = [];
  const sessionIds: string[] = [];

  try {
    const envId = await getOrCreateEnvironment();

    // Create sub-agents (for multi-agent tasks)
    const callableAgents: Array<{ type: "agent"; id: string }> = [];
    if (task.subAgents) {
      for (const sub of task.subAgents) {
        const subId = await createAgent({
          name: `eval-sub-${sub.name}-${Date.now()}`,
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
      name: `eval-${task.id}-${Date.now()}`,
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
      log(task.id, "Setting up fixture files...");
      await setupFiles(sessionId, task.setupFiles);
    }

    // Execute turns
    const allEvents: SSEEvent[] = [];
    for (let i = 0; i < task.turns.length; i++) {
      const turn = task.turns[i];
      log(task.id, `Turn ${i + 1}/${task.turns.length}: sending message...`);

      const events = await sendAndWait(sessionId, turn.message, task.timeoutMs || DEFAULT_TIMEOUT);
      allEvents.push(...events);

      const result = turn.verify(events);
      turnResults.push(result);
      log(task.id, `Turn ${i + 1} → ${result.status}: ${result.message}`);

      if (result.status === "fail") {
        return {
          taskId: task.id,
          category: task.category,
          difficulty: task.difficulty,
          status: "fail",
          message: `Turn ${i + 1} failed: ${result.message}`,
          durationMs: Date.now() - start,
          turnResults,
          error: result.details?.join("\n"),
        };
      }
    }

    // Final verification
    if (task.finalVerify) {
      const finalResult = task.finalVerify(allEvents);
      turnResults.push(finalResult);
      if (finalResult.status === "fail") {
        return {
          taskId: task.id,
          category: task.category,
          difficulty: task.difficulty,
          status: "fail",
          message: `Final verification failed: ${finalResult.message}`,
          durationMs: Date.now() - start,
          turnResults,
        };
      }
    }

    return {
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      status: "pass",
      message: "All turns passed",
      durationMs: Date.now() - start,
      turnResults,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      status: "fail",
      message: `Error: ${msg}`,
      durationMs: Date.now() - start,
      turnResults,
      error: msg,
    };
  } finally {
    // Only cleanup on success — keep failed sessions for debugging
    if (turnResults.every((r) => r.status === "pass")) {
      for (const sid of sessionIds) await deleteSession(sid);
      for (const aid of agentIds) await deleteAgent(aid);
    } else {
      console.log(`    [cleanup] Keeping session(s) for debugging: ${sessionIds.join(", ")}`);
      for (const aid of agentIds) await deleteAgent(aid);
    }
  }
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

// ---- Main ----

async function main() {
  const { suite, task, concurrency } = parseArgs();

  console.log("OMA Eval Runner");
  console.log(`API: ${process.env.OMA_API_URL || "http://localhost:8787"}`);
  console.log(`Filter: ${suite ? `suite=${suite}` : task ? `task=${task}` : "all"}`);

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
