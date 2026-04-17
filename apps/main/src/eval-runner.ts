// Eval runner — advances pending/running EvalRuns toward completion.
// Called from the Workers Cron scheduled handler every minute.
//
// State machine per run:
//   pending  → start_run() → running (creates first session for first task)
//   running  → poll all running tasks; advance idle ones to next task; mark
//             run completed when all tasks done
//
// Each task = a fresh session against the run's agent_id + environment_id.
// Setup files are written via a setup-message turn (same pattern as
// test/eval/runner.ts setupFiles helper). Then each user message in the spec
// is sent in sequence, waiting for idle between messages.

import type { Env, AgentConfig, EnvironmentConfig, SessionMeta, StoredEvent } from "@open-managed-agents/shared";
import { generateSessionId, buildTrajectory } from "@open-managed-agents/shared";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "./kv-helpers";
import type { EvalRunRecord, EvalTaskResult, EvalTaskSpec } from "./routes/evals";

// ---------- Sandbox helpers (mirrors routes/sessions.ts) ----------

async function getSandboxBinding(env: Env, environmentId: string, tenantId: string): Promise<Fetcher | null> {
  const envData = await env.CONFIG_KV.get(kvKey(tenantId, "env", environmentId));
  if (!envData) return null;
  const envConfig = JSON.parse(envData) as EnvironmentConfig;
  if (envConfig.status !== "ready" && envConfig.status !== undefined) return null;
  if (!envConfig.sandbox_worker_name) return null;
  const bindingName = `SANDBOX_${envConfig.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (env as unknown as Record<string, unknown>)[bindingName] as Fetcher | undefined;
  if (binding) return binding;

  // Fallback for combined-worker test mode
  if (env.SESSION_DO) {
    const localFetcher: Fetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
        if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
        const [, sessionId, rest] = match;
        const doId = env.SESSION_DO!.idFromName(sessionId);
        const stub = env.SESSION_DO!.get(doId);
        (stub as unknown as { setName?: (n: string) => void }).setName?.(sessionId);
        return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        }));
      },
      connect: () => { throw new Error("not implemented"); },
    } as unknown as Fetcher;
    return localFetcher;
  }
  return null;
}

function fwd(binding: Fetcher, path: string, method: string = "GET", body?: BodyInit | null): Promise<Response> {
  return binding.fetch(new Request(`https://sandbox${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? body : undefined,
  }));
}

// ---------- Run / task lifecycle ----------

async function loadRun(env: Env, tenantId: string, runId: string): Promise<EvalRunRecord | null> {
  const data = await env.CONFIG_KV.get(kvKey(tenantId, "evalrun", runId));
  return data ? (JSON.parse(data) as EvalRunRecord) : null;
}

async function saveRun(env: Env, run: EvalRunRecord): Promise<void> {
  await env.CONFIG_KV.put(kvKey(run.tenant_id, "evalrun", run.id), JSON.stringify(run));
}

async function removeFromActive(env: Env, runId: string): Promise<void> {
  await env.CONFIG_KV.delete(`evalrun_active:${runId}`);
}

async function createTaskSession(env: Env, run: EvalRunRecord, task: EvalTaskResult): Promise<string> {
  const t = run.tenant_id;
  const agentData = await env.CONFIG_KV.get(kvKey(t, "agent", run.agent_id));
  if (!agentData) throw new Error(`agent ${run.agent_id} not found`);
  const agentSnapshot = JSON.parse(agentData) as AgentConfig;
  const envSnapshotData = await env.CONFIG_KV.get(kvKey(t, "env", run.environment_id));
  const environmentSnapshot = envSnapshotData ? (JSON.parse(envSnapshotData) as EnvironmentConfig) : undefined;

  const sessionId = generateSessionId();
  const binding = await getSandboxBinding(env, run.environment_id, t);
  if (!binding) throw new Error(`environment ${run.environment_id} not ready`);

  await fwd(binding, `/sessions/${sessionId}/init`, "PUT", JSON.stringify({
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    session_id: sessionId,
    tenant_id: t,
    vault_ids: [],
  }));

  const session: SessionMeta = {
    id: sessionId,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    status: "idle",
    created_at: new Date().toISOString(),
  };
  const sessionRecord: SessionRecord = { ...session, agent_snapshot: agentSnapshot, environment_snapshot: environmentSnapshot };
  await env.CONFIG_KV.put(kvKey(t, "session", sessionId), JSON.stringify(sessionRecord));

  return sessionId;
}

