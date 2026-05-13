// memory-retention — daily 03:00 UTC sweep, prunes memory_versions older
// than 30 days while always keeping the most recent version per memory_id.
//
// Mirrors Anthropic's retention semantics:
//   "Versions are retained for 30 days; however, the recent versions are
//    always kept regardless of age, so memories that change infrequently
//    may retain history beyond 30 days."
//
// Sweep gating: handler is invoked every minute (current cron triggers
// on `* * * * *`); we early-return unless the wall clock matches the
// configured sweep hour+minute. CF + Node both schedule the same way,
// so the gate logic lives here once.

import type { MemoryStoreService } from "@open-managed-agents/memory-store";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface MemoryRetentionDeps {
  /** Iterate every shard once and call fn with the shard's services.
   *  CF passes `forEachShardServices(env, ...)`; Node single-instance passes
   *  `(fn) => fn(services).then((r) => [r])`. */
  forEachShard: <T>(
    fn: (services: { memory: MemoryStoreService }, shardName: string) => Promise<T>,
  ) => Promise<T[]>;
  logger?: {
    log: (ctx: Record<string, unknown>, msg: string) => void;
    warn: (ctx: Record<string, unknown>, msg: string) => void;
    error: (ctx: Record<string, unknown>, msg: string) => void;
  };
  /** Stub for tests — real callers pass Date. */
  now?: () => Date;
}

export interface MemoryRetentionGate {
  sweepHourUtc?: number;
  sweepMinuteUtc?: number;
}

export function memoryRetentionTick(
  deps: MemoryRetentionDeps,
  gate: MemoryRetentionGate = {},
): () => Promise<void> {
  return async () => {
    const now = (deps.now ?? (() => new Date()))();
    const sweepHourUtc = gate.sweepHourUtc ?? 3;
    const sweepMinuteUtc = gate.sweepMinuteUtc ?? 0;
    if (now.getUTCHours() !== sweepHourUtc) return;
    if (now.getUTCMinutes() !== sweepMinuteUtc) return;

    const log = deps.logger ?? {
      log: (c, m) => console.log(m, c),
      warn: (c, m) => console.warn(m, c),
      error: (c, m) => console.error(m, c),
    };
    const cutoffMs = Date.now() - RETENTION_MS;
    let totalRemoved = 0;
    try {
      const perShard = await deps.forEachShard(async (services, shardName) => {
        try {
          const removed = await services.memory.pruneVersionsOlderThan(cutoffMs);
          log.log(
            { op: "cron.memory_retention.shard", shard: shardName, removed, cutoff_ms: cutoffMs },
            `pruned ${removed === -1 ? "(unknown count)" : removed} on ${shardName}`,
          );
          return removed;
        } catch (err) {
          log.error(
            { op: "cron.memory_retention.shard", shard: shardName, err },
            `memory retention sweep failed on ${shardName}`,
          );
          return 0;
        }
      });
      for (const r of perShard) {
        if (r > 0) totalRemoved += r;
      }
      log.log(
        { op: "cron.memory_retention", total_removed: totalRemoved, cutoff_ms: cutoffMs },
        `memory retention sweep complete: ${totalRemoved} rows pruned across all shards`,
      );
    } catch (err) {
      log.error(
        { op: "cron.memory_retention", err },
        "memory retention fan-out failed",
      );
    }
  };
}
