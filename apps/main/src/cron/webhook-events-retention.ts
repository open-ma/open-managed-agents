import { log, logError, type Env } from "@open-managed-agents/shared";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Daily sweep: drop rows older than 7 days from the three webhook event
 * tables in INTEGRATIONS_DB.
 *
 * Why 7 days:
 *   - Dedup window: Linear/GitHub/Slack retry windows are at most 24h.
 *     7d is wide enough that a delayed retry can't slip through; tight
 *     enough to keep the table small.
 *   - Audit window: 99% of "what happened to this webhook" debugging is
 *     same-day. 7d covers a long weekend.
 *
 * Scope: deletes ALL rows past the cutoff regardless of state. For
 * `linear_events` this includes processed_at non-NULL rows (which are the
 * post-drain audit trail) — same retention budget applies.
 *
 * Same once-per-day-via-minute-tick gating as memoryRetentionTick.
 */
export async function webhookEventsRetentionTick(
  env: Env,
  sweepHourUtc = 4,
): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== sweepHourUtc) return;
  if (now.getUTCMinutes() !== 0) return;

  if (!env.INTEGRATIONS_DB) {
    logError(
      { op: "cron.webhook_events_retention" },
      "INTEGRATIONS_DB binding missing — skipping webhook events retention sweep",
    );
    return;
  }

  const cutoffMs = Date.now() - RETENTION_MS;
  const tables = ["linear_events", "github_webhook_events", "slack_webhook_events"] as const;

  for (const table of tables) {
    try {
      const result = await env.INTEGRATIONS_DB
        .prepare(`DELETE FROM ${table} WHERE received_at < ?`)
        .bind(cutoffMs)
        .run();
      log(
        { op: "cron.webhook_events_retention", table, removed: result.meta?.changes ?? -1, cutoff_ms: cutoffMs },
        `pruned ${result.meta?.changes ?? "(unknown count)"} old rows from ${table}`,
      );
    } catch (err) {
      logError(
        { op: "cron.webhook_events_retention", table, err },
        `webhook events retention sweep failed for ${table}`,
      );
    }
  }
}
