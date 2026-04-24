// In-memory implementation of OutboundSnapshotRepo for unit tests. Mirrors
// the TTL semantics of the KV adapter (best-effort: when `ttlSeconds` is
// supplied, expired entries return null on `get`).

import type { Logger, OutboundSnapshotRepo } from "./ports";
import { OutboundSnapshotService } from "./service";
import type { OutboundSnapshot } from "./types";

interface InMemEntry {
  snapshot: OutboundSnapshot;
  /** Absolute epoch ms after which the entry is considered expired, or null for no TTL. */
  expiresAtMs: number | null;
}

/**
 * Map-backed in-memory repo. Tests wire this directly via
 * {@link createInMemoryOutboundSnapshotService}, or pass a custom Date-source
 * via the `now` factory option for deterministic TTL assertions.
 */
export class InMemoryOutboundSnapshotRepo implements OutboundSnapshotRepo {
  private readonly bySessionId = new Map<string, InMemEntry>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  async put(
    sessionId: string,
    snapshot: OutboundSnapshot,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    const expiresAtMs =
      opts?.ttlSeconds !== undefined ? this.now() + opts.ttlSeconds * 1000 : null;
    this.bySessionId.set(sessionId, { snapshot, expiresAtMs });
  }

  async get(sessionId: string): Promise<OutboundSnapshot | null> {
    const entry = this.bySessionId.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && this.now() >= entry.expiresAtMs) {
      // Expired — drop it lazily so callers don't observe stale snapshots and
      // memory doesn't grow unbounded across tests.
      this.bySessionId.delete(sessionId);
      return null;
    }
    return entry.snapshot;
  }

  async delete(sessionId: string): Promise<void> {
    this.bySessionId.delete(sessionId);
  }

  /** Test-only escape hatch: number of resident entries (post-expiry). */
  size(): number {
    return this.bySessionId.size;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass a deterministic `now()` if they need to assert TTL expiry.
 */
export function createInMemoryOutboundSnapshotService(opts?: {
  now?: () => number;
  logger?: Logger;
}): {
  service: OutboundSnapshotService;
  repo: InMemoryOutboundSnapshotRepo;
} {
  const repo = new InMemoryOutboundSnapshotRepo({ now: opts?.now });
  const service = new OutboundSnapshotService({
    repo,
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}
