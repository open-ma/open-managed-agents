// In-memory KvStore for tests and local development.
//
// Tracks per-key expiration. Expired keys are filtered on get / list (lazy
// cleanup); not actively purged. Sufficient for short-lived test runs.
//
// Cursor scheme: opaque base64 of `start_index|prefix` so a follow-up call
// resumes mid-stream. Listing under heavy concurrent mutation can return
// inconsistent results (no snapshotting) — same caveat as CF KV.

import type {
  KvListKey,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  KvStore,
} from "../ports";

interface InMemoryEntry {
  value: string;
  /** Absolute expiry ms; undefined = no expiry. */
  expiresAt?: number;
}

export class InMemoryKvStore implements KvStore {
  private map = new Map<string, InMemoryEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
    let expiresAt: number | undefined;
    if (opts?.expirationTtl !== undefined) {
      expiresAt = Date.now() + opts.expirationTtl * 1000;
    } else if (opts?.expiration !== undefined) {
      expiresAt = opts.expiration * 1000;
    }
    this.map.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(opts?: KvListOptions): Promise<KvListResult> {
    const prefix = opts?.prefix ?? "";
    const limit = opts?.limit ?? 1000;
    const start = opts?.cursor ? parseCursor(opts.cursor) : 0;

    const now = Date.now();
    // Filter, gather, sort by name (matches CF behavior).
    const all: KvListKey[] = [];
    for (const [name, entry] of this.map) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      all.push({
        name,
        expiration: entry.expiresAt !== undefined ? Math.floor(entry.expiresAt / 1000) : undefined,
      });
    }
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const slice = all.slice(start, start + limit);
    const nextStart = start + slice.length;
    const list_complete = nextStart >= all.length;
    return {
      keys: slice,
      list_complete,
      cursor: list_complete ? undefined : encodeCursor(nextStart),
    };
  }

  // ─── test helpers ─────────────────────────────────────────────────────────

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

function encodeCursor(idx: number): string {
  return btoa(String(idx));
}

function parseCursor(c: string): number {
  try {
    const n = Number.parseInt(atob(c), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
