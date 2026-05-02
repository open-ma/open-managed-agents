import type { SqlClient } from "@open-managed-agents/sql-client";
import type { MemoryVersionRepo } from "../ports";
import type { Actor, MemoryVersionRow } from "../types";

/**
 * SQL implementation of {@link MemoryVersionRepo}. Read + redact
 * paths over the memory_versions table; the write path lives in
 * {@link SqlMemoryRepo} because every version write is paired with a memory
 * mutation in the same client.batch.
 */
export class SqlMemoryVersionRepo implements MemoryVersionRepo {
  constructor(private readonly db: SqlClient) {}

  async list(
    storeId: string,
    opts: { memoryId?: string; limit: number },
  ): Promise<MemoryVersionRow[]> {
    let stmt;
    if (opts.memoryId) {
      stmt = this.db
        .prepare(
          `SELECT id, memory_id, store_id, operation, path, content, content_sha256,
                  size_bytes, actor_type, actor_id, created_at, redacted
           FROM memory_versions WHERE store_id = ? AND memory_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(storeId, opts.memoryId, opts.limit);
    } else {
      stmt = this.db
        .prepare(
          `SELECT id, memory_id, store_id, operation, path, content, content_sha256,
                  size_bytes, actor_type, actor_id, created_at, redacted
           FROM memory_versions WHERE store_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(storeId, opts.limit);
    }
    const result = await stmt.all<DbVersion>();
    return (result.results ?? []).map(toRow);
  }

  async get(storeId: string, versionId: string): Promise<MemoryVersionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, memory_id, store_id, operation, path, content, content_sha256,
                size_bytes, actor_type, actor_id, created_at, redacted
         FROM memory_versions WHERE id = ? AND store_id = ?`,
      )
      .bind(versionId, storeId)
      .first<DbVersion>();
    return row ? toRow(row) : null;
  }

  async redact(storeId: string, versionId: string): Promise<MemoryVersionRow> {
    await this.db
      .prepare(
        `UPDATE memory_versions
         SET path = NULL, content = NULL, content_sha256 = NULL, size_bytes = NULL, redacted = 1
         WHERE id = ? AND store_id = ?`,
      )
      .bind(versionId, storeId)
      .run();
    const row = await this.get(storeId, versionId);
    if (!row) throw new Error(`memory_versions ${versionId} vanished after redact`);
    return row;
  }

  /**
   * Drop versions older than `cutoffMs` EXCEPT the most recent per memory_id.
   * Mirrors Anthropic's retention rule:
   *   "Versions are retained for 30 days; however, the recent versions are
   *    always kept regardless of age, so memories that change infrequently
   *    may retain history beyond 30 days."
   *
   * Returns rows-deleted count for cron observability.
   */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    // Subquery picks the latest version per memory_id (highest created_at, tie-broken by id);
    // we delete anything older than cutoff that isn't the latest for its memory.
    // SQLite supports DELETE ... WHERE id IN (SELECT ...) so this is one round-trip.
    const result = await this.db
      .prepare(
        `DELETE FROM memory_versions
         WHERE created_at < ?
           AND id NOT IN (
             SELECT v.id FROM memory_versions v
             JOIN (
               SELECT memory_id, MAX(created_at) AS max_at
               FROM memory_versions GROUP BY memory_id
             ) latest
             ON v.memory_id = latest.memory_id AND v.created_at = latest.max_at
           )`,
      )
      .bind(cutoffMs)
      .run();
    // D1 doesn't always populate `meta.changes` on .run(); if absent we report -1
    // and the caller logs it as "unknown count, sweep ran".
    const changes = (result.meta as { changes?: number } | undefined)?.changes;
    return typeof changes === "number" ? changes : -1;
  }
}

interface DbVersion {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path: string | null;
  content: string | null;
  content_sha256: string | null;
  size_bytes: number | null;
  actor_type: Actor["type"];
  actor_id: string;
  created_at: number;
  redacted: number;
}

function toRow(r: DbVersion): MemoryVersionRow {
  return {
    id: r.id,
    memory_id: r.memory_id,
    store_id: r.store_id,
    operation: r.operation,
    path: r.path,
    content: r.content,
    content_sha256: r.content_sha256,
    size_bytes: r.size_bytes,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    created_at: msToIso(r.created_at),
    redacted: r.redacted === 1,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
