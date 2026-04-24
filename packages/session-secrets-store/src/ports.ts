// Abstract port the SessionSecretService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement this against Cloudflare bindings; src/test-fakes.ts provides an
// in-memory implementation.
//
// Keep it tiny and runtime-agnostic: no Cloudflare types, no KV cursor
// language. Pass plain data + return plain data. The KV key format (currently
// `t:{tenantId}:secret:{sessionId}:{resourceId}`) is owned by the adapter —
// consumers never see it.
//
// Tenant routing: every method takes `tenantId` as the first argument. This
// makes tenantId a routing key, so a future per-tenant adapter (Redis cluster,
// per-tenant KV namespace, etc.) can pick a backend per call without any port
// changes. See packages/services/README.md "Per-tenant routing is an
// adapter-internal concern".

export interface SessionSecretRepo {
  /**
   * Store an opaque secret payload for a single session resource. Overwrites
   * any existing value at the same coordinates (last-writer-wins, matching
   * the KV-direct semantics of the previous call sites).
   */
  put(
    tenantId: string,
    sessionId: string,
    resourceId: string,
    value: string,
  ): Promise<void>;

  /**
   * Read a secret payload. Returns `null` when no value is stored — used by
   * SessionDO at warmup to decide whether to mount the secret into the sandbox
   * container (some resources never had a secret to begin with, e.g. a
   * `github_repository` without an authorization_token).
   */
  get(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<string | null>;

  /**
   * Delete the secret for a single resource. Best-effort: a missing key is a
   * no-op (matches the KV-direct DELETE semantics in sessions.ts:1031).
   */
  deleteOne(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<void>;

  /**
   * Cascade delete every secret belonging to a session — used by the
   * session.delete handler. Returns the number of keys deleted (0 if there
   * were none). Adapters MUST paginate the underlying scan correctly (KV
   * `list({ prefix })` returns up to 1000 keys per call, cursor-based).
   */
  deleteAllForSession(
    tenantId: string,
    sessionId: string,
  ): Promise<number>;
}
