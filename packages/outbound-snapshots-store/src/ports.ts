// Abstract ports the OutboundSnapshotService depends on. Same DIP pattern as
// packages/credentials-store/src/ports.ts — concrete adapters in src/adapters/
// implement these against Cloudflare bindings; src/test-fakes.ts provides
// in-memory implementations.
//
// Keep these tiny and runtime-agnostic: no Cloudflare types, no KV API
// shapes. Pass plain data + return plain data.
//
// No tenant routing here: the snapshot key is intentionally untenanted
// (see types.ts) — the outbound worker only knows `sessionId` from the
// container context. The repo MUST key by `sessionId` alone.

import type { OutboundSnapshot } from "./types";

export interface OutboundSnapshotRepo {
  /**
   * Persist (or overwrite) the snapshot for `sessionId`. `ttlSeconds` is the
   * lifetime in seconds — adapters MUST honor it (KV maps to `expirationTtl`).
   */
  put(
    sessionId: string,
    snapshot: OutboundSnapshot,
    opts?: { ttlSeconds?: number },
  ): Promise<void>;

  /** Read the snapshot for `sessionId`, or null if missing / expired / malformed. */
  get(sessionId: string): Promise<OutboundSnapshot | null>;

  /**
   * Drop the snapshot for `sessionId`. Idempotent — adapters MUST NOT throw
   * on missing keys. Called from SessionDO `/destroy` to shrink the leak
   * window for plaintext OAuth material on the normal teardown path.
   */
  delete(sessionId: string): Promise<void>;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
}
