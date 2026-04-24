// Abstract ports the FileService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts and packages/sessions-store/src/ports.ts —
// concrete adapters in src/adapters/ implement these against Cloudflare bindings;
// src/test-fakes.ts provides in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no D1 query
// language. Pass plain data + return plain data. The schema is no-FK by
// project convention; cascade-by-session lives in this port so adapters and
// the in-memory fake share one canonical implementation.

import type { FileRow, FileScope } from "./types";

export interface NewFileInput {
  id: string;
  tenantId: string;
  /** NULL when scope === "tenant". */
  sessionId: string | null;
  scope: FileScope;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  downloadable: boolean;
  r2Key: string;
  createdAt: number;
}

export interface FileListOptions {
  /**
   * Optional session filter — when set, returns ONLY files where
   * session_id = sessionId (the previous filebyscope: KV index path).
   * When undefined, returns ALL files for the tenant (both scopes).
   */
  sessionId?: string;
  /** Cursor: return files with id < beforeId (lexicographic). */
  beforeId?: string;
  /** Cursor: return files with id > afterId (lexicographic). */
  afterId?: string;
  /** Sort by created_at — desc matches the GET list default (files.ts:99). */
  order: "asc" | "desc";
  /** Page size. Adapter clamps via DEFAULT_LIST_LIMIT / MAX_LIST_LIMIT. */
  limit: number;
}

export interface FileRepo {
  insert(input: NewFileInput): Promise<FileRow>;

  get(tenantId: string, fileId: string): Promise<FileRow | null>;

  list(tenantId: string, opts: FileListOptions): Promise<FileRow[]>;

  /**
   * Hard-delete a file row. Returns the deleted row (so the caller can pull
   * the r2_key out and DELETE the R2 object). Returns null if the row did
   * not exist or did not belong to the tenant.
   */
  delete(tenantId: string, fileId: string): Promise<FileRow | null>;

  /**
   * Cascade hard-delete every file scoped to a session. Returns the deleted
   * rows so the caller can DELETE each from R2. Used by the session-delete
   * cleanup path (currently a TODO in routes/sessions.ts — service exposes
   * the capability for when that lands).
   */
  deleteBySession(sessionId: string): Promise<FileRow[]>;
}

export interface Clock {
  nowMs(): number;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
