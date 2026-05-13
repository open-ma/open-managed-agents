// Node Scheduler adapter — wraps `croner`. Each registered job becomes
// one Cron instance on start(); stop() cancels them all.
//
// Multi-replica safety is handled per-job: retention sweeps use SQL
// `DELETE WHERE` which is naturally idempotent across replicas; eval-tick
// scans `evals.listActive()` which uses status-indexed selects (and the
// PG queue's SKIP LOCKED makes message handlers safe). We do NOT add any
// distributed-lock layer here — overkill for the workloads we have.

import type { CronHandler, RegisteredJob, Scheduler } from "../ports";

interface CronInstance {
  stop(): void;
}

interface CronCtor {
  new (
    cron: string,
    opts: { protect?: boolean; catch?: (err: unknown) => void },
    fn: () => void | Promise<void>,
  ): CronInstance;
}

export interface NodeSchedulerOptions {
  /** Optional logger; defaults to console. Errors thrown by handlers are
   *  reported here — a failing handler must NEVER kill the scheduler. */
  logger?: { warn: (msg: string, err?: unknown) => void };
}

export function createNodeScheduler(opts: NodeSchedulerOptions = {}): Scheduler {
  const log = opts.logger ?? { warn: (m, e) => console.warn(m, e) };
  const jobs: RegisteredJob[] = [];
  const live: CronInstance[] = [];
  let started = false;

  return {
    register(job) {
      if (started) throw new Error("Scheduler.register called after start()");
      jobs.push(job);
    },
    async start() {
      if (started) return;
      started = true;
      // Lazy-import croner so consumers that only use the CF adapter
      // don't need it installed.
      const Cron = (await import(/* @vite-ignore */ "croner" as string)).Cron as CronCtor;
      for (const job of jobs) {
        const c = new Cron(
          job.cron,
          {
            protect: true,
            catch: (err) => log.warn(`[scheduler] job=${job.name} threw`, err),
          },
          () => Promise.resolve(job.handler() as Promise<void> | void).catch((err) =>
            log.warn(`[scheduler] job=${job.name} threw`, err),
          ),
        );
        live.push(c);
      }
    },
    async stop() {
      for (const c of live) {
        try { c.stop(); } catch { /* noop */ }
      }
      live.length = 0;
      started = false;
    },
  };
}
