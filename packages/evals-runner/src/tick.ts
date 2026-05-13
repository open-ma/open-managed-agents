// Eval runner — advances pending/running EvalRuns toward completion.
// Runtime-agnostic: the CF cron handler and the Node scheduler both
// invoke `tickEvalRuns(ctx)` once per cron tick.
//
// State machine per run:
//   pending → start_run() → running (creates first session for first task)
//   running → poll all running tasks; advance idle ones to next task; mark
//             run completed when all tasks done
//
// Each task = a fresh session against the run's agent_id + environment_id.
// On bootstrap we (1) create the session, (2) write any declared setup_files
// directly to /workspace via raw /exec (NOT through the agent), then (3)
// send the spec's first user message and wait for idle, repeating for each
// subsequent message.

import {
  buildTrajectory,
  verifierForSpec,
  NoRunVerifier,
  logWarn,
  type StoredEvent,
  type Trajectory,
  type RewardResult,
  type VerifierContext,
  type SessionRecord,
  type FullStatus,
} from "@open-managed-agents/shared";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { EvalRunService } from "@open-managed-agents/evals-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import {
  type EvalRunRecord,
  type EvalTaskResult,
  type EvalTrialResult,
  rowToRecord,
  extractResults,
  kvKey,
} from "./types";

/** Narrow services shape — just what the runner actually touches.
 *  Keeps the package decoupled from packages/services. CF satisfies
 *  this from buildCfServices(); Node from its own bundle. */
export interface EvalRunnerServices {
  agents: AgentService;
  environments: EnvironmentService;
  sessions: SessionService;
  evals: EvalRunService;
  kv: KvStore;
}

/**
 * Minimal Fetcher shape — both CF service bindings and Node test fakes
 * satisfy this. Defined here so the package doesn't depend on
 * @cloudflare/workers-types.
 */
export interface SandboxFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Runtime-supplied context for the eval-runner. CF builds this from
 * `env` (binding lookups by name); Node builds it from its services
 * + a no-op sandbox resolver until cloud environments land on Node.
 */
export interface EvalRunnerContext {
  /** Cross-shard fan-out. CF passes `(fn) => forEachShardServices(env, fn)`;
   *  Node passes `(fn) => fn(services).then((r) => [r])`. */
  forEachShard: <T>(
    fn: (services: EvalRunnerServices) => Promise<T>,
  ) => Promise<T[]>;
  /** Per-tenant services accessor (cached per call). CF uses
   *  getCfServicesForTenant; Node returns its single Services instance. */
  getServicesForTenant: (tenantId: string) => Promise<EvalRunnerServices>;
  /** Resolve the sandbox Fetcher for a (tenant, environment). Returns
   *  null if the environment is unknown / not ready / not mapped to a
   *  binding on this runtime. */
  getSandboxBinding: (
    tenantId: string,
    environmentId: string,
  ) => Promise<SandboxFetcher | null>;
}

// ---------- Sandbox fetch helper ----------

