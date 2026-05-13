// Scheduler — runtime-agnostic cron port.
//
// Two adapters: CF (`./adapters/cf`) bridges the wrangler `triggers.crons`
// invocation; Node (`./adapters/node`) runs `croner` jobs in-process.
//
// Job handlers live in ./jobs/* and are registered identically by both
// runtimes. Adding a job: write the handler, register it in both the
// CF entry's `scheduled()` builder and the Node entry's bootstrap.

export type { CronHandler, RegisteredJob, Scheduler } from "./ports";
export { createCfScheduler } from "./adapters/cf";
export { createNodeScheduler } from "./adapters/node";
export type { CfScheduler } from "./adapters/cf";
