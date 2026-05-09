import {
  log,
  logError,
  type Env,
} from "@open-managed-agents/shared";
import { SqlMemoryVersionRepo } from "@open-managed-agents/memory-store";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

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

  if (!env.AUTH_DB) {
    logError(
      { op: "cron.memory_retention" },
      "AUTH_DB binding missing — skipping memory retention sweep",
    );
    return;
  }

  // Cross-shard fan-out: prune memory_versions on every shard, not just
  // AUTH_DB_00. AUTH_DB binding stays in the iteration list as the
  // legacy alias for shard 0 — same database_id, but listed explicitly
  // so the loop is exhaustive even if older deploys don't have AUTH_DB_00.
  const shards: Array<[string, D1Database | undefined]> = [
    ["AUTH_DB_00", env.AUTH_DB_00 ?? env.AUTH_DB],
    ["AUTH_DB_01", env.AUTH_DB_01],
    ["AUTH_DB_02", env.AUTH_DB_02],
    ["AUTH_DB_03", env.AUTH_DB_03],
  ];
  const cutoffMs = Date.now() - RETENTION_MS;
  let totalRemoved = 0;
  for (const [name, db] of shards) {
    if (!db) continue;
    const repo = new SqlMemoryVersionRepo(new CfD1SqlClient(db));
    try {
      const removed = await repo.pruneOlderThan(cutoffMs);
      if (removed > 0) totalRemoved += removed;
      log(
        { op: "cron.memory_retention.shard", shard: name, removed, cutoff_ms: cutoffMs },
        `pruned ${removed === -1 ? "(unknown count)" : removed} on ${name}`,
      );
    } catch (err) {
      logError(
        { op: "cron.memory_retention.shard", shard: name, err },
        `memory retention sweep failed on ${name}`,
      );
    }
  }
  log(
    { op: "cron.memory_retention", total_removed: totalRemoved, cutoff_ms: cutoffMs },
    `memory retention sweep complete: ${totalRemoved} rows pruned across all shards`,
  );
}