function fwd(
  binding: SandboxFetcher,
  path: string,
  method: string = "GET",
  body?: BodyInit | null,
): Promise<Response> {
  return binding.fetch(new Request(`https://sandbox${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? body : undefined,
  }));
}

// ---------- Run / task lifecycle ----------

async function loadRun(
  ctx: EvalRunnerContext,
  tenantId: string,
  runId: string,
): Promise<EvalRunRecord | null> {
  const services = await ctx.getServicesForTenant(tenantId);
  const row = await services.evals.get({ tenantId, runId });
  if (!row) return null;
  return rowToRecord(row);
}

async function saveRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  const services = await ctx.getServicesForTenant(run.tenant_id);
  if (run.status === "completed" || run.status === "failed") {
    await services.evals.markCompleted({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error,
    });
  } else {
    await services.evals.update({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error ?? null,
    });
  }
}

async function createTaskSession(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
): Promise<string> {
  const t = run.tenant_id;
  const services = await ctx.getServicesForTenant(t);
  const agentRow = await services.agents.get({ tenantId: t, agentId: run.agent_id });
  if (!agentRow) throw new Error(`agent ${run.agent_id} not found`);
  const { tenant_id: _atid, ...agentSnapshot } = agentRow;
  const envRow = await services.environments.get({ tenantId: t, environmentId: run.environment_id });
  const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;

  const binding = await ctx.getSandboxBinding(t, run.environment_id);
  if (!binding) throw new Error(`environment ${run.environment_id} not ready`);

  const { session } = await services.sessions.create({
    tenantId: t,
    agentId: run.agent_id,
    environmentId: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    agentSnapshot,
    environmentSnapshot,
  });
  const sessionId = session.id;

  // Tag the session metadata so Console picks eval sessions out of the
  // general session list (mirrors Linear / Slack metadata pattern).
  try {
    await services.sessions.update({
      tenantId: t,
      sessionId,
      metadata: { eval: { run_id: run.id, task_id: task.id } },
    });
  } catch (err) {
    logWarn(
      { op: "eval.session.tag", session_id: sessionId, run_id: run.id, task_id: task.id, err },
      "eval session metadata tag failed; session usable but won't show eval badge in console",
    );
  }

  await fwd(binding, `/sessions/${sessionId}/init`, "PUT", JSON.stringify({
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    session_id: sessionId,
    tenant_id: t,
    vault_ids: [],
  }));

  return sessionId;
}

async function postUserMessage(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  text: string,
): Promise<void> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");
  await fwd(binding, `/sessions/${sessionId}/event`, "POST", JSON.stringify({
    type: "user.message",
    content: [{ type: "text", text }],
  }));
}

async function writeSetupFiles(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");

  for (const f of files) {
    if (!f.path.startsWith("/")) {
      throw new Error(`setup_files path must be absolute, got "${f.path}"`);
    }
    const sentinel = `OMA_SETUP_EOF_${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
    if (f.content.includes(sentinel)) {
      throw new Error(`setup_files heredoc sentinel collision for ${f.path} (impossible — re-run)`);
    }
    const lastSlash = f.path.lastIndexOf("/");
    const dir = lastSlash > 0 ? f.path.slice(0, lastSlash) : "/";
    const command = [
      `mkdir -p ${shellQuote(dir)}`,
      `cat > ${shellQuote(f.path)} <<'${sentinel}'`,
      f.content,
      sentinel,
    ].join("\n");
    const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
      command,
      timeout_ms: 30_000,
    }));
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`setup_files write failed for ${f.path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { exit_code?: number; output?: string };
    if (data.exit_code !== 0) {
      throw new Error(`setup_files write exit=${data.exit_code} for ${f.path}: ${(data.output ?? "").slice(0, 200)}`);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runSetupScript(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  script: string,
): Promise<void> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");
  const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
    command: script,
    timeout_ms: 30 * 60 * 1000,
  }));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`setup_script HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { exit_code?: number; output?: string };
  if (data.exit_code !== 0) {
    throw new Error(
      `setup_script exit=${data.exit_code}: ${(data.output ?? "").slice(0, 4000)}`,
    );
  }
}

async function getSessionStatus(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
): Promise<string | null> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) return null;
  try {
    const res = await fwd(binding, `/sessions/${sessionId}/status`, "GET");
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string };
    return data.status;
  } catch (err) {
    logWarn(
      { op: "eval.fetch_session_status", session_id: sessionId, err },
      "session status fetch failed; treating as unknown",
    );
    return null;
  }
}

function buildVerifierContext(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
): VerifierContext {
  return {
    sessionId,
    runExec: async (cmd, opts) => {
      const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
      if (!binding) throw new Error("environment binding lost");
      const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
        command: cmd,
        timeout_ms: opts?.timeoutMs ?? 600_000,
      }));
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { exit_code: -1, output: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = (await res.json()) as { exit_code?: number; output?: string };
      return { exit_code: data.exit_code ?? -1, output: data.output ?? "" };
    },
  };
}

async function runVerifier(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  trajectory: Trajectory,
): Promise<RewardResult> {
  const computedAt = new Date().toISOString();
  const reward = task.spec.reward;

  if (!reward) {
    return {
      raw_rewards: { outcome: 1 },
      final_reward: 1,
      verifier_id: "eval-runner.trial-status.v1",
      computed_at: computedAt,
    };
  }

  const vctx = buildVerifierContext(ctx, run, sessionId);
  let verifier;
  try {
    verifier = verifierForSpec(reward, vctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.verifier.spec_invalid", run_id: run.id, task_id: task.spec.id, err: msg },
      "verifier spec rejected; recording 0 reward",
    );
    return {
      raw_rewards: { spec_invalid: 0 },
      final_reward: 0,
      verifier_id: "verifier-spec-invalid.v1",
      computed_at: computedAt,
    };
  }

  let score;
  try {
    score = await verifier.check(trajectory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.verifier.check_threw", run_id: run.id, task_id: task.spec.id, verifier_id: verifier.id, err: msg },
      "verifier check threw; recording 0 reward",
    );
    return {
      raw_rewards: { verifier_error: 0 },
      final_reward: 0,
      verifier_id: verifier.id,
      computed_at: computedAt,
    };
  }

  const criteria = (score.metadata as { criteria?: Record<string, number> } | undefined)?.criteria;
  const rawRewards = criteria && Object.keys(criteria).length > 0
    ? criteria
    : { value: score.value };
  const persisted: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawRewards)) {
    if (typeof v === "number" && Number.isFinite(v)) persisted[k] = v;
  }

  return {
    raw_rewards: persisted,
    final_reward: score.value,
    verifier_id: verifier.id,
    computed_at: computedAt,
  };
}

