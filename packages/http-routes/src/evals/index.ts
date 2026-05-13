// Eval routes — POST/GET/DELETE for /v1/evals/runs.
//
// Sourced from apps/main/src/routes/evals.ts pre-extract: same wire shape,
// same status codes, same opaque `results` JSON column. The cron tick
// (packages/evals-runner/tickEvalRuns) advances rows independently — these
// routes only manage create + read + cancel.
//
// Storage: caller injects `evals` (EvalRunService from
// @open-managed-agents/evals-store) + `agents`/`environments` for the
// existence checks. CF passes its services bundle; Node passes its own
// (Node returns null from `environments` lookups today — we accept the
// run create against a synthesized localhost env).

import { Hono } from "hono";
import type {
  EvalRunService,
  EvalRunRow,
  EvalRunStatus,
} from "@open-managed-agents/evals-store";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import type { RewardSpec } from "@open-managed-agents/shared";

interface Vars {
  Variables: { tenant_id: string };
}

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  setup_script?: string;
  messages: string[];
  timeout_ms?: number;
  trials?: number;
  reward?: RewardSpec;
}

export interface EvalRoutesDeps {
  evals: EvalRunService;
  agents: AgentService;
  /** Optional. When omitted we don't 404 on missing environments — Node
   *  doesn't have a per-tenant environments store yet (P5 work). */
  environments?: EnvironmentService;
}

export function buildEvalRoutes(deps: EvalRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/evals/runs — create
  app.post("/runs", async (c) => {
    const t = c.var.tenant_id;
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

    const [agentRow, envRow] = await Promise.all([
      deps.agents.get({ tenantId: t, agentId: body.agent_id }),
      deps.environments
        ? deps.environments.get({ tenantId: t, environmentId: body.environment_id })
        : Promise.resolve({} as unknown), // Node: skip env existence check
    ]);
    if (!agentRow) return c.json({ error: "Agent not found" }, 404);
    if (deps.environments && !envRow) return c.json({ error: "Environment not found" }, 404);

    const initialResults = {
      task_count: body.tasks.length,
      completed_count: 0,
      failed_count: 0,
      tasks: body.tasks.map((spec) => {
        const trialCount = Math.max(1, spec.trials || 1);
        const trials = [];
        for (let i = 0; i < trialCount; i++) {
          trials.push({ trial_index: i, status: "pending" as EvalRunStatus });
        }
        return { id: spec.id, spec, status: "pending" as EvalRunStatus, trials, trial_total: trialCount };
      }),
    };

    const run = await deps.evals.create({
      tenantId: t,
      agentId: body.agent_id,
      environmentId: body.environment_id,
      results: initialResults,
    });

    return c.json({ run_id: run.id, task_count: body.tasks.length });
  });

  // GET /v1/evals/runs — paginated list
  app.get("/runs", async (c) => {
    const t = c.var.tenant_id;
    const limitParam = c.req.query("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 1000) limit = 1000;

    const runs = await deps.evals.list({
      tenantId: t,
      limit,
      agentId: c.req.query("agent_id") || undefined,
      environmentId: c.req.query("environment_id") || undefined,
      status: c.req.query("status") as EvalRunStatus | undefined,
    });

    return c.json({ data: runs.map(rowToApi) });
  });

  // GET /v1/evals/runs/:id — detail
  app.get("/runs/:id", async (c) => {
    const t = c.var.tenant_id;
    const run = await deps.evals.get({ tenantId: t, runId: c.req.param("id") });
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(rowToApi(run));
  });

  // DELETE /v1/evals/runs/:id — cancel (mark failed) + delete
  app.delete("/runs/:id", async (c) => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const run = await deps.evals.get({ tenantId: t, runId: id });
    if (!run) return c.json({ error: "Run not found" }, 404);
    // If still in-flight, flip to failed first so the cron tick stops
    // touching it before we delete the row.
    if (run.status === "pending" || run.status === "running") {
      await deps.evals.markCompleted({
        tenantId: t,
        runId: id,
        status: "failed",
        error: "cancelled by user",
      });
    }
    await deps.evals.delete({ tenantId: t, runId: id });
    return c.json({ type: "eval_run_deleted", id });
  });

  return app;
}

function rowToApi(run: EvalRunRow) {
  const partial = (run.results ?? {}) as {
    task_count?: number;
    completed_count?: number;
    failed_count?: number;
    tasks?: unknown[];
  };
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
