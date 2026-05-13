// Runtime-agnostic Queue + DLQ port. Three adapters live under ./adapters.
//
//   - cf       wraps a CF Queue binding (producer) and dispatches batches
//              from CF's `queue(batch, env)` entry (consumer).
//   - pg       PostgreSQL-table-backed; multi-replica safe via
//              SELECT ... FOR UPDATE SKIP LOCKED.
//   - in-memory trivial JS Map; setImmediate dispatch. Used for SQLite
//              single-instance and unit tests.
//
// Handlers live in ./handlers/*. The memory-events handler is the first
// real consumer ported through this abstraction; it's invoked the same
// way from CF's `queue(batch, env)` entry and from the Node memory-blob
// watcher.

export type {
  Queue,
  DeadLetterQueue,
  QueueMessage,
  QueueHandler,
  QueueStats,
  EnqueueOptions,
} from "./ports";

export { createCfQueue, createCfDlq, dispatchCfBatch } from "./adapters/cf";
export type { CfQueueDeps } from "./adapters/cf";

export { createInMemoryQueue, createInMemoryDlq } from "./adapters/in-memory";

export { createPgQueue, createPgDlq, ensureQueueSchema } from "./adapters/pg";
export type { PgQueueOptions } from "./adapters/pg";
