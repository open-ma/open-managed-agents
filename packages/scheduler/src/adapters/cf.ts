// CF Scheduler adapter — bridges wrangler `triggers.crons` to registered
// handlers via cron-expression match.
//
// Wrangler still owns the cron schedule (it has to — CF dispatches based
// on its own config); this adapter is the lookup table from the
// `controller.cron` string the runtime hands the worker into the matching
// handler. start()/stop() are no-ops because CF is the cron source.

import type { CronHandler, RegisteredJob, Scheduler } from "../ports";

export interface CfScheduler extends Scheduler {
  /** Look up the handler whose cron matches `cronExpr` and invoke it. Returns
   *  the names of dispatched handlers (CF schedules can match multiple
   *  registrations if two share the same expression). */
  dispatch(cronExpr: string): Promise<string[]>;
  /** All registered jobs, for diagnostics / health endpoints. */
  list(): RegisteredJob[];
}

export function createCfScheduler(): CfScheduler {
  const jobs: RegisteredJob[] = [];
  return {
    register(job) {
      jobs.push(job);
    },
    start() {},
    stop() {},
    list() {
      return [...jobs];
    },
    async dispatch(cronExpr) {
      const matches = jobs.filter((j) => j.cron === cronExpr);
      const dispatched: string[] = [];
      // Run all matches sequentially — CF entry already wraps each in
      // ctx.waitUntil, so a slow handler doesn't block the dispatcher.
      for (const job of matches) {
        await Promise.resolve(job.handler() as Promise<void> | void);
        dispatched.push(job.name);
      }
      return dispatched;
    },
  };
}

export type { CronHandler, RegisteredJob };
