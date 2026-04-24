import type { Logger, OutboundSnapshotRepo } from "./ports";
import {
  DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS,
  OutboundSnapshot,
} from "./types";

export interface OutboundSnapshotServiceDeps {
  repo: OutboundSnapshotRepo;
  logger?: Logger;
}

/**
 * OutboundSnapshotService — pure pass-through over an abstract repo.
 *
 * Owns:
 *   - default TTL (DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS) when caller omits one
 *
 * Does NOT own:
 *   - The snapshot shape (callers build it from CredentialService rows at
 *     session init; service is content-agnostic).
 *   - Vault / credential validation — the snapshot is opaque from the
 *     service's POV.
 *   - Token refresh — that's the outbound worker's job (it reads the snapshot,
 *     refreshes via OAuth, then calls `publish` to write the new snapshot back).
 *
 * This service is intentionally thin. The value of the package is the port
 * boundary + adapter swap — not business logic. Future adapters (Redis,
 * Postgres, in-memory) plug in without touching SessionDO or the outbound
 * worker.
 */
export class OutboundSnapshotService {
  private readonly repo: OutboundSnapshotRepo;
  private readonly logger: Logger;

  constructor(deps: OutboundSnapshotServiceDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  /**
   * Publish the snapshot for `sessionId`. Defaults `ttlSeconds` to
   * {@link DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS} when not set — used by
   * SessionDO at session init AND by the outbound worker after a successful
   * OAuth refresh (resets the lifetime so an active session keeps its
   * credentials live; an idle one ages out within the same 24h window).
   */
  async publish(params: {
    sessionId: string;
    snapshot: OutboundSnapshot;
    ttlSeconds?: number;
  }): Promise<void> {
    const ttlSeconds = params.ttlSeconds ?? DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS;
    await this.repo.put(params.sessionId, params.snapshot, { ttlSeconds });
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(params: { sessionId: string }): Promise<OutboundSnapshot | null> {
    return this.repo.get(params.sessionId);
  }

  // ============================================================
  // Delete paths
  // ============================================================

  /**
   * Drop the snapshot for `sessionId`. Called from SessionDO `/destroy` —
   * idempotent at the adapter level, never throws on missing keys.
   */
  async delete(params: { sessionId: string }): Promise<void> {
    await this.repo.delete(params.sessionId);
  }
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
