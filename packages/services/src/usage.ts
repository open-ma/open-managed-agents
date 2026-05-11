// Hybrid resource-billing — OSS-side usage event recorder.
//
// OSS counts raw resource usage in INTEGER seconds and writes one row per
// resource-emit into per-tenant `usage_events`. The hosted billing worker
// (managed-agents-billing) pulls unbilled rows via the internal HTTP API,
// applies a rate map, debits credit_ledger, then ack's the ids. Rates,
// money, ledger — all hosted. OSS knows none of it.
//
// Three resource kinds today:
//   session_alive_seconds   — wall-clock from session create to terminate
//   sandbox_active_seconds  — container running (start → stop)
//   browser_active_seconds  — Playwright Page open (first call → close)
//
// Why a thin SqlClient port (and not direct D1 here): keeps this file
// runtime-agnostic. CF impl below uses CfD1SqlClient; a future Node +
// Postgres deployment can wire createPgUsageStore({ pg }) without
// touching call sites in apps/agent.
//
// 24-hour clamp: each emit is bounded to MAX_VALUE_PER_EMIT_SEC to defend
// against bugs (clock skew, missed onStop, lost session_id) producing
// runaway bills. Cron sweep follow-up (slicing long-running sessions
// every 24h) is TODO — see SessionDO TODO.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

export type UsageKind =
  | "session_alive_seconds"
  | "sandbox_active_seconds"
  | "browser_active_seconds";

/** Hard ceiling on a single emit. 24h × 3600 = 86400. */
export const MAX_VALUE_PER_EMIT_SEC = 24 * 3600;

export interface UsageEventInput {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  kind: UsageKind;
  /** Seconds; non-finite, negative, or >MAX_VALUE_PER_EMIT_SEC are clamped. */
  value: number;
}

export interface UsageEventRow {
  id: number;
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  kind: UsageKind;
  value: number;
  created_at: number;
  billed_at: number | null;
}

export interface UsageStore {
  /** Insert one row. No-op if value clamps to 0. */
  recordUsage(e: UsageEventInput): Promise<void>;
  /**
   * Return up to `limit` unbilled rows for `tenantId` with id > `since`.
   * Ordered by id ASC so the billing worker can checkpoint with a single
   * cursor. Pass since=0 to fetch from the beginning.
   */
  listUnbilled(tenantId: string, since: number, limit: number): Promise<UsageEventRow[]>;
  /**
   * Return DISTINCT tenant_ids that have at least one unbilled event on
   * this store. Used by the billing reconcile API's cross-shard fan-out
   * to discover which tenants on each shard have work pending — without
   * the caller having to pre-enumerate the tenant set.
   */
  listUnbilledTenants(): Promise<Array<{ tenant_id: string }>>;
  /** Mark the given ids as billed. Idempotent — re-acking already-acked rows is a no-op. */
  ack(ids: number[]): Promise<void>;
}

/** Sanitize an emit value into a non-negative integer ≤ MAX_VALUE_PER_EMIT_SEC. */
export function clampUsageValue(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  const v = Math.floor(raw);
  return v > MAX_VALUE_PER_EMIT_SEC ? MAX_VALUE_PER_EMIT_SEC : v;
}

/**
 * SQL-backed UsageStore. Constructed against a SqlClient — works on D1
 * (CfD1SqlClient), better-sqlite3 (Node tests), or postgres.js (future
 * Node+pg). Column names match migration 0017_usage_events.sql.
 */
export class SqlUsageStore implements UsageStore {
  constructor(private readonly client: SqlClient) {}

  async recordUsage(e: UsageEventInput): Promise<void> {
    const value = clampUsageValue(e.value);
    if (value <= 0) return;
    await this.client
      .prepare(
        `INSERT INTO usage_events (tenant_id, session_id, agent_id, kind, value, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.tenantId, e.sessionId, e.agentId ?? null, e.kind, value, Date.now())
      .run();
  }

  async listUnbilledTenants(): Promise<Array<{ tenant_id: string }>> {
    const r = await this.client
      .prepare(
        `SELECT DISTINCT tenant_id FROM usage_events WHERE billed_at IS NULL`,
      )
      .all<{ tenant_id: string }>();
    return r.results ?? [];
  }

  async listUnbilled(
    tenantId: string,
    since: number,
    limit: number,
  ): Promise<UsageEventRow[]> {
    const cap = Math.max(1, Math.min(5000, Math.floor(limit) || 500));
    const r = await this.client
      .prepare(
        `SELECT id, tenant_id, session_id, agent_id, kind, value, created_at, billed_at
           FROM usage_events
          WHERE tenant_id = ? AND billed_at IS NULL AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
      )
      .bind(tenantId, since, cap)
      .all<UsageEventRow>();
    return r.results ?? [];
  }

  async ack(ids: number[]): Promise<void> {
    if (!ids.length) return;
    // Filter out non-integers + dedupe so a hostile payload can't smuggle
    // SQL via JSON parsing. Chunk into batches of 100 — D1 caps bound
    // params per statement. Each statement is idempotent (only marks
    // currently-unbilled rows; second ack of same id is a no-op).
    const clean = Array.from(
      new Set(
        ids.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0),
      ),
    );
    if (!clean.length) return;
    const now = Date.now();
    const CHUNK = 100;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const batch = clean.slice(i, i + CHUNK);
      const placeholders = batch.map(() => "?").join(",");
      await this.client
        .prepare(
          `UPDATE usage_events
              SET billed_at = ?
            WHERE billed_at IS NULL AND id IN (${placeholders})`,
        )
        .bind(now, ...batch)
        .run();
    }
  }
}

/** CF wiring — wraps a D1Database in CfD1SqlClient + SqlUsageStore. */
export function createCfUsageStore(deps: { db: D1Database }): UsageStore {
  return new SqlUsageStore(new CfD1SqlClient(deps.db));
}
