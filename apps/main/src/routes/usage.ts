// /v1/usage/* — read-only views into the usage_events table.
//
// Every deployment (including self-hosters) gets these endpoints. The
// rows are produced by the agent worker's OmaSandbox at container stop
// (see apps/agent/src/runtime/usage-events.ts). Hosted billing layers
// onto the same rows via a separate worker; that's not OSS concern.
//
// Two endpoints, both tenant-scoped (auth middleware sets c.var.tenant_id):
//   GET /v1/usage/sessions  — paginated list, newest first
//   GET /v1/usage/summary?period=day|week|month  — aggregate buckets
//
// Pagination uses created_at + id cursor like other list endpoints
// (see routes/sessions.ts) for stable forward-only pagination.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

interface UsageEventRow {
  id: string;
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  environment_id: string | null;
  event_type: string;
  runtime_kind: string;
  sandbox_active_seconds: number;
  started_at: number;
  ended_at: number;
  exit_code: number | null;
  exit_reason: string | null;
  created_at: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

app.get("/sessions", async (c) => {
  const tenantId = c.var.tenant_id;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );
  const cursor = c.req.query("cursor"); // "<started_at>:<id>"
  const sessionFilter = c.req.query("session_id");

  const params: (string | number)[] = [tenantId];
  let where = "tenant_id = ?";
  if (sessionFilter) {
    where += " AND session_id = ?";
    params.push(sessionFilter);
  }
  if (cursor) {
    const [startedRaw, idRaw] = cursor.split(":");
    const startedAt = parseInt(startedRaw, 10);
    if (Number.isFinite(startedAt) && idRaw) {
      where += " AND (started_at < ? OR (started_at = ? AND id < ?))";
      params.push(startedAt, startedAt, idRaw);
    }
  }

  const sql = `SELECT * FROM usage_events
               WHERE ${where}
               ORDER BY started_at DESC, id DESC
               LIMIT ?`;
  const rs = await c.env.AUTH_DB.prepare(sql)
    .bind(...params, limit + 1)
    .all<UsageEventRow>();
  const rows = rs.results ?? [];
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? `${data[data.length - 1].started_at}:${data[data.length - 1].id}` : null;

  return c.json({ data, next_cursor: nextCursor });
});

app.get("/summary", async (c) => {
  const tenantId = c.var.tenant_id;
  const period = (c.req.query("period") ?? "day") as "day" | "week" | "month";

  // SQLite doesn't have native day-bucket truncation that respects time zones,
  // so we do millisecond bucketing in SQL: bucket = (started_at / windowMs) * windowMs.
  // Caller can convert to wall-clock dates client-side.
  const WINDOW_MS: Record<string, number> = {
    day: 24 * 3600 * 1000,
    week: 7 * 24 * 3600 * 1000,
    month: 30 * 24 * 3600 * 1000, // approximate; finer rollup is a Console concern
  };
  const windowMs = WINDOW_MS[period] ?? WINDOW_MS.day;

  // Show the last 60 buckets — 60 days for "day", ~14 months for "month".
  const horizon = Date.now() - windowMs * 60;

  const sql = `SELECT
                 (started_at / ?) * ? AS bucket_start,
                 runtime_kind,
                 COUNT(*) AS event_count,
                 SUM(sandbox_active_seconds) AS total_seconds
               FROM usage_events
               WHERE tenant_id = ? AND started_at >= ?
               GROUP BY bucket_start, runtime_kind
               ORDER BY bucket_start DESC`;
  const rs = await c.env.AUTH_DB.prepare(sql)
    .bind(windowMs, windowMs, tenantId, horizon)
    .all<{
      bucket_start: number;
      runtime_kind: string;
      event_count: number;
      total_seconds: number;
    }>();

  return c.json({
    period,
    window_ms: windowMs,
    buckets: rs.results ?? [],
  });
});

export default app;
