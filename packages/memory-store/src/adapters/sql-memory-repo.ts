import {
  generateMemoryId,
} from "@open-managed-agents/shared";
import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";
import type {
  MemoryRepo,
  MemoryUpdateFields,
  NewMemoryRow,
  NewMemoryVersionInput,
} from "../ports";
import type { Actor, MemoryRow } from "../types";

/**
 * SQL implementation of {@link MemoryRepo}. Owns the SQL against
 * the `memories` (index only — no content column, see migration 0010) and
 * `memory_versions` tables.
 *
 * Backend-agnostic: takes a {@link SqlClient}, which works with Cloudflare D1
 * and better-sqlite3 / Postgres (self-host). Schema is plain SQLite-flavoured.
 *
 * The `*WithVersion` methods use client.batch so the index update + audit row
 * are atomic in a single transaction. The `upsertFromEvent` /
 * `deleteFromEvent` methods are the queue consumer's entry points and must
 * be idempotent (R2 events deliver at-least-once).
 */
export class SqlMemoryRepo implements MemoryRepo {
  constructor(private readonly db: SqlClient) {}

  async createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO memories (id, store_id, path, content_sha256, etag, size_bytes,
                                 created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          memory.id,
          memory.storeId,
          memory.path,
          memory.contentSha256,
          memory.etag,
          memory.sizeBytes,
          memory.createdAt,
          memory.updatedAt,
        ),
      versionInsertStmt(this.db, version),
    ]);
    const row = await this.findById(memory.storeId, memory.id);
    if (!row) throw new Error("memory vanished after createWithVersion");
    return row;
  }

  async updateWithVersion(
    memoryId: string,
    update: MemoryUpdateFields,
    version: NewMemoryVersionInput,
  ): Promise<MemoryRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.path !== undefined) { sets.push("path = ?"); binds.push(update.path); }
    if (update.contentSha256 !== undefined) { sets.push("content_sha256 = ?"); binds.push(update.contentSha256); }
    if (update.etag !== undefined) { sets.push("etag = ?"); binds.push(update.etag); }
    if (update.sizeBytes !== undefined) { sets.push("size_bytes = ?"); binds.push(update.sizeBytes); }
    sets.push("updated_at = ?"); binds.push(update.updatedAt);
    binds.push(memoryId);

    await this.db.batch([
      this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds),
      versionInsertStmt(this.db, version),
    ]);
    const row = await this.findById(version.storeId, memoryId);
    if (!row) throw new Error("memory vanished after updateWithVersion");
    return row;
  }

  async deleteWithVersion(memoryId: string, version: NewMemoryVersionInput): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).bind(memoryId),
      versionInsertStmt(this.db, version),
    ]);
  }

  async findByPath(storeId: string, path: string): Promise<MemoryRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, store_id, path, content_sha256, etag, size_bytes,
                created_at, updated_at
         FROM memories WHERE store_id = ? AND path = ?`,
      )
      .bind(storeId, path)
      .first<DbMemory>();
    return row ? toRow(row) : null;
  }

  async findById(storeId: string, memoryId: string): Promise<MemoryRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, store_id, path, content_sha256, etag, size_bytes,
                created_at, updated_at
         FROM memories WHERE id = ? AND store_id = ?`,
      )
      .bind(memoryId, storeId)
      .first<DbMemory>();
    return row ? toRow(row) : null;
  }

  async list(storeId: string, opts: { pathPrefix?: string }): Promise<MemoryRow[]> {
    let stmt;
    if (opts.pathPrefix) {
      // SQLite range over UNIQUE(store_id, path) — uses the index, O(matched).
      const prefix = opts.pathPrefix;
      const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      stmt = this.db
        .prepare(
          `SELECT id, store_id, path, content_sha256, etag, size_bytes,
                  created_at, updated_at
           FROM memories WHERE store_id = ? AND path >= ? AND path < ?
           ORDER BY path ASC`,
        )
        .bind(storeId, prefix, upper);
    } else {
      stmt = this.db
        .prepare(
          `SELECT id, store_id, path, content_sha256, etag, size_bytes,
                  created_at, updated_at
           FROM memories WHERE store_id = ? ORDER BY path ASC`,
        )
        .bind(storeId);
    }
    const result = await stmt.all<DbMemory>();
    return (result.results ?? []).map(toRow);
  }

  async upsertFromEvent(input: {
    storeId: string;
    path: string;
    contentSha256: string;
    etag: string;
    sizeBytes: number;
    actor: Actor;
    nowMs: number;
    versionId: string;
    content: string;
    memoryId?: string;
  }): Promise<{ wrote: boolean; row: MemoryRow | null }> {
    const existing = await this.findByPath(input.storeId, input.path);

    // Dedupe: same etag = same R2 object = same logical write. R2 events are
    // at-least-once; this guards against double-insert on redelivery.
    if (existing && existing.etag === input.etag) {
      return { wrote: false, row: existing };
    }

    if (existing) {
      const row = await this.updateWithVersion(
        existing.id,
        {
          contentSha256: input.contentSha256,
          etag: input.etag,
          sizeBytes: input.sizeBytes,
          updatedAt: input.nowMs,
        },
        {
          id: input.versionId,
          memoryId: existing.id,
          storeId: input.storeId,
          operation: "modified",
          path: input.path,
          content: input.content,
          contentSha256: input.contentSha256,
          sizeBytes: input.sizeBytes,
          actor: input.actor,
          createdAt: input.nowMs,
        },
      );
      return { wrote: true, row };
    }

    const memoryId = input.memoryId ?? generateMemoryId();
    const row = await this.createWithVersion(
      {
        id: memoryId,
        storeId: input.storeId,
        path: input.path,
        contentSha256: input.contentSha256,
        etag: input.etag,
        sizeBytes: input.sizeBytes,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
      },
      {
        id: input.versionId,
        memoryId,
        storeId: input.storeId,
        operation: "created",
        path: input.path,
        content: input.content,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        actor: input.actor,
        createdAt: input.nowMs,
      },
    );
    return { wrote: true, row };
  }

  async deleteFromEvent(input: {
    storeId: string;
    path: string;
    actor: Actor;
    nowMs: number;
    versionId: string;
  }): Promise<{ wrote: boolean }> {
    const existing = await this.findByPath(input.storeId, input.path);
    if (!existing) return { wrote: false };
    await this.deleteWithVersion(existing.id, {
      id: input.versionId,
      memoryId: existing.id,
      storeId: input.storeId,
      operation: "deleted",
      path: input.path,
      content: "",
      contentSha256: existing.content_sha256,
      sizeBytes: existing.size_bytes,
      actor: input.actor,
      createdAt: input.nowMs,
    });
    return { wrote: true };
  }
}

function versionInsertStmt(db: SqlClient, v: NewMemoryVersionInput): SqlStatement {
  return db
    .prepare(
      `INSERT INTO memory_versions
       (id, memory_id, store_id, operation, path, content, content_sha256, size_bytes,
        actor_type, actor_id, created_at, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(
      v.id,
      v.memoryId,
      v.storeId,
      v.operation,
      v.path,
      v.content,
      v.contentSha256,
      v.sizeBytes,
      v.actor.type,
      v.actor.id,
      v.createdAt,
    );
}

interface DbMemory {
  id: string;
  store_id: string;
  path: string;
  content_sha256: string;
  etag: string | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

function toRow(r: DbMemory): MemoryRow {
  return {
    id: r.id,
    store_id: r.store_id,
    path: r.path,
    content_sha256: r.content_sha256,
    // etag column is NOT NULL going forward, but the migration adds it as
    // nullable (existing rows back-filled by the data migration script).
    // Coerce to "" for index rows that haven't been touched since 0010 yet —
    // CAS reads will fail for those rows until the migration script runs.
    etag: r.etag ?? "",
    size_bytes: r.size_bytes,
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
