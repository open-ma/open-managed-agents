// Node scheduler wiring — registers the same cron handlers as the CF
// entry. Started after the HTTP server boots; stopped on SIGTERM.
//
// Single-instance default: croner runs the schedule in-process. The
// retention sweeps are idempotent SQL DELETEs, so when scaling to
// multiple replicas later the worst case is "two replicas DELETE the
// same rows in the same minute" — both succeed harmlessly.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { EvalRunService } from "@open-managed-agents/evals-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-scheduler");
import { createNodeScheduler } from "@open-managed-agents/scheduler/node";
import { memoryRetentionTick } from "@open-managed-agents/scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@open-managed-agents/scheduler/jobs/webhook-events-retention";
import {
  linearDispatchTick,
  type LinearDispatchSweeper,
} from "@open-managed-agents/scheduler/jobs/linear-dispatch";
import {
  tickEvalRuns,
  type EvalRunnerContext,
  type EvalRunnerServices,
  type SandboxFetcher,
} from "@open-managed-agents/evals-runner";

export interface NodeSchedulerDeps {
  evalServices: EvalRunnerServices;
  memory: MemoryStoreService;
  /** Optional integrations DB SqlClient. Pass null to skip the
   *  webhook-events retention sweep on Node. */
  integrationsSql?: SqlClient | null;
  /** Optional Linear dispatch sweeper. Wired by the bootstrap when an
   *  in-process LinearProvider is available. Skip when null — most
   *  self-host deployments don't run the Linear gateway side yet. */
  linearSweeper?: (() => Promise<LinearDispatchSweeper | null>) | null;
  /** Override defaults via env so an operator can quiet noisy crons
   *  during a maintenance window without a code change. */
  env?: NodeJS.ProcessEnv;
}

export function buildNodeScheduler(deps: NodeSchedulerDeps) {
  const env = deps.env ?? process.env;
  const cron = (key: string, fallback: string) => {
    const v = env[key];
    return v && v.trim() ? v : fallback;
  };

  const scheduler = createNodeScheduler();

  // Eval-tick: runs every minute by default. Node's eval runner has no
  // SANDBOX_<env> binding to call into yet — until cloud environments
  // land on Node, this just iterates `evals.listActive()` (empty under
  // SQLite default) and exits. Cheap.
  const evalCtx: EvalRunnerContext = {
    forEachShard: async (fn) => [await fn(deps.evalServices)],
    getServicesForTenant: async () => deps.evalServices,
    getSandboxBinding: async (): Promise<SandboxFetcher | null> => null,
  };
  scheduler.register({
    name: "eval-tick",
    cron: cron("EVAL_TICK_CRON", "* * * * *"),
    handler: async () => {
      try {
        await tickEvalRuns(evalCtx);
      } catch (err) {
        log.warn({ err, op: "scheduler.eval_tick.failed" }, "eval-tick failed");
      }
    },
  });

  // Memory retention.
  scheduler.register({
    name: "memory-retention",
    cron: cron("MEMORY_RETENTION_CRON", "* * * * *"),
    handler: memoryRetentionTick({
      forEachShard: async (fn) => [await fn({ memory: deps.memory }, "default")],
    }),
  });

  // Webhook-events retention — only registered if an integrations DB
  // is wired (P4 territory). Otherwise the registration is skipped so
  // it doesn't fire and log "skipping" every minute.
  if (deps.integrationsSql) {
    const integrationsSql = deps.integrationsSql;
    scheduler.register({
      name: "webhook-events-retention",
      cron: cron("WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *"),
      handler: webhookEventsRetentionTick({
        resolveIntegrationsDb: () => integrationsSql,
      }),
    });
  }

  // Linear dispatch sweep + drain. Only registered when a sweeper resolver
  // is provided — most self-host deployments don't run the gateway side
  // (no Linear OAuth callback URL configured), so the registration is
  // gated rather than no-op'd.
  if (deps.linearSweeper) {
    const resolveSweeper = deps.linearSweeper;
    scheduler.register({
      name: "linear-dispatch",
      cron: cron("LINEAR_DISPATCH_CRON", "* * * * *"),
      handler: linearDispatchTick({ resolveSweeper }),
    });
  }

  return scheduler;
}

export type {
  AgentService,
  EnvironmentService,
  SessionService,
  EvalRunService,
  KvStore,
};

