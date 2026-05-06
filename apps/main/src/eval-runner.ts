// Eval runner — advances pending/running EvalRuns toward completion.
// Called from the Workers Cron scheduled handler every minute.
//
// State machine per run:
//   pending  → start_run() → running (creates first session for first task)
//   running  → poll all running tasks; advance idle ones to next task; mark
//             run completed when all tasks done
//
// Each task = a fresh session against the run's agent_id + environment_id.
// On bootstrap we (1) create the session, (2) write any declared setup_files
// directly to /workspace via raw /exec (NOT through the agent — see
// writeSetupFiles below), then (3) send the spec's first user message and
// wait for idle, repeating for each subsequent message.

import type { Env, AgentConfig, EnvironmentConfig, StoredEvent, Trajectory, RewardResult, VerifierContext } from "@open-managed-agents/shared";
import { buildTrajectory, verifierForSpec, NoRunVerifier } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";
import { buildCfServices, getCfServicesForTenant, type Services } from "@open-managed-agents/services";
import type { EvalRunRow, EvalRunStatus } from "@open-managed-agents/evals-store";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import { kvKey } from "./kv-helpers";
import type { EvalRunRecord, EvalTaskResult, EvalTaskSpec, EvalTrialResult } from "./routes/evals";

// ---------- Sandbox helpers (mirrors routes/sessions.ts) ----------

async function getSandboxBinding(env: Env, environmentId: string, tenantId: string): Promise<Fetcher | null> {
  const services = await getServices(env, tenantId);
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow) return null;
  const envConfig = toEnvironmentConfig(envRow);
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

// ---------- Services accessor (cached per tenant per worker isolate) ----------

const servicesCache = new Map<string, Services>();
async function getServices(env: Env, tenantId: string): Promise<Services> {
  let cached = servicesCache.get(tenantId);
  if (!cached) {
    cached = await getCfServicesForTenant(env, tenantId);
    servicesCache.set(tenantId, cached);
  }
  return cached;
}

// ---------- Run / task lifecycle ----------

/**
 * Translate an EvalRunRow (D1 storage shape) to the legacy EvalRunRecord
 * (route + advanceRun consumer shape). The mutable per-tick state lives in
 * the opaque `results` JSON column.
 */
function rowToRecord(row: EvalRunRow): EvalRunRecord {
  const partial = (row.results ?? {}) as Partial<EvalRunRecord>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    environment_id: row.environment_id,
    status: row.status as EvalRunStatus,
    created_at: row.started_at,
    started_at: row.started_at,
    ended_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
  };
}

/**
 * Reverse mapping: extract the per-tick mutable state from the in-memory
 * EvalRunRecord into the opaque `results` JSON blob the store persists.
 */
function extractResults(run: EvalRunRecord): unknown {
  return {
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    tasks: run.tasks,
  };
}

async function loadRun(env: Env, tenantId: string, runId: string): Promise<EvalRunRecord | null> {
  const services = await getServices(env, tenantId);
  const row = await services.evals.get({ tenantId, runId });
  if (!row) return null;
  return rowToRecord(row);
}

