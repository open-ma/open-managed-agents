// Runtime-agnostic KV (key-value with TTL) port.
//
// Goal: separate "where the keys live" (Cloudflare KV / Postgres table /
// Redis / in-memory) from "how the app reads/writes them". Mirrors the
// Cloudflare KV surface that's actually used in OMA — get/put with TTL/list
// with prefix-paginated cursor — minus the multi-format helpers (getJSON,
// metadata) that we don't use.
//
// What this is for:
//   - Counters with TTL (quotas.ts daily session cap)
//   - Skill metadata blobs (apps/main/src/routes/skills.ts, clawhub.ts)
//   - API key records (apps/main/src/routes/api-keys.ts, mcp-proxy.ts)
//   - User-account settings (apps/main/src/routes/me.ts)
//   - Cost-report pricing (apps/main/src/routes/cost-report.ts)
//
// What this is NOT for: store-package internal KV usage like
// KvOutboundSnapshotRepo / KvSessionSecretRepo — those are already runtime-
// isolated by the adapter pattern; their self-host cousins will be SQL-table-
// backed Sqlite/Pg adapters built in Phase C, not KvStore wrappers.

export interface KvPutOptions {
  /** Time-to-live in seconds. Omit for no expiry. */
  expirationTtl?: number;
  /** Absolute expiry as a Unix timestamp (seconds). Omit for no expiry. */
  expiration?: number;
}

export interface KvListOptions {
  /** Only return keys starting with this prefix. */
  prefix?: string;
  /** Pagination cursor from a previous list() call. */
  cursor?: string;
  /** Per-page cap. CF caps to 1000; adapters MAY honor a smaller value. */
  limit?: number;
}

export interface KvListKey {
  name: string;
  /** Absolute expiry timestamp (Unix seconds), if the key has TTL. */
  expiration?: number;
}

export interface KvListResult {
  keys: KvListKey[];
  /** True when the iteration is complete; false when more pages exist. */
  list_complete: boolean;
  /** Cursor for the next page; only meaningful when list_complete=false. */
  cursor?: string;
}

/**
 * The port. Implementations:
 *   - CfKvStore (adapters/cf.ts) — wraps a CF KVNamespace
 *   - InMemoryKvStore (adapters/in-memory.ts) — for tests / dev
 *   - SqliteKvStore / PgKvStore — TODO when self-host storage lands
 */
export interface KvStore {
  get(key: string): Promise<string | null>;

  put(key: string, value: string, opts?: KvPutOptions): Promise<void>;

  delete(key: string): Promise<void>;

  list(opts?: KvListOptions): Promise<KvListResult>;
}

/**
 * Convenience: walk every key matching `prefix`, following pagination cursors
 * until exhausted. Returns the flat key list.
 *
 * Equivalent of the previous `kvListAll(KVNamespace, prefix)` helper in
 * apps/main/src/kv-helpers.ts but operates on a KvStore instead.
 */
export async function listAll(kv: KvStore, prefix: string): Promise<KvListKey[]> {
  const keys: KvListKey[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}