async function postUserMessage(env: Env, run: EvalRunRecord, sessionId: string, text: string): Promise<void> {
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
  if (!binding) throw new Error("environment binding lost");
  // The agent worker exposes POST /sessions/:id/event (singular) — one event per call.
  await fwd(binding, `/sessions/${sessionId}/event`, "POST", JSON.stringify({
    type: "user.message",
    content: [{ type: "text", text }],
  }));
}

async function getSessionStatus(env: Env, run: EvalRunRecord, sessionId: string): Promise<string | null> {
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
  if (!binding) return null;
  try {
    const res = await fwd(binding, `/sessions/${sessionId}/status`, "GET");
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string };
    return data.status;
  } catch {
    return null;
  }
}

async function buildAndStoreTrajectory(env: Env, run: EvalRunRecord, sessionId: string): Promise<string> {
  const t = run.tenant_id;
  const sessionData = await env.CONFIG_KV.get(kvKey(t, "session", sessionId));
  if (!sessionData) throw new Error(`session ${sessionId} not found`);
  const session = JSON.parse(sessionData) as SessionRecord;
  const binding = await getSandboxBinding(env, run.environment_id, t);
  if (!binding) throw new Error("environment binding lost");

  const trajectory = await buildTrajectory(session, {
    fetchAllEvents: async (): Promise<StoredEvent[]> => {
      const all: StoredEvent[] = [];
      let afterSeq = 0;
      while (true) {
        const res = await fwd(binding, `/sessions/${sessionId}/events?limit=1000&order=asc&after_seq=${afterSeq}`, "GET");
        if (!res.ok) break;
        const body = (await res.json()) as { data?: StoredEvent[]; has_more?: boolean };
        const batch = body.data || [];
        all.push(...batch);
        if (!body.has_more || batch.length === 0) break;
        afterSeq = batch[batch.length - 1].seq;
      }
      return all;
    },
    fetchFullStatus: async (): Promise<FullStatus | null> => {
      const res = await fwd(binding, `/sessions/${sessionId}/full-status`, "GET");
      if (!res.ok) return null;
      return (await res.json()) as FullStatus;
    },
  });

  // Store trajectory under a stable key; for now use trajectory_id as the only key
  await env.CONFIG_KV.put(kvKey(t, "trajectory", trajectory.trajectory_id), JSON.stringify(trajectory));
  return trajectory.trajectory_id;
}

// ---------- Single-tick advance (per-trial) ----------

async function advanceTrial(
  env: Env,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: import("./routes/evals").EvalTrialResult,
): Promise<boolean> {
  // Returns true if any progress was made (caller should save).
  if (trial.status === "completed" || trial.status === "failed") return false;

  // Bootstrap: create session + send first message
  if (trial.status === "pending") {
    try {
      const sessionId = await createTaskSession(env, run, task);
      trial.session_id = sessionId;
      trial.status = "running";
      trial.started_at = new Date().toISOString();
      trial.current_message_index = 0;
      // Send first message immediately
      await postUserMessage(env, run, sessionId, task.spec.messages[0]);
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      return true;
    }
  }

  // trial.status === "running" — check current message progress
  if (!trial.session_id) {
    trial.status = "failed";
    trial.error = "running trial missing session_id";
    return true;
  }

  const status = await getSessionStatus(env, run, trial.session_id);
  if (status !== "idle") return false; // still running, wait

  // Session is idle; either send next message or finalize trajectory
  const nextIndex = (trial.current_message_index ?? 0) + 1;
  if (nextIndex < task.spec.messages.length) {
    try {
      await postUserMessage(env, run, trial.session_id, task.spec.messages[nextIndex]);
      trial.current_message_index = nextIndex;
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      return true;
    }
  }

  // All messages sent and session idle → build trajectory and finalize
  try {
    const trajectoryId = await buildAndStoreTrajectory(env, run, trial.session_id);
    trial.trajectory_id = trajectoryId;
    trial.status = "completed";
    trial.ended_at = new Date().toISOString();
    return true;
  } catch (err: unknown) {
    trial.status = "failed";
    trial.error = err instanceof Error ? err.message : String(err);
    trial.ended_at = new Date().toISOString();
    return true;
  }
}