async function synthesizeNoRunReward(reasonHint: string): Promise<RewardResult> {
  const verifier = new NoRunVerifier(reasonHint);
  const score = await verifier.check({} as Trajectory);
  return {
    raw_rewards: { failure: 0 },
    final_reward: score.value,
    verifier_id: verifier.id,
    computed_at: new Date().toISOString(),
  };
}

async function buildAndStoreTrajectory(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  reward: RewardResult,
  outcomeOverride?: Trajectory["outcome"],
): Promise<{ trajectory_id: string; final_reward: number }> {
  const t = run.tenant_id;
  const services = await ctx.getServicesForTenant(t);
  const sessionRow = await services.sessions.get({ tenantId: t, sessionId });
  if (!sessionRow) throw new Error(`session ${sessionId} not found`);
  const session = {
    id: sessionRow.id,
    agent_id: sessionRow.agent_id,
    environment_id: sessionRow.environment_id,
    title: sessionRow.title,
    status: sessionRow.status,
    created_at: sessionRow.created_at,
    updated_at: sessionRow.updated_at ?? undefined,
    archived_at: sessionRow.archived_at ?? undefined,
    vault_ids: sessionRow.vault_ids ?? undefined,
    metadata: sessionRow.metadata ?? undefined,
    agent_snapshot: sessionRow.agent_snapshot ?? undefined,
    environment_snapshot: sessionRow.environment_snapshot ?? undefined,
  } as SessionRecord;
  const binding = await ctx.getSandboxBinding(t, run.environment_id);
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

  // Trajectory v1 envelope enrichment — task_id / group_id / outcome /
  // reward all wired BEFORE storage so the persisted trajectory is
  // self-describing. Phase 3 (Console UI) reads these directly.
  trajectory.task_id = task.spec.id;
  trajectory.group_id = run.id;
  if (outcomeOverride) {
    trajectory.outcome = outcomeOverride;
  } else if (trial.error && /timeout/i.test(trial.error)) {
    trajectory.outcome = "timeout";
  }
  trajectory.reward = reward;

  // Trajectory storage goes through services.kv (CF: CONFIG_KV; Node:
  // SqlKvStore). Same key shape both runtimes.
  await services.kv.put(kvKey(t, "trajectory", trajectory.trajectory_id), JSON.stringify(trajectory));
  return { trajectory_id: trajectory.trajectory_id, final_reward: reward.final_reward };
}

async function persistFailureTrajectory(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  outcome: Trajectory["outcome"],
  reasonHint: string,
): Promise<void> {
  try {
    const reward = await synthesizeNoRunReward(reasonHint);
    const result = await buildAndStoreTrajectory(ctx, run, task, trial, sessionId, reward, outcome);
    trial.trajectory_id = result.trajectory_id;
    trial.reward = result.final_reward;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.failure_trajectory.skip", run_id: run.id, task_id: task.spec.id, session_id: sessionId, err: msg },
      "could not build failure-trial trajectory; trial.failed without trajectory_id",
    );
  }
}

// ---------- Single-tick advance (per-trial) ----------

