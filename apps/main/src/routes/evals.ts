import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EvalRunStatus } from "@open-managed-agents/evals-store";
import type { Services } from "@open-managed-agents/services";
import { kvKey } from "../kv-helpers";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// ---------- Types (Phase 1 + P0a server-side trials) ----------

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  /**
   * Bash run in the sandbox via /exec before the first message. Used to
   * stage env state that doesn't fit `setup_files` (git clone at a
   * specific commit, dataset download, system package install). Failure
   * (exit != 0) marks the trial failed before the agent ever starts.
   */
  setup_script?: string;
  messages: string[]; // sequence of user message texts to send
  timeout_ms?: number; // per-message wait timeout
  // P0a — number of independent trials of this task to run.
  // Default 1. When > 1, server spawns N sessions per task and stores N
  // trajectory_ids; pass@k / pass^k computed by downstream scorer layer.
  trials?: number;
}

export type { EvalRunStatus };

export interface EvalTrialResult {
  trial_index: number;
  status: EvalRunStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  /**
   * How many times we've attempted to finalize the trajectory (build+store)
   * after the session went idle. Bounded retry — eval-runner.ts gives up
   * after 3 attempts and marks the trial failed with structured error.
   * Field is absent until the first failure (treat as 0).
   */
  finalize_retry_count?: number;
}

export interface EvalTaskResult {
  id: string;
  spec: EvalTaskSpec;
  status: EvalRunStatus;
  trials: EvalTrialResult[]; // length = spec.trials || 1
  // Aggregated convenience metadata (computed when all trials terminal):
  trial_pass_count?: number; // # of trials that reached "completed"
  trial_total?: number;      // = trials.length
  error?: string;            // populated only if every trial failed (run-level error)
}

export interface EvalRunRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  status: EvalRunStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: EvalTaskResult[];
  error?: string;
}

// ---------- Routes ----------

// POST /v1/evals/runs
app.post("/runs", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{
    agent_id: string;
    environment_id: string;
    tasks: EvalTaskSpec[];
  }>();

  if (!body.agent_id) return c.json({ error: "agent_id is required" }, 400);
  if (!body.environment_id) return c.json({ error: "environment_id is required" }, 400);
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return c.json({ error: "tasks array is required and must be non-empty" }, 400);
  }
  for (const task of body.tasks) {
    if (!task.id) return c.json({ error: `task missing id: ${JSON.stringify(task).slice(0, 100)}` }, 400);
    if (!Array.isArray(task.messages) || task.messages.length === 0) {
      return c.json({ error: `task ${task.id} requires non-empty messages array` }, 400);
    }
  }

  // Verify agent + env exist for this tenant — service treats *_id as opaque,
  // so the existence checks stay in the route layer.
  const [agentRow, envRow] = await Promise.all([
    c.var.services.agents.get({ tenantId: t, agentId: body.agent_id }),
    c.var.services.environments.get({ tenantId: t, environmentId: body.environment_id }),
  ]);
  if (!agentRow) return c.json({ error: "Agent not found" }, 404);
  if (!envRow) return c.json({ error: "Environment not found" }, 404);

  // Initial results blob — opaque to the service.
  const initialResults = {
    task_count: body.tasks.length,
    completed_count: 0,
    failed_count: 0,
    tasks: body.tasks.map((spec) => {
      const trialCount = Math.max(1, spec.trials || 1);
      const trials: EvalTrialResult[] = [];
      for (let i = 0; i < trialCount; i++) {
        trials.push({ trial_index: i, status: "pending" });
      }
      return { id: spec.id, spec, status: "pending" as EvalRunStatus, trials, trial_total: trialCount };
    }),
  };

  const run = await c.var.services.evals.create({
    tenantId: t,
    agentId: body.agent_id,
    environmentId: body.environment_id,
    results: initialResults,
    // status defaults to "pending" — listActive picks it up on the next tick.
  });

  return c.json({ run_id: run.id, task_count: body.tasks.length });
});

// GET /v1/evals/runs/:id
app.get("/runs/:id", async (c) => {
  const t = c.get("tenant_id");
  const run = await c.var.services.evals.get({
    tenantId: t,
    runId: c.req.param("id"),
  });
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(rowToApi(run));
});

// GET /v1/evals/runs — list runs for this tenant
app.get("/runs", async (c) => {
  const t = c.get("tenant_id");
  const limitParam = c.req.query("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const runs = await c.var.services.evals.list({
    tenantId: t,
    limit,
    agentId: c.req.query("agent_id") || undefined,
    environmentId: c.req.query("environment_id") || undefined,
    status: c.req.query("status") as EvalRunStatus | undefined,
  });

  return c.json({ data: runs.map(rowToApi) });
});

/**
 * Flatten an EvalRunRow back into the legacy EvalRunRecord shape that the
 * Console + CLI consume. Maintains backward compatibility while the table
 * stores its mutable per-tick state inside the opaque `results` JSON column.
 */
function rowToApi(run: import("@open-managed-agents/evals-store").EvalRunRow) {
  const partial = (run.results ?? {}) as Partial<EvalRunRecord>;
  return {
    id: run.id,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    status: run.status,
    created_at: run.started_at,
    started_at: run.started_at,
    ended_at: run.completed_at ?? undefined,
    error: run.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
  };
}

export default app;
