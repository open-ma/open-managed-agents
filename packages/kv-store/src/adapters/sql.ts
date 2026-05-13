// SqlClient-backed KvStore. Schema lives in @open-managed-agents/schema
// (kv_entries table). Tenant scoping: keys are partitioned by tenant_id;
// callers pass the active tenant via the constructor. This is the
// self-host cousin of CfKvStore — same KvStore port, different backing.
//
// Why per-tenant scoping in the adapter (not in keys): consumers of KV
// (quotas, api-keys, oauth state, skill metadata) already build keys
// scoped to a tenant. Pulling tenant_id into a separate column lets
// "delete tenant" be one SQL statement instead of a prefix scan.

import type {
  KvListKey,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  KvStore,
} from "../ports";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface SqlKvStoreOpts {
  sql: SqlClient;
  /** Tenant scope. Required — keys never collide across tenants. Use a
   *  literal "default" for AUTH_DISABLED mode. */
  tenantId: string;
}

export class SqlKvStore implements KvStore {
  constructor(private readonly opts: SqlKvStoreOpts) {}

  async get(key: string): Promise<string | null> {
    const row = await this.opts.sql
      .prepare(
        `SELECT value, expires_at FROM kv_entries WHERE tenant_id = ? AND key = ?`,
      )
      .bind(this.opts.tenantId, key)
      .first<{ value: string; expires_at: number | null }>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      // Lazy purge.
      await this.opts.sql
        .prepare(`DELETE FROM kv_entries WHERE tenant_id = ? AND key = ?`)
        .bind(this.opts.tenantId, key)
        .run();
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
    let expiresAt: number | null = null;
    if (opts?.expirationTtl !== undefined) {
      expiresAt = Date.now() + opts.expirationTtl * 1000;
    } else if (opts?.expiration !== undefined) {
      expiresAt = opts.expiration * 1000;
    }
    await this.opts.sql
      .prepare(
        `INSERT INTO kv_entries (tenant_id, key, value, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .bind(this.opts.tenantId, key, value, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.opts.sql
      .prepare(`DELETE FROM kv_entries WHERE tenant_id = ? AND key = ?`)
      .bind(this.opts.tenantId, key)
      .run();
  }

  async list(opts?: KvListOptions): Promise<KvListResult> {
    const prefix = opts?.prefix ?? "";
    const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
    const offset = opts?.cursor ? parseCursor(opts.cursor) : 0;
    const now = Date.now();
    const result = await this.opts.sql
      .prepare(
        `SELECT key AS name, expires_at FROM kv_entries
          WHERE tenant_id = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY key ASC LIMIT ? OFFSET ?`,
      )
      .bind(this.opts.tenantId, `${prefix}%`, now, limit + 1, offset)
      .all<{ name: string; expires_at: number | null }>();
    const rows = result.results ?? [];
    const has_more = rows.length > limit;
    const sliced = rows.slice(0, limit);
    return {
      keys: sliced.map<KvListKey>((r) => ({
        name: r.name,
        expiration:
          r.expires_at !== null ? Math.floor(r.expires_at / 1000) : undefined,
      })),
      list_complete: !has_more,
      cursor: has_more ? encodeCursor(offset + limit) : undefined,
    };
  }
}

function encodeCursor(idx: number): string {
  return Buffer.from(String(idx)).toString("base64");
}

function parseCursor(c: string): number {
  try {
    const n = Number.parseInt(Buffer.from(c, "base64").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
