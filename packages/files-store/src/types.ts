// Public types for the files store service. Mirrors the D1 schema in
// apps/main/migrations/0011_files_table.sql.
//
// Design choices:
//   - FileRow holds metadata only — the R2 blob lives in FILES_BUCKET under
//     `r2_key`. Service is intentionally R2-blind: routes own R2 PUT/GET/DELETE.
//   - `scope` is a denormalized enum ("session" | "tenant") that mirrors the
//     session_id NULL/non-NULL state. Kept explicit so a future "agent_scope"
//     or "user_scope" extension fits without a schema migration.
//   - `r2_key` is stored explicitly (instead of recomputed from
//     fileR2Key(tenant, id) every time) so the delete cascade can return the
//     R2 keys without needing a tenant-aware helper. Also future-proofs against
//     R2 key scheme changes (e.g. random suffixes for security).
//   - `downloadable` is a boolean stored as INTEGER (SQLite has no BOOL).
//     Adapter does the 0/1 ↔ false/true conversion.

import type { FileRecord } from "@open-managed-agents/shared";

export type FileScope = "session" | "tenant";

export interface FileRow {
  id: string;
  tenant_id: string;
  /** NULL when scope === "tenant". */
  session_id: string | null;
  scope: FileScope;
  filename: string;
  media_type: string;
  size_bytes: number;
  /** Whether the file content can be served back via GET /v1/files/:id/content. */
  downloadable: boolean;
  /** R2 object key. Stored so cascade-delete can return it without recomputing. */
  r2_key: string;
  created_at: string;
}

/**
 * Map a FileRow to the public FileRecord API shape that
 * apps/main/src/routes/files.ts returns. r2_key + scope + tenant_id are
 * server-internal — they don't show up in the API surface.
 */
export function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    type: "file",
    filename: row.filename,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    scope_id: row.session_id ?? undefined,
    downloadable: row.downloadable,
    created_at: row.created_at,
  };
}

/** Default page size (matches files.ts:101). */
export const DEFAULT_LIST_LIMIT = 100;

/** Hard cap on per-request page size (matches files.ts:103). */
export const MAX_LIST_LIMIT = 1000;
