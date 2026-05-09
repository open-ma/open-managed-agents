import {
  log,
  logError,
  type Env,
} from "@open-managed-agents/shared";
import { forEachShardServices } from "@open-managed-agents/services";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Daily sweep: drop memory_versions rows older than 30 days, except we always
 * keep the most recent version per memory_id. Mirrors Anthropic's retention:
 *   "Versions are retained for 30 days; however, the recent versions are
 *    always kept regardless of age, so memories that change infrequently
 *    may retain history beyond 30 days."
 *
 * Wired into the daily cron tick in apps/main/src/index.ts. Cron runs every
 * minute (existing trigger); we early-return unless the wall clock is at the
 * configured sweep hour to avoid 1440 db hits per day.
 */
export async function memoryRetentionTick(env: Env, sweepHourUtc = 3): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== sweepHourUtc) return;
  // Only fire once per minute window; the cron is `* * * * *` and we want a
  // single execution per day. Pin to the first minute of the hour.
  if (now.getUTCMinutes() !== 0) return;

  // Cross-shard fan-out via the services-level abstraction. Knows nothing
  // about CF binding names or D1Database — adding shards is INSERT
  // shard_pool + new wrangler binding, no code change here.
  const cutoffMs = Date.now() - RETENTION_MS;
  let totalRemoved = 0;
  try {
    const perShard = await forEachShardServices(env, async (services, shardName) => {
      try {
        const removed = await services.memory.pruneVersionsOlderThan(cutoffMs);
        log(
          { op: "cron.memory_retention.shard", shard: shardName, removed, cutoff_ms: cutoffMs },
          `pruned ${removed === -1 ? "(unknown count)" : removed} on ${shardName}`,
        );
        return removed;
      } catch (err) {
        logError(
          { op: "cron.memory_retention.shard", shard: shardName, err },
          `memory retention sweep failed on ${shardName}`,
        );
        return 0;
      }
    });
    for (const r of perShard) {
      if (r > 0) totalRemoved += r;
    }
    log(
      { op: "cron.memory_retention", total_removed: totalRemoved, cutoff_ms: cutoffMs },
      `memory retention sweep complete: ${totalRemoved} rows pruned across all shards`,
    );
  } catch (err) {
    logError(
      { op: "cron.memory_retention", err },
      "memory retention fan-out failed",
    );
  }
}
