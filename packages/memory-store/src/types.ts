// Public types for the memory store service. Mirrors the D1 schema in
// apps/main/migrations/0007_memory_tables.sql.

export type Actor =
  | { type: "api_key"; id: string }
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "system"; id: string };

export interface MemoryStoreRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}

export interface MemoryRow {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  /** ISO timestamp when Vectorize was last in sync, or null if pending reconcile. */
  vector_synced_at: string | null;
}

export interface MemoryVersionRow {
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
  created_at: string;
  redacted: boolean;
}

export type WritePrecondition =
  | { type: "not_exists" }
  | { type: "content_sha256"; content_sha256: string };

export interface SearchHit {
  id: string;
  path: string;
  content: string;
  score: number;
}

export interface ReconcileResult {
  scanned: number;
  fixed: number;
  still_failing: number;
  /** Up to 5 sample errors for debugging. */
  sample_errors: Array<{ memory_id: string; error: string }>;
}

/** Per-memory hard cap, mirrored from Anthropic Managed Agents docs (~25K tokens). */
export const MEMORY_CONTENT_MAX_BYTES = 100 * 1024;
