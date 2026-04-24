// In-memory implementation of the SessionSecretRepo for unit tests. Mirrors
// the prefix-iteration semantics of the KV adapter so tests catch the same
// cascade-by-session behavior.

import type { SessionSecretRepo } from "./ports";
import { SessionSecretService } from "./service";

export class InMemorySessionSecretRepo implements SessionSecretRepo {
  /**
   * Single Map keyed by the same `t:{tenant}:secret:{session}:{resource}`
   * string the KV adapter would use. Lets `deleteAllForSession` walk by
   * prefix the same way the KV `list({ prefix })` would.
   */
  private readonly byKey = new Map<string, string>();

  async put(
    tenantId: string,
    sessionId: string,
    resourceId: string,
    value: string,
  ): Promise<void> {
    this.byKey.set(keyFor(tenantId, sessionId, resourceId), value);
  }

  async get(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<string | null> {
    const v = this.byKey.get(keyFor(tenantId, sessionId, resourceId));
    return v === undefined ? null : v;
  }

  async deleteOne(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<void> {
    this.byKey.delete(keyFor(tenantId, sessionId, resourceId));
  }

  async deleteAllForSession(
    tenantId: string,
    sessionId: string,
  ): Promise<number> {
    const prefix = prefixFor(tenantId, sessionId);
    let n = 0;
    for (const k of Array.from(this.byKey.keys())) {
      if (k.startsWith(prefix)) {
        this.byKey.delete(k);
        n++;
      }
    }
    return n;
  }

  // ── test helpers ──

  /** Returns the count of stored secrets across all tenants/sessions. */
  size(): number {
    return this.byKey.size;
  }

  /**
   * Snapshot current contents — handy for assertions like
   * `expect(repo.entries()).toEqual([...])`. Returns plain `[key, value]`
   * pairs (the key is the internal `t:{tenant}:secret:{session}:{resource}`
   * string). Tests typically only care about the values; use this for
   * structural assertions.
   */
  entries(): [string, string][] {
    return Array.from(this.byKey.entries());
  }

  /** Wipe every stored secret — `beforeEach` helper. */
  clear(): void {
    this.byKey.clear();
  }
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * still construct `new SessionSecretService({ repo: ... })` directly if they
 * want to inject a custom repo.
 */
export function createInMemorySessionSecretService(): {
  service: SessionSecretService;
  repo: InMemorySessionSecretRepo;
} {
  const repo = new InMemorySessionSecretRepo();
  const service = new SessionSecretService({ repo });
  return { service, repo };
}

// ── helpers (mirror the adapter's key format) ──

function keyFor(tenantId: string, sessionId: string, resourceId: string): string {
  return `t:${tenantId}:secret:${sessionId}:${resourceId}`;
}

function prefixFor(tenantId: string, sessionId: string): string {
  return `t:${tenantId}:secret:${sessionId}:`;
}
