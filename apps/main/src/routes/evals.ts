import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { generateEvalRunId } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

// ---------- Types (Phase 1 + P0a server-side trials) ----------

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  messages: string[]; // sequence of user message texts to send
  timeout_ms?: number; // per-message wait timeout
  // P0a — number of independent trials of this task to run.
  // Default 1. When > 1, server spawns N sessions per task and stores N
  // trajectory_ids; pass@k / pass^k computed by downstream scorer layer.
  trials?: number;
}

export type EvalRunStatus = "pending" | "running" | "completed" | "failed";

export interface EvalTrialResult {
  trial_index: number;
  status: EvalRunStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
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

  // Verify agent + env exist for this tenant
  const [agentData, envData] = await Promise.all([
    c.env.CONFIG_KV.get(kvKey(t, "agent", body.agent_id)),
    c.env.CONFIG_KV.get(kvKey(t, "env", body.environment_id)),
  ]);
  if (!agentData) return c.json({ error: "Agent not found" }, 404);
  if (!envData) return c.json({ error: "Environment not found" }, 404);

  const runId = generateEvalRunId();
  const now = new Date().toISOString();
  const record: EvalRunRecord = {
    id: runId,
    tenant_id: t,
    agent_id: body.agent_id,
    environment_id: body.environment_id,
    status: "pending",
    created_at: now,
    task_count: body.tasks.length,
    completed_count: 0,
    failed_count: 0,
    tasks: body.tasks.map((spec) => {
      const trialCount = Math.max(1, spec.trials || 1);
      const trials: EvalTrialResult[] = [];
      for (let i = 0; i < trialCount; i++) {
        trials.push({ trial_index: i, status: "pending" });
      }
      return { id: spec.id, spec, status: "pending", trials, trial_total: trialCount };
    }),
  };

  await Promise.all([
    c.env.CONFIG_KV.put(kvKey(t, "evalrun", runId), JSON.stringify(record)),
    // Index for cron scan: lightweight active list
    c.env.CONFIG_KV.put(`evalrun_active:${runId}`, t),
  ]);

  return c.json({ run_id: runId, task_count: body.tasks.length });
});

// GET /v1/evals/runs/:id
app.get("/runs/:id", async (c) => {
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "evalrun", c.req.param("id")));
  if (!data) return c.json({ error: "Run not found" }, 404);
  return c.json(JSON.parse(data));
});

// GET /v1/evals/runs — list runs for this tenant
app.get("/runs", async (c) => {
  const t = c.get("tenant_id");
  const limitParam = c.req.query("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "evalrun") });
  const runs = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? (JSON.parse(data) as EvalRunRecord) : null;
      })
    )
  ).filter((r): r is EvalRunRecord => r !== null);

  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return c.json({ data: runs.slice(0, limit) });
});

export default app;
