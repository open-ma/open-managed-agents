import type { SessionSecretRepo } from "./ports";

export interface SessionSecretServiceDeps {
  repo: SessionSecretRepo;
}

/**
 * SessionSecretService — thin pass-through over a {@link SessionSecretRepo}.
 *
 * Owns:
 *   - The named-parameter object surface that consumer code uses
 *     (`{ tenantId, sessionId, resourceId, value }`) — keeps call sites
 *     readable and avoids positional-argument bugs.
 *   - The cascade-by-session method used by the session.delete handler (the
 *     repo does the actual paginated scan + delete; the service exposes it
 *     under a consumer-friendly name).
 *
 * Does NOT own:
 *   - Any business logic. Per-session secrets are opaque blobs. There is no
 *     limit-per-session check, no immutable-field check, no merge semantics.
 *   - The KV key format. That belongs to the adapter — consumers never see
 *     `t:{tenantId}:secret:{sessionId}:` strings.
 *   - Resource lifecycle. The session-resources rows live in sessions-store;
 *     this service only stores the opaque payload that some resource types
 *     (env, github_repository) carry alongside their metadata.
 *
 * Why this stays a separate package even though it's mostly a passthrough:
 * the future Redis / per-tenant-KV / Postgres-pgcrypto adapter will swap
 * exactly here — consumers depend on the {@link SessionSecretRepo} port, not
 * on `env.CONFIG_KV`.
 */
export class SessionSecretService {
  private readonly repo: SessionSecretRepo;

  constructor(deps: SessionSecretServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * Store an opaque secret for a session resource. Overwrites any existing
   * value at the same coordinates (last-writer-wins).
   */
  async put(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
    value: string;
  }): Promise<void> {
    await this.repo.put(opts.tenantId, opts.sessionId, opts.resourceId, opts.value);
  }

  /**
   * Read a secret. Returns null when no value is stored — caller (typically
   * SessionDO at warmup) interprets null as "no secret to mount".
   */
  async get(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<string | null> {
    return this.repo.get(opts.tenantId, opts.sessionId, opts.resourceId);
  }

  /**
   * Delete the secret for one resource. Best-effort: a missing key is a no-op.
   */
  async deleteOne(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<void> {
    await this.repo.deleteOne(opts.tenantId, opts.sessionId, opts.resourceId);
  }

  /**
   * Cascade delete every secret for a session. Called from the session.delete
   * handler after the session row + resources are gone. Returns the count of
   * deleted keys (0 if there were none) — useful for observability but not
   * load-bearing.
   */
  async deleteAllForSession(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<number> {
    return this.repo.deleteAllForSession(opts.tenantId, opts.sessionId);
  }
}