async function advanceTrial(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
): Promise<boolean> {
  if (trial.status === "completed" || trial.status === "failed") return false;

  if (trial.status === "pending") {
    let sessionId: string | undefined;
    try {
      sessionId = await createTaskSession(ctx, run, task);
      trial.session_id = sessionId;
      trial.status = "running";
      trial.started_at = new Date().toISOString();
      trial.current_message_index = 0;
      if (task.spec.setup_files && task.spec.setup_files.length > 0) {
        await writeSetupFiles(ctx, run, sessionId, task.spec.setup_files);
      }
      if (task.spec.setup_script && task.spec.setup_script.trim().length > 0) {
        await runSetupScript(ctx, run, sessionId, task.spec.setup_script);
      }
      await postUserMessage(ctx, run, sessionId, task.spec.messages[0]);
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      if (sessionId) {
        await persistFailureTrajectory(ctx, run, task, trial, sessionId, "failure", trial.error);
      }
      return true;
    }
  }

  if (!trial.session_id) {
    trial.status = "failed";
    trial.error = "running trial missing session_id";
    return true;
  }

  const timeoutMs = task.spec.timeout_ms ?? 3_600_000;
  if (trial.started_at) {
    const elapsed = Date.now() - Date.parse(trial.started_at);
    if (elapsed > timeoutMs) {
      trial.status = "failed";
      trial.error = `trial timeout: ${Math.round(elapsed / 1000)}s exceeded budget ${Math.round(timeoutMs / 1000)}s (m_idx=${trial.current_message_index ?? 0})`;
      trial.ended_at = new Date().toISOString();
      await persistFailureTrajectory(ctx, run, task, trial, trial.session_id, "timeout", trial.error);
      return true;
    }
  }

  const status = await getSessionStatus(ctx, run, trial.session_id);
  if (status !== "idle") return false;

  const nextIndex = (trial.current_message_index ?? 0) + 1;
  if (nextIndex < task.spec.messages.length) {
    try {
      await postUserMessage(ctx, run, trial.session_id, task.spec.messages[nextIndex]);
      trial.current_message_index = nextIndex;
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      await persistFailureTrajectory(ctx, run, task, trial, trial.session_id, "failure", trial.error);
      return true;
    }
  }

  // All messages sent and session idle → build trajectory + run verifier.
  try {
    const placeholder = await synthesizeNoRunReward("pre-verify placeholder");
    const built = await buildAndStoreTrajectory(ctx, run, task, trial, trial.session_id, placeholder);
    const t = run.tenant_id;
    const services = await ctx.getServicesForTenant(t);
    const stored = await services.kv.get(kvKey(t, "trajectory", built.trajectory_id));
    if (!stored) throw new Error(`trajectory ${built.trajectory_id} disappeared after store`);
    const trajectory = JSON.parse(stored) as Trajectory;
    const reward = await runVerifier(ctx, run, task, trial, trial.session_id, trajectory);
    trajectory.reward = reward;
    await services.kv.put(
      kvKey(t, "trajectory", built.trajectory_id),
      JSON.stringify(trajectory),
    );

    trial.trajectory_id = built.trajectory_id;
    trial.status = "completed";
    trial.ended_at = new Date().toISOString();
    trial.reward = reward.final_reward;
    return true;
  } catch (err: unknown) {
    // Bounded retry: events fetch can transiently 500 under storage
    // contention. 3 attempts × ~60s cron ≈ 3 min before giving up.
    const msg = err instanceof Error ? err.message : String(err);
    trial.finalize_retry_count = (trial.finalize_retry_count ?? 0) + 1;
    if (trial.finalize_retry_count >= 3) {
      trial.status = "failed";
      trial.error = `events_unavailable_during_finalize (${trial.finalize_retry_count} attempts): ${msg.slice(0, 200)}`;
      trial.ended_at = new Date().toISOString();
    }
    return true;
  }
}

async function advanceTask(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
): Promise<boolean> {
  if (task.status === "completed" || task.status === "failed") return false;

  let progressed = false;
  for (const trial of task.trials) {
    if (trial.status === "pending" || trial.status === "running") {
      const changed = await advanceTrial(ctx, run, task, trial);
      if (changed) progressed = true;
    }
  }

  const completed = task.trials.filter((t) => t.status === "completed").length;
  const failed = task.trials.filter((t) => t.status === "failed").length;
  task.trial_pass_count = completed;
  task.trial_total = task.trials.length;
  if (completed + failed === task.trials.length) {
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

async function advanceRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  if (run.status === "completed" || run.status === "failed") return;

  if (run.status === "pending") {
    run.status = "running";
    run.started_at = new Date().toISOString();
  }

  let progressed = false;
  for (const task of run.tasks) {
    if (task.status !== "pending" && task.status !== "running") continue;
    const changed = await advanceTask(ctx, run, task);
    if (changed) progressed = true;
  }

  run.completed_count = run.tasks.filter((t) => t.status === "completed").length;
  run.failed_count = run.tasks.filter((t) => t.status === "failed").length;

  if (run.completed_count + run.failed_count === run.task_count) {
    run.status = run.failed_count > 0 && run.completed_count === 0 ? "failed" : "completed";
    run.ended_at = new Date().toISOString();
    await saveRun(ctx, run);
    return;
  }

  if (progressed) await saveRun(ctx, run);
}

// ---------- Public entry point ----------

/**
 * Cross-shard scan: list active eval runs on every shard via the
 * services-level fan-out abstraction, advance each one, save updated
 * state back. Called by the cron tick on both runtimes.
 */
export async function tickEvalRuns(
  ctx: EvalRunnerContext,
): Promise<{ advanced: number; total: number }> {
  let advanced = 0;
  let total = 0;
  const perShard = await ctx.forEachShard(async (services) => {
    const activeRows = await services.evals.listActive();
    return activeRows;
  });
  for (const activeRows of perShard) {
    total += activeRows.length;
    for (const row of activeRows) {
      const run = rowToRecord(row);
      try {
        await advanceRun(ctx, run);
        advanced++;
      } catch (err: unknown) {
        run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
        run.ended_at = new Date().toISOString();
        await saveRun(ctx, run);
      }
    }
  }
  return { advanced, total };
}

export { loadRun };
