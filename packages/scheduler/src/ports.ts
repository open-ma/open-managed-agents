// Scheduler port. Two methods, no JobRegistry abstraction — adapters keep
// their own job map.

export type CronHandler = () => Promise<void> | void;

export interface RegisteredJob {
  name: string;
  cron: string;
  handler: CronHandler;
}

export interface Scheduler {
  register(job: RegisteredJob): void;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
