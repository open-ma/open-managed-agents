/**
 * Build a tenant-scoped KV key.
 * Example: kvKey("usr_abc123", "agent", "agent-xyz") → "t:usr_abc123:agent:agent-xyz"
 */
export function kvKey(tenantId: string, ...parts: string[]): string {
  return `t:${tenantId}:${parts.join(":")}`;
}

/**
 * Build a tenant-scoped KV prefix for listing.
 * Example: kvPrefix("usr_abc123", "agent") → "t:usr_abc123:agent:"
 */
export function kvPrefix(tenantId: string, ...parts: string[]): string {
  return `t:${tenantId}:${parts.join(":")}:`;
}

/**
 * List all KV keys matching a prefix, handling cursor-based pagination.
 * KV.list() returns at most 1000 keys per call; this helper follows
 * cursors until all matching keys are collected.
 */
export async function kvListAll(
  kv: KVNamespace,
  prefix: string,
): Promise<KVNamespaceListKey<unknown>[]> {
  const keys: KVNamespaceListKey<unknown>[] = [];
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}
