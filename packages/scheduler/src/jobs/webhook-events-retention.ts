// webhook-events-retention — daily 04:00 UTC sweep, drops integration
// webhook event rows older than 7 days from the three webhook tables.
//
// Why 7 days:
//   - Dedup window: Linear/GitHub/Slack retry windows are at most 24h.
//     7d is wide enough that a delayed retry can't slip through; tight
//     enough to keep the table small.
//   - Audit window: 99% of "what happened to this webhook" debugging is
//     same-day. 7d covers a long weekend.
//
// Same once-per-day-via-minute-tick gating as memoryRetentionTick.

import type { SqlClient } from "@open-managed-agents/sql-client";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TABLES = ["linear_events", "github_webhook_events", "slack_webhook_events"] as const;

export interface WebhookEventsRetentionDeps {
  /** Returns the integrations DB SqlClient if configured, or null when the
   *  binding/connection is missing — the sweep no-ops in that case. */
  resolveIntegrationsDb: () => Promise<SqlClient | null> | SqlClient | null;
  logger?: {
    log: (ctx: Record<string, unknown>, msg: string) => void;
    error: (ctx: Record<string, unknown>, msg: string) => void;
  };
  now?: () => Date;
}

export interface WebhookEventsRetentionGate {
  sweepHourUtc?: number;
  sweepMinuteUtc?: number;
}

export function webhookEventsRetentionTick(
  deps: WebhookEventsRetentionDeps,
  gate: WebhookEventsRetentionGate = {},
): () => Promise<void> {
  return async () => {
    const now = (deps.now ?? (() => new Date()))();
    const sweepHourUtc = gate.sweepHourUtc ?? 4;
    const sweepMinuteUtc = gate.sweepMinuteUtc ?? 0;
    if (now.getUTCHours() !== sweepHourUtc) return;
    if (now.getUTCMinutes() !== sweepMinuteUtc) return;

    const log = deps.logger ?? {
      log: (c, m) => console.log(m, c),
      error: (c, m) => console.error(m, c),
    };
    const sql = await deps.resolveIntegrationsDb();
    if (!sql) {
      log.error(
        { op: "cron.webhook_events_retention" },
        "integrations db missing — skipping webhook events retention sweep",
      );
      return;
    }
    const cutoffMs = Date.now() - RETENTION_MS;
    for (const table of TABLES) {
      try {
        const result = await sql
          .prepare(`DELETE FROM ${table} WHERE received_at < ?`)
          .bind(cutoffMs)
          .run();
        log.log(
          { op: "cron.webhook_events_retention", table, removed: result.meta?.changes ?? -1, cutoff_ms: cutoffMs },
          `pruned ${result.meta?.changes ?? "(unknown count)"} old rows from ${table}`,
        );
      } catch (err) {
        log.error(
          { op: "cron.webhook_events_retention", table, err },
          `webhook events retention sweep failed for ${table}`,
        );
      }
    }
  };
}
