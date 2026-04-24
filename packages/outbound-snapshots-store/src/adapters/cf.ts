import type { OutboundSnapshotRepo } from "../ports";
import type { OutboundSnapshot } from "../types";

/**
 * Cloudflare KV implementation of {@link OutboundSnapshotRepo}. Owns the
 * `outbound:{sessionId}` key against the CONFIG_KV namespace.
 *
 * Key format MUST be exactly `outbound:${sessionId}` — no tenant prefix, no
 * additional segments. The outbound worker (apps/agent/src/outbound.ts) only
 * has `sessionId` from the container context and reconstructs this key
 * verbatim on the read side; any divergence here turns every request into a
 * cache miss and credentials never get injected.
 */
export class KvOutboundSnapshotRepo implements OutboundSnapshotRepo {
  constructor(private readonly kv: KVNamespace) {}

  async put(
    sessionId: string,
    snapshot: OutboundSnapshot,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    // Pass `expirationTtl` only when set — KV rejects `undefined` here on
    // some runtime versions, and omitting the option means "no TTL" which
    // is the wrong default for plaintext OAuth material. The service layer
    // always supplies a default, so opts.ttlSeconds is reliably present in
    // practice; we still guard for direct repo callers.
    const putOpts: KVNamespacePutOptions | undefined =
      opts?.ttlSeconds !== undefined ? { expirationTtl: opts.ttlSeconds } : undefined;
    await this.kv.put(keyFor(sessionId), JSON.stringify(snapshot), putOpts);
  }

  async get(sessionId: string): Promise<OutboundSnapshot | null> {
    const data = await this.kv.get(keyFor(sessionId));
    if (!data) return null;
    try {
      return JSON.parse(data) as OutboundSnapshot;
    } catch {
      // Malformed payload — treat as missing rather than throwing, matching
      // the previous outbound.ts behavior (loadSnapshot at outbound.ts:145).
      return null;
    }
  }

  async delete(sessionId: string): Promise<void> {
    // KV.delete is idempotent — returns void whether the key existed or not.
    await this.kv.delete(keyFor(sessionId));
  }
}

/** Key builder — exported as a constant pattern for clarity at the call site. */
function keyFor(sessionId: string): string {
  return `outbound:${sessionId}`;
}
