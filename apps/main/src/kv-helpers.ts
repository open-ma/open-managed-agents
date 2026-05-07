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

// Re-export the KvStore-based listAll so existing callers can switch
// `import { kvListAll } from "../kv-helpers"` →
// `import { listAll } from "@open-managed-agents/kv-store"` without losing
// pagination behavior. Same logic, runtime-agnostic.
export { listAll as kvListAll } from "@open-managed-agents/kv-store";
