import type { MemoryVersionRepo } from "../ports";
import type { Actor, MemoryVersionRow } from "../types";

/**
 * Cloudflare D1 implementation of {@link MemoryVersionRepo}. Read + redact
 * paths over the memory_versions table; the write path lives in
 * {@link D1MemoryRepo} because every version write is paired with a memory
 * mutation in the same D1 batch.
 */
export class D1MemoryVersionRepo implements MemoryVersionRepo {
  constructor(private readonly db: D1Database) {}

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
