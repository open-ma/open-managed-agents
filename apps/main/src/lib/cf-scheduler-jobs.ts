// CF scheduler wiring — registers the CF cron handlers via the
// runtime-agnostic Scheduler interface. Each handler is the same one
// registered by Node in apps/main-node/src/lib/node-scheduler-jobs.ts.
//
// CF still owns the schedule itself (wrangler `triggers.crons`). The
// scheduled() entry below calls `dispatch(controller.cron)` to look up
// and invoke registered jobs whose cron expression matches.

import type { Env } from "@open-managed-agents/shared";
import { log, logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { forEachShardServices } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { createCfScheduler, type CfScheduler } from "@open-managed-agents/scheduler/cf";
import { memoryRetentionTick } from "@open-managed-agents/scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@open-managed-agents/scheduler/jobs/webhook-events-retention";
import { tickEvalRuns } from "../eval-runner";

// Cron expressions are env-overridable so ops can shift sweeps without a
// code deploy. Defaults match the pre-extract behaviour exactly.
function envCron(env: Env, key: string, fallback: string): string {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  return raw && raw.trim() ? raw : fallback;
}

export function buildCfScheduler(env: Env): CfScheduler {
  const scheduler = createCfScheduler();
  const tickCron = envCron(env, "EVAL_TICK_CRON", "* * * * *");
  const memoryCron = envCron(env, "MEMORY_RETENTION_CRON", "* * * * *");
  const webhookCron = envCron(env, "WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *");

  scheduler.register({
    name: "eval-tick",
    cron: tickCron,
    handler: () =>
      tickEvalRuns(env).then(
        (result) =>
          log(
            { op: "cron.tick_eval_runs", advanced: result.advanced, total: result.total },
            "tickEvalRuns ok",
          ),
        (err) => {
          logError({ op: "cron.tick_eval_runs", err }, "tickEvalRuns failed");
          recordEvent(env.ANALYTICS, {
            op: "cron.tick_eval_runs.failed",
            ...errFields(err),
          });
        },
      ),
  });

  scheduler.register({
    name: "memory-retention",
    cron: memoryCron,
    handler: memoryRetentionTick({
      forEachShard: (fn) => forEachShardServices(env, (s, name) => fn(s, name)),
    }),
  });

  scheduler.register({
    name: "webhook-events-retention",
    cron: webhookCron,
    handler: webhookEventsRetentionTick({
      resolveIntegrationsDb: () =>
        env.INTEGRATIONS_DB ? new CfD1SqlClient(env.INTEGRATIONS_DB) : null,
    }),
  });

  return scheduler;
}
