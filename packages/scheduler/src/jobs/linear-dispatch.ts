// Linear dispatch tick — cron job that:
//   1. Sweeps enabled dispatch rules and assigns matching unassigned issues
//      to the publication's bot user.
//   2. Drains the linear_events queue (events deposited by the webhook
//      handler) by calling sessions.create per event.
//
// One factory accepted by both runtimes' Scheduler; the host wires the
// provider construction (CF in apps/integrations, Node in apps/main-node).
//
// Cap per tick is conservative — 50 rules + 25 events — so one busy
// workspace doesn't push past the runtime CPU budget. Tunable by env via
// LINEAR_DISPATCH_RULE_LIMIT / LINEAR_DISPATCH_EVENT_LIMIT.

import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("scheduler.linear-dispatch");

export interface LinearDispatchSweepResult {
  sweptRules: number;
  assignedIssues: number;
  errors: ReadonlyArray<{ ruleId: string; message: string }>;
}

export interface LinearDispatchDrainResult {
  drainedEvents: number;
  succeeded: number;
  failed: number;
}

export interface LinearDispatchSweeper {
  runDispatchSweep(nowMs: number, ruleLimit: number): Promise<LinearDispatchSweepResult>;
  drainPendingEvents(nowMs: number, eventLimit: number): Promise<LinearDispatchDrainResult>;
}

export interface LinearDispatchTickDeps {
  /** Returns a per-tick LinearProvider (or equivalent) the tick can call.
   *  Async to support hosts that want to lazy-build the provider. Throws
   *  swallowed at the tick boundary; cron keeps ticking. */
  resolveSweeper: () => Promise<LinearDispatchSweeper | null>;
  /** Cap rules per tick. Default 50. */
  ruleLimit?: number;
  /** Cap drain queue per tick. Default 25. */
  eventLimit?: number;
}

export function linearDispatchTick(deps: LinearDispatchTickDeps): () => Promise<void> {
  const ruleLimit = deps.ruleLimit ?? 50;
  const eventLimit = deps.eventLimit ?? 25;
  return async () => {
    const startedAt = Date.now();
    let sweeper: LinearDispatchSweeper | null;
    try {
      sweeper = await deps.resolveSweeper();
    } catch (err) {
      log.warn({ err, op: "linear-dispatch.resolve_failed" }, "sweeper resolve failed");
      return;
    }
    if (!sweeper) return;
    try {
      const sweep = await sweeper.runDispatchSweep(startedAt, ruleLimit);
      const drain = await sweeper.drainPendingEvents(startedAt, eventLimit);
      log.info(
        {
          op: "linear-dispatch.tick",
          swept: sweep.sweptRules,
          assigned: sweep.assignedIssues,
          sweep_errors: sweep.errors.length,
          drained: drain.drainedEvents,
          ok: drain.succeeded,
          fail: drain.failed,
          dur_ms: Date.now() - startedAt,
        },
        "linear-dispatch tick complete",
      );
      for (const e of sweep.errors) {
        log.warn({ op: "linear-dispatch.rule_error", rule_id: e.ruleId, err: e.message }, e.message);
      }
    } catch (err) {
      log.error({ err, op: "linear-dispatch.fatal" }, "linear-dispatch tick failed");
    }
  };
}
