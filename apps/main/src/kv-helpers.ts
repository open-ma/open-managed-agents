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
