import type {
  MemoryRepo,
  MemoryUpdateFields,
  NewMemoryRow,
  NewMemoryVersionInput,
} from "../ports";
import type { MemoryRow } from "../types";

/**
 * Cloudflare D1 implementation of {@link MemoryRepo}. Owns the SQL against
 * the memories + memory_versions tables. The `*WithVersion` methods use
 * D1.batch to make memory + version writes atomic — D1 batch is a single
 * transaction in the underlying SQLite.
 */
export class D1MemoryRepo implements MemoryRepo {
  constructor(private readonly db: D1Database) {}

  async createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO memories (id, store_id, path, content, content_sha256, size_bytes,
                                 created_at, updated_at, vector_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          memory.id,
          memory.storeId,
          memory.path,
          memory.content,
          memory.contentSha256,
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
    // Build dynamic SET clause based on which fields actually change. This lets
    // pure-rename updates avoid touching content/sha/size and lets content
    // updates carry vector_synced_at = NULL through the same statement.
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (update.path !== undefined) { sets.push("path = ?"); binds.push(update.path); }
    if (update.content !== undefined) { sets.push("content = ?"); binds.push(update.content); }
    if (update.contentSha256 !== undefined) { sets.push("content_sha256 = ?"); binds.push(update.contentSha256); }
    if (update.sizeBytes !== undefined) { sets.push("size_bytes = ?"); binds.push(update.sizeBytes); }
    sets.push("updated_at = ?"); binds.push(update.updatedAt);
    if (update.vectorSyncedAt !== "unchanged") {
      sets.push("vector_synced_at = ?");
      binds.push(update.vectorSyncedAt);
    }
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
        `SELECT id, store_id, path, content, content_sha256, size_bytes,
                created_at, updated_at, vector_synced_at
         FROM memories WHERE store_id = ? AND path = ?`,
      )
      .bind(storeId, path)
      .first<DbMemory>();
    return row ? toRow(row) : null;
  }

  async findById(storeId: string, memoryId: string): Promise<MemoryRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, store_id, path, content, content_sha256, size_bytes,
                created_at, updated_at, vector_synced_at
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
          `SELECT id, store_id, path, content, content_sha256, size_bytes,
                  created_at, updated_at, vector_synced_at
           FROM memories WHERE store_id = ? AND path >= ? AND path < ?
           ORDER BY path ASC`,
        )
        .bind(storeId, prefix, upper);
    } else {
      stmt = this.db
        .prepare(
          `SELECT id, store_id, path, content, content_sha256, size_bytes,
                  created_at, updated_at, vector_synced_at
           FROM memories WHERE store_id = ? ORDER BY path ASC`,
        )
        .bind(storeId);
    }
    const result = await stmt.all<DbMemory>();
    return (result.results ?? []).map(toRow);
  }

  async markSynced(memoryId: string, syncedAt: number): Promise<void> {
    await this.db
      .prepare(`UPDATE memories SET vector_synced_at = ? WHERE id = ?`)
      .bind(syncedAt, memoryId)
      .run();
  }

  async markUnsynced(memoryId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE memories SET vector_synced_at = NULL WHERE id = ?`)
      .bind(memoryId)
      .run();
  }

  async listUnsynced(opts: {
    tenantId?: string;
    storeId?: string;
    limit: number;
  }): Promise<Array<{ id: string; storeId: string; path: string; content: string }>> {
    let stmt;
    if (opts.storeId && opts.tenantId) {
      stmt = this.db
        .prepare(
          `SELECT m.id, m.store_id, m.path, m.content
           FROM memories m
           JOIN memory_stores s ON s.id = m.store_id
           WHERE m.vector_synced_at IS NULL AND m.store_id = ? AND s.tenant_id = ?
           LIMIT ?`,
        )
        .bind(opts.storeId, opts.tenantId, opts.limit);
    } else if (opts.storeId) {
      stmt = this.db
        .prepare(
          `SELECT id, store_id, path, content FROM memories
           WHERE vector_synced_at IS NULL AND store_id = ? LIMIT ?`,
        )
        .bind(opts.storeId, opts.limit);
    } else if (opts.tenantId) {
      stmt = this.db
        .prepare(
          `SELECT m.id, m.store_id, m.path, m.content
           FROM memories m JOIN memory_stores s ON s.id = m.store_id
           WHERE m.vector_synced_at IS NULL AND s.tenant_id = ? LIMIT ?`,
        )
        .bind(opts.tenantId, opts.limit);
    } else {
      stmt = this.db
        .prepare(
          `SELECT id, store_id, path, content FROM memories
           WHERE vector_synced_at IS NULL LIMIT ?`,
        )
        .bind(opts.limit);
    }
    const result = await stmt.all<{ id: string; store_id: string; path: string; content: string }>();
    return (result.results ?? []).map((r) => ({
      id: r.id,
      storeId: r.store_id,
      path: r.path,
      content: r.content,
    }));
  }

  async countUnsynced(opts: { tenantId?: string }): Promise<number> {
    let stmt;
    if (opts.tenantId) {
      stmt = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories m
           JOIN memory_stores s ON s.id = m.store_id
           WHERE m.vector_synced_at IS NULL AND s.tenant_id = ?`,
        )
        .bind(opts.tenantId);
    } else {
      stmt = this.db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE vector_synced_at IS NULL`);
    }
    const row = await stmt.first<{ c: number }>();
    return row?.c ?? 0;
  }
}

function versionInsertStmt(db: D1Database, v: NewMemoryVersionInput): D1PreparedStatement {
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
  content: string;
  content_sha256: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
  vector_synced_at: number | null;
}

function toRow(r: DbMemory): MemoryRow {
  return {
    id: r.id,
    store_id: r.store_id,
    path: r.path,
    content: r.content,
    content_sha256: r.content_sha256,
    size_bytes: r.size_bytes,
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
    vector_synced_at: r.vector_synced_at ? msToIso(r.vector_synced_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
