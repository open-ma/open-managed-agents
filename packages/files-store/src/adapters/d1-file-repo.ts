import type {
  FileListOptions,
  FileRepo,
  NewFileInput,
} from "../ports";
import type { FileRow, FileScope } from "../types";

/**
 * Cloudflare D1 implementation of {@link FileRepo}. Owns the SQL against
 * the `files` table defined in apps/main/migrations/0011_files_table.sql.
 *
 * The schema has no FK by project convention — cascade-by-session lives in
 * the `deleteBySession` method below as a single indexed DELETE. Atomicity
 * is per-statement: there's no multi-row batch like the sessions adapter
 * because file inserts are always single-row.
 *
 * Booleans (`downloadable`) are stored as INTEGER 0/1 — SQLite has no native
 * BOOL. The toRow helper does the 0/1 ↔ false/true conversion.
 */
export class D1FileRepo implements FileRepo {
  constructor(private readonly db: D1Database) {}

  async insert(input: NewFileInput): Promise<FileRow> {
    await this.db
      .prepare(
        `INSERT INTO files
           (id, tenant_id, session_id, scope, filename, media_type,
            size_bytes, downloadable, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.sessionId,
        input.scope,
        input.filename,
        input.mediaType,
        input.sizeBytes,
        input.downloadable ? 1 : 0,
        input.r2Key,
        input.createdAt,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("file vanished after insert");
    return row;
  }

  async get(tenantId: string, fileId: string): Promise<FileRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, session_id, scope, filename, media_type,
                size_bytes, downloadable, r2_key, created_at
         FROM files
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(fileId, tenantId)
      .first<DbFile>();
    return row ? toRow(row) : null;
  }

  async list(tenantId: string, opts: FileListOptions): Promise<FileRow[]> {
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [tenantId];
    if (opts.sessionId !== undefined) {
      where.push("session_id = ?");
      binds.push(opts.sessionId);
    }
    if (opts.beforeId) {
      where.push("id < ?");
      binds.push(opts.beforeId);
    }
    if (opts.afterId) {
      where.push("id > ?");
      binds.push(opts.afterId);
    }
    binds.push(opts.limit);
    const sql = `SELECT id, tenant_id, session_id, scope, filename, media_type,
                        size_bytes, downloadable, r2_key, created_at
                 FROM files
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at ${order}
                 LIMIT ?`;
    const result = await this.db.prepare(sql).bind(...binds).all<DbFile>();
    return (result.results ?? []).map(toRow);
  }

  async delete(tenantId: string, fileId: string): Promise<FileRow | null> {
    // Read first so we can return the row (caller needs r2_key for R2 delete).
    // Using a separate SELECT + DELETE is fine — files-store has no contention
    // semantics that would make a RETURNING-style atomicity matter here.
    const existing = await this.get(tenantId, fileId);
    if (!existing) return null;
    await this.db
      .prepare(`DELETE FROM files WHERE id = ? AND tenant_id = ?`)
      .bind(fileId, tenantId)
      .run();
    return existing;
  }

  async deleteBySession(sessionId: string): Promise<FileRow[]> {
    // Two-step: SELECT then DELETE so we can return the deleted rows for R2
    // cleanup. A single transaction would be ideal but D1.batch can't mix
    // SELECT into a write batch — and per-row delete would amplify roundtrips.
    const result = await this.db
      .prepare(
        `SELECT id, tenant_id, session_id, scope, filename, media_type,
                size_bytes, downloadable, r2_key, created_at
         FROM files
         WHERE session_id = ?`,
      )
      .bind(sessionId)
      .all<DbFile>();
    const rows = (result.results ?? []).map(toRow);
    if (!rows.length) return [];
    await this.db
      .prepare(`DELETE FROM files WHERE session_id = ?`)
      .bind(sessionId)
      .run();
    return rows;
  }
}

interface DbFile {
  id: string;
  tenant_id: string;
  session_id: string | null;
  scope: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  downloadable: number;
  r2_key: string;
  created_at: number;
}

function toRow(r: DbFile): FileRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    session_id: r.session_id,
    scope: r.scope as FileScope,
    filename: r.filename,
    media_type: r.media_type,
    size_bytes: r.size_bytes,
    downloadable: r.downloadable === 1,
    r2_key: r.r2_key,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
