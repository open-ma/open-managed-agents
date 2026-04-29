// Public types for the memory store service. Mirrors the D1 schema in
// apps/main/migrations/0001_schema.sql + 0010_memory_add_etag.sql.

export type Actor =
  | { type: "api_key"; id: string }
  | { type: "user"; id: string }
  | { type: "agent_session"; id: string }
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

/**
 * A memory's index row + (optionally) its R2 content. D1 holds the index;
 * R2 holds the bytes-of-truth keyed `<store_id>/<path>`. The service fills
 * `content` on single-row reads (`readById`/`readByPath`) and leaves it
 * `undefined` on list responses to mirror Anthropic's `memories.list` shape.
 */
export interface MemoryRow {
  id: string;
  store_id: string;
  path: string;
  content_sha256: string;
  /** R2 object etag — used as the CAS primitive for `memories.update`. */
  etag: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  /** Filled on `readById` / `readByPath` (R2 GET). Undefined on list responses. */
  content?: string;
}

export interface MemoryVersionRow {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path: string | null;
  /** Inline snapshot — capped at 100KB. NULL after redact or for delete ops. */
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

/** Per-memory hard cap, mirrored from Anthropic Managed Agents docs (~25K tokens). */
export const MEMORY_CONTENT_MAX_BYTES = 100 * 1024;

/** Cap on `instructions` attached when a memory store is bound to a session,
 *  per the Anthropic spec (https://platform.claude.com/docs/en/managed-agents/memory). */
export const MEMORY_STORE_INSTRUCTIONS_MAX_CHARS = 4096;
