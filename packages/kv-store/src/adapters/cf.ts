// Cloudflare KV implementation of KvStore.
//
// Direct passthrough to the KVNamespace binding. The only translations are:
//   - Skip `expirationTtl: undefined` in put options because some runtime
//     versions reject the explicit undefined.
//   - Map `list_complete` and `cursor` shapes verbatim.

import type {
  KvListOptions,
  KvListResult,
  KvPutOptions,
  KvStore,
} from "../ports";

export class CfKvStore implements KvStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
    const putOpts: KVNamespacePutOptions = {};
    if (opts?.expirationTtl !== undefined) putOpts.expirationTtl = opts.expirationTtl;
    if (opts?.expiration !== undefined) putOpts.expiration = opts.expiration;
    await this.kv.put(key, value, Object.keys(putOpts).length > 0 ? putOpts : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(opts?: KvListOptions): Promise<KvListResult> {
    const result = await this.kv.list({
      prefix: opts?.prefix,
      cursor: opts?.cursor,
      limit: opts?.limit,
    });
    return {
      keys: result.keys.map((k) => ({
        name: k.name,
        expiration: k.expiration,
      })),
      list_complete: result.list_complete,
      // KV result.cursor is always present in the type but only meaningful
      // when list_complete is false.
      cursor: result.list_complete ? undefined : result.cursor,
    };
  }
}

/** Convenience: wrap a KVNamespace binding as a KvStore. Returns null when the
 *  binding is undefined so call sites can keep their existing "binding optional"
 *  semantics without manually wrapping the helper. */
export function kvStoreFromKv(kv: KVNamespace | undefined): KvStore | null {
  return kv ? new CfKvStore(kv) : null;
}
