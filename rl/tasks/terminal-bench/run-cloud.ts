/**
 * Submit our 5 TB tasks to OMA's cloud-side eval runner via POST /v1/evals/runs.
 *
 * Unlike rl/cli.ts rollout (local long-running), this script:
 *   1. Builds EvalTaskSpec[] from rl/tasks/terminal-bench/tasks/*.json
 *   2. POSTs the run (single quick HTTP)
 *   3. Polls GET /v1/evals/runs/:id at 30s interval until terminal
 *   4. For each trial, fetches session events and parses EXIT_CODE
 *   5. Writes ./results/cloud-pilot-<date>.json with per-task scoring
 *
 * Local memory stays bounded — no SSE accumulation, no per-event polling.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_URL = process.env.OMA_API_URL || "https://openma.dev";
const API_KEY = process.env.OMA_API_KEY || "";
const AGENT_ID = process.env.OMA_AGENT_ID || "";
const ENV_ID = process.env.OMA_ENV_ID || "";
const TASKS_DIR = process.env.TASKS_DIR || "rl/tasks/terminal-bench/tasks";
const OUT_PATH = process.env.OUT_PATH || `rl/tasks/terminal-bench/results/cloud-pilot-${new Date().toISOString().slice(0, 10)}.json`;
const RESUME_RUN_ID = process.env.RESUME_RUN_ID || "";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const MAX_WALL_MS = parseInt(process.env.MAX_WALL_MS || `${4 * 3600 * 1000}`, 10); // 4 hours

if (!API_KEY) throw new Error("OMA_API_KEY required");
if (!RESUME_RUN_ID) {
  if (!AGENT_ID) throw new Error("OMA_AGENT_ID required (or set RESUME_RUN_ID)");
  if (!ENV_ID) throw new Error("OMA_ENV_ID required (or set RESUME_RUN_ID)");
}

const headers = { "x-api-key": API_KEY, "content-type": "application/json" };

interface RLTaskFile {
  name: string;
  tasks: Array<{
    id: string;
    message: string;
    reward: { type: string; verify_script?: string };
    timeout_ms?: number;
  }>;
}

interface EvalTrialResult {
  trial_index: number;
  status: "pending" | "running" | "completed" | "failed";
  session_id?: string;
  trajectory_id?: string;
  error?: string;
  started_at?: string;
  ended_at?: string;
}

interface EvalTaskResult {
  id: string;
  status: string;
  trials: EvalTrialResult[];
  trial_pass_count?: number;
  trial_total?: number;
  error?: string;
}

interface EvalRunRecord {
  id: string;
  status: string;
  agent_id: string;
  environment_id: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: EvalTaskResult[];
  error?: string;
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method || "GET";
  const timeoutMs = method === "GET" ? 90_000 : 120_000;
  const maxRetries = 8;
  const baseDelay = 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers || {}) },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const transient = res.status === 429 || res.status >= 500;
        const msg = `API ${method} ${path} → ${res.status}: ${body.slice(0, 500)}`;
        if (transient && attempt < maxRetries) {
          console.warn(`[retry ${attempt + 1}/${maxRetries}] ${msg.slice(0, 150)}`);
          lastErr = new Error(msg);
        } else {
          throw new Error(msg);
        }
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const transient = isAbort || /ETIMEDOUT|ECONNRESET|fetch failed|EAI_AGAIN|network|socket hang up/i.test(msg);
      if (!transient || attempt >= maxRetries) {
        throw err;
      }
      console.warn(`[retry ${attempt + 1}/${maxRetries}] ${method} ${path}: ${msg.slice(0, 150)}`);
      lastErr = err;
    }
    const delay = Math.min(30_000, baseDelay * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastErr;
}

function loadTasks(): Array<{ id: string; message: string; verify_script: string; timeout_ms: number }> {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
  const out: Array<{ id: string; message: string; verify_script: string; timeout_ms: number }> = [];
  for (const f of files) {
    const data: RLTaskFile = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
    for (const t of data.tasks) {
      if (!t.reward.verify_script) {
        console.warn(`skipping ${t.id}: no verify_script`);
        continue;
      }
      out.push({
        id: t.id,
        message: t.message,
        verify_script: t.reward.verify_script,
        timeout_ms: t.timeout_ms || 1_800_000,
      });
    }
  }
  return out;
}

function verifierPrompt(verifyScript: string): string {
  return (
    "Run this exact bash script in the sandbox via the bash tool, then reply with " +
    "EXACTLY one line at the end: `EXIT_CODE=<n>` where <n> is the numeric exit " +
    "status of the script. Do not run anything else. Do not modify the script.\n\n" +
    "```bash\n" + verifyScript + "\n```"
  );
}

async function submit(tasks: ReturnType<typeof loadTasks>): Promise<string> {
  const body = {
    agent_id: AGENT_ID,
    environment_id: ENV_ID,
    tasks: tasks.map((t) => ({
      id: t.id,
      // Single message — m0 only. The verifier no longer goes through the
      // agent (was prone to over-explaining + ignoring the bash tool).
      // After trial.status === "completed" we POST /sandbox/exec separately
      // to run verify_script directly in the session's sandbox.
      messages: [t.message],
      timeout_ms: t.timeout_ms,
      trials: 1,
    })),
  };
  const result = await api<{ run_id: string; task_count: number }>("/v1/evals/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.run_id;
}

async function pollUntilTerminal(runId: string): Promise<EvalRunRecord> {
  const start = Date.now();
  let last: EvalRunRecord | null = null;
  while (Date.now() - start < MAX_WALL_MS) {
    const run = await api<EvalRunRecord>(`/v1/evals/runs/${runId}`);
    last = run;
    const summary = run.tasks
      .map((t) => {
        const trial = t.trials[0];
        const tag = trial?.current_message_index !== undefined
          ? `m${trial.current_message_index}`
          : "";
        return `${t.id.replace("tb-", "")}=${trial?.status || t.status}${tag ? `(${tag})` : ""}`;
      })
      .join(" ");
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${elapsed}s] run=${run.status} done=${run.completed_count}/${run.task_count} fail=${run.failed_count} | ${summary}`);
    if (run.status === "completed" || run.status === "failed") return run;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!last) throw new Error("never received status");
  console.warn(`max wall time exceeded; returning last snapshot status=${last.status}`);
  return last;
}

async function fetchSessionEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let afterSeq = 0;
  while (true) {
    const path = `/v1/sessions/${sessionId}/events?limit=1000&order=asc&after_seq=${afterSeq}`;
    const page = await api<{ data: Array<{ seq: number; data: unknown }>; has_more?: boolean }>(path);
    if (page.data.length === 0) break;
    for (const ev of page.data) {
      const parsed = typeof ev.data === "string" ? JSON.parse(ev.data) : (ev.data as Record<string, unknown>);
      all.push({ ...parsed, _seq: ev.seq });
      afterSeq = ev.seq;
    }
    if (!page.has_more) break;
  }
  return all;
}

function parseExitCode(events: Array<Record<string, unknown>>): { exit_code: number; output: string; agent_turns: number } {
  let allText = "";
  let agentTurns = 0;
  for (const e of events) {
    if (e.type === "agent.message") {
      agentTurns++;
      const blocks = (e.content as Array<Record<string, unknown>>) || [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") allText += b.text + "\n";
      }
    } else if (e.type === "agent.tool_result" && typeof e.content === "string") {
      allText += e.content + "\n";
    }
  }
  const matches = [...allText.matchAll(/EXIT_CODE=(-?\d+)/g)];
  const last = matches.length > 0 ? matches[matches.length - 1] : null;
  return {
    exit_code: last ? parseInt(last[1], 10) : -1,
    output: allText.slice(-2000),
    agent_turns: agentTurns,
  };
}

interface ScoredResult {
  task_id: string;
  trial_status: string;
  trial_error?: string;
  session_id?: string;
  trajectory_id?: string;
  agent_turns: number;
  verifier_exit_code: number;
  verifier_output_tail: string;
  reward: number;
  duration_s?: number;
}

async function score(run: EvalRunRecord, taskSpecs: ReturnType<typeof loadTasks>): Promise<ScoredResult[]> {
  const specByTaskId = new Map(taskSpecs.map((t) => [t.id, t]));
  const results: ScoredResult[] = [];
  for (const task of run.tasks) {
    const trial = task.trials[0];
    if (!trial?.session_id) {
      results.push({
        task_id: task.id,
        trial_status: trial?.status || task.status,
        trial_error: trial?.error || task.error,
        agent_turns: 0,
        verifier_exit_code: -1,
        verifier_output_tail: "(no session)",
        reward: 0,
      });
      continue;
    }

    // Count agent turns from events for trace metadata
    let agentTurns = 0;
    try {
      const events = await fetchSessionEvents(trial.session_id);
      for (const e of events) {
        if (e.type === "agent.message") agentTurns++;
      }
    } catch (err) {
      // Non-fatal — events fetch can 500 on broken sessions, scoring still works
      console.warn(`[score] events fetch failed for ${trial.session_id}: ${err}`);
    }

    // Run the verifier via raw sandbox exec — bypasses the agent entirely.
    // Uses the new POST /v1/sessions/:id/sandbox/exec endpoint added to
    // address the agent-as-verifier kludge (model would over-explain
    // instead of invoking the bash tool, leading to 30-min timeouts).
    const spec = specByTaskId.get(task.id);
    let exitCode = -1;
    let outputTail = "";
    if (!spec) {
      outputTail = "(no spec found locally — cannot verify)";
    } else if (trial.status !== "completed") {
      outputTail = `(trial ${trial.status} — skipping verifier)`;
    } else {
      try {
        const execRes = await api<{ exit_code: number; output: string; truncated?: boolean; error?: boolean }>(
          `/v1/sessions/${trial.session_id}/exec`,
          {
            method: "POST",
            body: JSON.stringify({ command: spec.verify_script, timeout_ms: 600_000 }),
          },
        );
        exitCode = execRes.exit_code;
        outputTail = (execRes.output ?? "").slice(-2000);
      } catch (err) {
        exitCode = -1;
        outputTail = `verifier exec error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    let durS: number | undefined;
    if (trial.started_at && trial.ended_at) {
      durS = Math.round((Date.parse(trial.ended_at) - Date.parse(trial.started_at)) / 1000);
    }
    results.push({
      task_id: task.id,
      trial_status: trial.status,
      trial_error: trial.error,
      session_id: trial.session_id,
      trajectory_id: trial.trajectory_id,
      agent_turns: agentTurns,
      verifier_exit_code: exitCode,
      verifier_output_tail: outputTail,
      reward: exitCode === 0 ? 1 : 0,
      duration_s: durS,
    });
  }
  return results;
}

async function main() {
  // Always load tasks locally so we can score via sandbox.exec even when resuming.
  const tasks = loadTasks();
  console.log(`loaded ${tasks.length} tasks from ${TASKS_DIR}`);

  let runId = RESUME_RUN_ID;
  if (!runId) {
    runId = await submit(tasks);
    console.log(`submitted run: ${runId}`);
  } else {
    console.log(`resuming run: ${runId}`);
  }

  const run = await pollUntilTerminal(runId);
  console.log(`run terminal: status=${run.status} completed=${run.completed_count}/${run.task_count}`);

  const results = await score(run, tasks);
  const summary = {
    run_id: run.id,
    run_status: run.status,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    started_at: run.started_at,
    ended_at: run.ended_at,
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    pass_count: results.filter((r) => r.reward === 1).length,
    results,
  };
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  console.log(`wrote ${OUT_PATH}`);
  console.log(`PASS: ${summary.pass_count}/${summary.task_count}`);
  for (const r of results) {
    console.log(
      `  ${r.task_id}: status=${r.trial_status} exit=${r.verifier_exit_code} reward=${r.reward} dur=${r.duration_s}s turns=${r.agent_turns}`,
    );
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