async function saveRun(env: Env, run: EvalRunRecord): Promise<void> {
  const services = await getServices(env, run.tenant_id);
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

async function createTaskSession(env: Env, run: EvalRunRecord, task: EvalTaskResult): Promise<string> {
  const t = run.tenant_id;
  const services = await getServices(env, t);
  const agentRow = await services.agents.get({ tenantId: t, agentId: run.agent_id });
  if (!agentRow) throw new Error(`agent ${run.agent_id} not found`);
  const { tenant_id: _atid, ...agentSnapshot } = agentRow;
  const envRow = await services.environments.get({ tenantId: t, environmentId: run.environment_id });
  const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;

  const binding = await getSandboxBinding(env, run.environment_id, t);
  if (!binding) throw new Error(`environment ${run.environment_id} not ready`);

  // Allocate the session row first (id comes from the store), then init the
  // sandbox with that id. Single D1 INSERT replaces the legacy KV.put.
  const { session } = await services.sessions.create({
    tenantId: t,
    agentId: run.agent_id,
    environmentId: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    agentSnapshot,
    environmentSnapshot,
  });
  const sessionId = session.id;

  // Tag the session so the Console can pick eval sessions out of the
  // general session list (mirrors the Linear / Slack metadata pattern).
  // Console's SessionsList renders an EvalBadge linking back to the run.
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

async function postUserMessage(env: Env, run: EvalRunRecord, sessionId: string, text: string): Promise<void> {
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
  if (!binding) throw new Error("environment binding lost");
  // The agent worker exposes POST /sessions/:id/event (singular) — one event per call.
  await fwd(binding, `/sessions/${sessionId}/event`, "POST", JSON.stringify({
    type: "user.message",
    content: [{ type: "text", text }],
  }));
}

/**
 * Write declared `setup_files` directly to the sandbox via /exec, BEFORE the
 * first user message. Bypasses the agent — eval-runner-side files are
 * deterministic infra, not something we want the model to try to recreate
 * (would slow down + waste tokens + occasionally drop or rewrite content).
 *
 * Path safety: each `path` is validated to start with `/` (absolute) and
 * contain no `'` (the heredoc body is single-quoted; collisions would break
 * the parse). Content is heredoc-passed via a sentinel that includes a
 * random hex tail, so collisions with file content are vanishingly
 * improbable and would surface as a non-zero exit (loud failure, not silent
 * truncation).
 *
 * Failure mode: if any file write fails the whole trial is marked failed.
 * We do NOT silently continue — the test would run on incomplete state and
 * mislead the eval. setup_files is a contract, not a hint.
 */
async function writeSetupFiles(
  env: Env,
  run: EvalRunRecord,
  sessionId: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
  if (!binding) throw new Error("environment binding lost");

  for (const f of files) {
    if (!f.path.startsWith("/")) {
      throw new Error(`setup_files path must be absolute, got "${f.path}"`);
    }
    // Random heredoc sentinel — short hex tail keeps the chance of collision
    // with file content effectively zero. If a setup file legitimately
    // contains the sentinel we throw rather than silently truncating.
    const sentinel = `OMA_SETUP_EOF_${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
    if (f.content.includes(sentinel)) {
      throw new Error(`setup_files heredoc sentinel collision for ${f.path} (impossible — re-run)`);
    }
    // mkdir -p <dirname> ; cat > <path> <<'<sentinel>'\n<content>\n<sentinel>
    // Single-quoted sentinel disables expansion inside the body, so $vars,
    // backticks, etc. in user content are preserved verbatim.
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
  // POSIX-safe single-quote: replace any embedded ' with '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the spec's `setup_script` in the sandbox via /exec, BEFORE the first
 * user.message. Mirrors writeSetupFiles in spirit — env prep that should
 * not pollute the agent trajectory. Failure marks the trial failed
 * synchronously; the agent never sees a half-staged container.
 *
 * 30-minute hard timeout matches BG_TASK_MAX_LIFETIME_MS in the sandbox
 * runtime — long-enough for git clone of large repos + pip install of
 * heavy ML deps + dataset downloads, short-enough that a stuck setup
 * doesn't burn container compute forever.
 */
async function runSetupScript(
  env: Env,
  run: EvalRunRecord,
  sessionId: string,
  script: string,
): Promise<void> {
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
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

async function getSessionStatus(env: Env, run: EvalRunRecord, sessionId: string): Promise<string | null> {
  const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
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

/**
 * Build a VerifierContext that lets a Verifier reach back into the agent
 * sandbox via /exec. Used by `script` + (future) `composite` Verifiers.
 * Stays a function (not closure-captured at module scope) so each call
 * resolves the binding fresh — environments can re-enter ready/not-ready
 * state during a long run.
 */
function buildVerifierContext(env: Env, run: EvalRunRecord, sessionId: string): VerifierContext {
  return {
    sessionId,
    runExec: async (cmd, opts) => {
      const binding = await getSandboxBinding(env, run.environment_id, run.tenant_id);
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

/**
 * Run the trial's RewardSpec against the built trajectory and return a
 * RewardResult ready to drop into `Trajectory.reward`. When no spec is
 * declared on the task, fall back to the Phase 1 placeholder (idle =
 * pass) so existing eval runs keep producing the same reward semantics.
 */
async function runVerifier(
  env: Env,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  trajectory: Trajectory,
): Promise<RewardResult> {
  const computedAt = new Date().toISOString();
  const reward = task.spec.reward;

  // No spec → Phase 1 fallback. "Trial reached idle without timeout/error"
  // is the implicit verifier; eval-runner gates this entry point on that
  // being true, so always 1. Marked with a stable verifier_id so consumers
  // can distinguish unconfigured-task rewards from real verifier output.
  if (!reward) {
    return {
      raw_rewards: { outcome: 1 },
      final_reward: 1,
      verifier_id: "eval-runner.trial-status.v1",
      computed_at: computedAt,
    };
  }

  const ctx = buildVerifierContext(env, run, sessionId);
  let verifier;
  try {
    verifier = verifierForSpec(reward, ctx);
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

  // Translate Score → RewardResult. `criteria` (if provided by the
  // verifier) is the breakdown; otherwise we reify a single-key map so
  // downstream code (Console reward bar, RL reward stats) sees a stable
  // shape regardless of which Verifier produced it.
  const criteria = (score.metadata as { criteria?: Record<string, number> } | undefined)?.criteria;
  const rawRewards = criteria && Object.keys(criteria).length > 0
    ? criteria
    : { value: score.value };
  // Avoid mutating verifier-owned structures (CompositeVerifier reuses
  // `criteria` across its own metadata and downstream propagation).
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

/**
 * Synthesize a RewardResult for a failure trial — there's no useful
 * execution to grade, so we tag the trajectory with NoRunVerifier so
 * Console / RL stats can distinguish "scored 0" from "never scored".
 */
async function synthesizeNoRunReward(reasonHint: string): Promise<RewardResult> {
  // NoRunVerifier ignores its trajectory arg; we still call it so the
  // reward field is built via the same Verifier abstraction as everything
  // else (one code path = one shape).
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
  env: Env,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  reward: RewardResult,
  outcomeOverride?: Trajectory["outcome"],
): Promise<{ trajectory_id: string; final_reward: number }> {
  const t = run.tenant_id;
  const services = await getServices(env, t);
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

  // --- Trajectory v1 envelope enrichment ---
  // Wire eval-runner-owned fields into the envelope BEFORE storage so the
  // persisted trajectory carries reward / task_id / group_id / a corrected
  // outcome on its own. Phase 3 (Console UI) will read these directly.

  // task_id / group_id — eval-runner is the only caller that knows them.
  trajectory.task_id = task.spec.id;
  trajectory.group_id = run.id;

  // outcome override — `deriveOutcome` can't see eval-runner's wall-clock
  // budget or setup-error short-circuits. Caller passes the right outcome
  // when known (timeout / failure on bootstrap-error trials). Otherwise
  // we infer from the trial's error string for the "trial timeout" path.
  if (outcomeOverride) {
    trajectory.outcome = outcomeOverride;
  } else if (trial.error && /timeout/i.test(trial.error)) {
    trajectory.outcome = "timeout";
  }

  trajectory.reward = reward;

  // Store trajectory under a stable key; for now use trajectory_id as the only key
  await services.kv.put(kvKey(t, "trajectory", trajectory.trajectory_id), JSON.stringify(trajectory));
  return { trajectory_id: trajectory.trajectory_id, final_reward: reward.final_reward };
}

/**
 * Best-effort no-run trajectory persistence for failure trials. Used
 * when a trial dies before producing useful execution (setup error,
 * postUserMessage failure, per-trial wall-clock timeout). Synthesizes a
 * reward with NoRunVerifier so the Console / RL stats can still query
 * the failure timeline through the canonical Trajectory envelope.
 *
 * Failure to build the trajectory is logged and swallowed — we still
 * want the trial.status=failed transition to land even if the events
 * endpoint is currently 500-ing.
 */
async function persistFailureTrajectory(
  env: Env,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  outcome: Trajectory["outcome"],
  reasonHint: string,
): Promise<void> {
  try {
    const reward = await synthesizeNoRunReward(reasonHint);
    const result = await buildAndStoreTrajectory(env, run, task, trial, sessionId, reward, outcome);
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
  env: Env,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
): Promise<boolean> {
  // Returns true if any progress was made (caller should save).
  if (trial.status === "completed" || trial.status === "failed") return false;

  // Bootstrap: create session + write setup_files (if any) + send first message
  if (trial.status === "pending") {
    let sessionId: string | undefined;
    try {
      sessionId = await createTaskSession(env, run, task);
      trial.session_id = sessionId;
      trial.status = "running";
      trial.started_at = new Date().toISOString();
      trial.current_message_index = 0;
      // Setup files are written via raw /exec — bypasses the agent so the
      // model doesn't have to recreate deterministic infrastructure (slower,
      // wastes tokens, occasionally drops or rewrites content).
      if (task.spec.setup_files && task.spec.setup_files.length > 0) {
        await writeSetupFiles(env, run, sessionId, task.spec.setup_files);
      }
      if (task.spec.setup_script && task.spec.setup_script.trim().length > 0) {
        await runSetupScript(env, run, sessionId, task.spec.setup_script);
      }
      // Send first message immediately
      await postUserMessage(env, run, sessionId, task.spec.messages[0]);
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      // Phase 2 failure-trial gap fix: when a session was successfully
      // created but the trial died before producing useful execution
      // (setup_files, setup_script, or first postUserMessage failed),
      // build a no-run trajectory so the failure is queryable through
      // the canonical Trajectory envelope. If `createTaskSession` itself
      // threw there's no sessionId — nothing to build, leave it bare.
      if (sessionId) {
        await persistFailureTrajectory(env, run, task, trial, sessionId, "failure", trial.error);
      }
      return true;
    }
  }

  // trial.status === "running" — check current message progress
  if (!trial.session_id) {
    trial.status = "failed";
    trial.error = "running trial missing session_id";
    return true;
  }

  // Enforce per-trial timeout_ms (default 1 hour). Without this a stuck
  // session — model hung, sandbox crash, status fetch broken — would leave
  // the trial "running" forever, blocking the run from terminating and
  // hiding the underlying failure. Implements the type-declared but
  // previously unread `EvalTaskSpec.timeout_ms` field.
  const timeoutMs = task.spec.timeout_ms ?? 3_600_000;
  if (trial.started_at) {
    const elapsed = Date.now() - Date.parse(trial.started_at);
    if (elapsed > timeoutMs) {
      trial.status = "failed";
      trial.error = `trial timeout: ${Math.round(elapsed / 1000)}s exceeded budget ${Math.round(timeoutMs / 1000)}s (m_idx=${trial.current_message_index ?? 0})`;
      trial.ended_at = new Date().toISOString();
      // Phase 2 failure-trial gap fix: stale-session timeout is the most
      // diagnostically valuable failure shape (model hung mid-tool,
      // sandbox crashed, status endpoint broken). The trajectory will
      // contain the partial event stream up to the freeze point.
      await persistFailureTrajectory(env, run, task, trial, trial.session_id, "timeout", trial.error);
      return true;
    }
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
      // Phase 2 failure-trial gap fix: postUserMessage failure mid-run
      // — the agent already produced N-1 turns of trajectory worth
      // archiving even if turn N can't be sent.
      await persistFailureTrajectory(env, run, task, trial, trial.session_id, "failure", trial.error);
      return true;
    }
  }

  // All messages sent and session idle → build trajectory + run verifier.
  // Reaching this point means every spec.messages[] turn ran to idle
  // without exceeding timeout_ms or hitting an error path; the verifier
  // (or the Phase 1 placeholder fallback when no spec is declared)
  // grades the resulting trajectory and supplies the reward. Trajectory
  // storage failure below is infrastructure, not verification — rolls
  // back to running for retry, gives up at 3 attempts and demotes to
  // failed (with the trajectory then never persisted, so no reward to
  // write).
  try {
    // Build the trajectory once and run the verifier against it. The
    // verifier may itself reach back into the sandbox via /exec (script
    // RewardSpec); the canonical Trajectory is what gets graded.
    // Synthesize a placeholder reward first so buildAndStoreTrajectory
    // has something to wire in; immediately replace with the verified
    // reward and re-store so persisted state matches what the verifier
    // produced. Two writes is fine — eval finalize is bounded once per
    // trial, the second store atomically overwrites the first.
    const placeholder = await synthesizeNoRunReward("pre-verify placeholder");
    const built = await buildAndStoreTrajectory(env, run, task, trial, trial.session_id, placeholder);
    // Re-fetch the trajectory we just wrote (the verifier needs the
    // enriched envelope: events + summary + outcome). Cheap: it's local KV.
    const t = run.tenant_id;
    const stored = await env.CONFIG_KV.get(kvKey(t, "trajectory", built.trajectory_id), "text");
    if (!stored) throw new Error(`trajectory ${built.trajectory_id} disappeared after store`);
    const trajectory = JSON.parse(stored) as Trajectory;
    const reward = await runVerifier(env, run, task, trial, trial.session_id, trajectory);
    trajectory.reward = reward;
    await env.CONFIG_KV.put(
      kvKey(t, "trajectory", built.trajectory_id),
      JSON.stringify(trajectory),
    );

    trial.trajectory_id = built.trajectory_id;
    trial.status = "completed";
    trial.ended_at = new Date().toISOString();
    // Mirror Trajectory.reward.final_reward onto the trial for Console
    // back-compat. Phase 3 will switch the UI to read trajectory.reward
    // directly and this can drop.
    trial.reward = reward.final_reward;
    return true;
  } catch (err: unknown) {
    // Bounded retry: events fetch can transiently 500 under storage
    // contention (observed on `sess-lyh1t4ilelc87ypk` 2026-05-02 — events
    // endpoint returned 500 for 25 min during a recovery storm, then
    // self-recovered). Without this counter the trial would either:
    //  - get marked failed on the first 500 (silent loss of recoverable work), or
    //  - sit `running` until the 1 h timeout_ms (slow user feedback).
    // 3 attempts × ~60 s cron interval = ~3 min before giving up — bounded
    // and well inside the per-trial budget.
    const msg = err instanceof Error ? err.message : String(err);
    trial.finalize_retry_count = (trial.finalize_retry_count ?? 0) + 1;
    if (trial.finalize_retry_count >= 3) {
      trial.status = "failed";
      trial.error = `events_unavailable_during_finalize (${trial.finalize_retry_count} attempts): ${msg.slice(0, 200)}`;
      trial.ended_at = new Date().toISOString();
    }
    // Else: leave status="running" so next cron tick re-attempts the
    // finalize. session_id is preserved for diagnostics either way.
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
    // Already terminal — no work to do; status-driven listActive will skip it.
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
    return;
  }

  if (progressed) await saveRun(env, run);
}

// ---------- Public entry point (called by scheduled handler) ----------

export async function tickEvalRuns(env: Env): Promise<{ advanced: number; total: number }> {
  // Cross-tenant scan: list every active eval run across all tenants. Phase 1
  // default returns the shared AUTH_DB so this still works against the
  // legacy single DB. Phase 4 will need a control-plane index over tenants
  // since per-tenant DBs make cross-tenant SELECTs impossible from one binding.
  const services = buildCfServices(env, env.AUTH_DB);
  const activeRows = await services.evals.listActive();
  let advanced = 0;
  for (const row of activeRows) {
    const run = rowToRecord(row);
    try {
      await advanceRun(env, run);
      advanced++;
    } catch (err: unknown) {
      // Mark the whole run failed if advance throws unrecoverably.
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.ended_at = new Date().toISOString();
      await saveRun(env, run);
    }
  }
  return { advanced, total: activeRows.length };
}

// `loadRun` and `EvalTaskSpec` re-export shape — kept unused locally now that
// listActive replaces the per-id KV fetch loop, but keep both exported so any
// future direct-load consumer (admin tooling, debug page) doesn't have to
// rebuild the row→record translator.
export { loadRun };
export type { EvalTaskSpec };
