import {
  log,
  logError,
  type Env,
} from "@open-managed-agents/shared";
import { D1MemoryVersionRepo } from "@open-managed-agents/memory-store";

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

  const repo = new D1MemoryVersionRepo(env.AUTH_DB);
  const cutoffMs = Date.now() - RETENTION_MS;
  try {
    const removed = await repo.pruneOlderThan(cutoffMs);
    log(
      { op: "cron.memory_retention", removed, cutoff_ms: cutoffMs },
      `pruned ${removed === -1 ? "(unknown count)" : removed} old memory versions`,
    );
  } catch (err) {
    logError(
      { op: "cron.memory_retention", err },
      "memory retention sweep failed",
    );
  }
}