async function advanceTask(env: Env, run: EvalRunRecord, task: EvalTaskResult): Promise<boolean> {
  if (task.status === "completed" || task.status === "failed") return false;

  // Advance every trial that's not terminal. Trials are independent — server
  // could parallelize, but we go sequentially within a tick to keep KV writes
  // serialized and respect bandwidth on shared sandbox.
  let progressed = false;
  for (const trial of task.trials) {
    if (trial.status === "pending" || trial.status === "running") {
      const changed = await advanceTrial(env, run, task, trial);
      if (changed) progressed = true;
    }
  }

  // Roll up trial states to task status
  const completed = task.trials.filter((t) => t.status === "completed").length;
  const failed = task.trials.filter((t) => t.status === "failed").length;
  task.trial_pass_count = completed;
  task.trial_total = task.trials.length;
  if (completed + failed === task.trials.length) {
    // All trials terminal. Aggregate as pass^k semantics: completed only when
    // every trial completed. Otherwise failed (downstream scorer can re-grade).
    if (completed === task.trials.length) {
      task.status = "completed";
    } else {
      task.status = "failed";
      task.error = task.trials.find((t) => t.error)?.error;
    }
  } else {
    task.status = "running";
  }
  return progressed;
}

async function advanceRun(env: Env, run: EvalRunRecord): Promise<void> {
  if (run.status === "completed" || run.status === "failed") {
    await removeFromActive(env, run.id);
    return;
  }

  if (run.status === "pending") {
    run.status = "running";
    run.started_at = new Date().toISOString();
  }

  // Advance every task that's not terminal. Iterate sequentially to avoid
  // creating many sessions in one tick — the cron will revisit later anyway.
  let progressed = false;
  for (const task of run.tasks) {
    if (task.status !== "pending" && task.status !== "running") continue;
    const changed = await advanceTask(env, run, task);
    if (changed) progressed = true;
  }

  // Recount terminal states
  run.completed_count = run.tasks.filter((t) => t.status === "completed").length;
  run.failed_count = run.tasks.filter((t) => t.status === "failed").length;

  if (run.completed_count + run.failed_count === run.task_count) {
    run.status = run.failed_count > 0 && run.completed_count === 0 ? "failed" : "completed";
    run.ended_at = new Date().toISOString();
    await saveRun(env, run);
    await removeFromActive(env, run.id);
    return;
  }

  if (progressed) await saveRun(env, run);
}

// ---------- Public entry point (called by scheduled handler) ----------

export async function tickEvalRuns(env: Env): Promise<{ advanced: number; total: number }> {
  const list = await env.CONFIG_KV.list({ prefix: "evalrun_active:" });
  let advanced = 0;
  for (const key of list.keys) {
    const runId = key.name.slice("evalrun_active:".length);
    const tenantId = await env.CONFIG_KV.get(key.name);
    if (!tenantId) continue;
    const run = await loadRun(env, tenantId, runId);
    if (!run) {
      await removeFromActive(env, runId);
      continue;
    }
    try {
      await advanceRun(env, run);
      advanced++;
    } catch (err: unknown) {
      // Mark the whole run failed if advance throws unrecoverably
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.ended_at = new Date().toISOString();
      await saveRun(env, run);
      await removeFromActive(env, runId);
    }
  }
  return { advanced, total: list.keys.length };
}
