// CF api-key storage adapter — wraps CONFIG_KV behind the http-routes
// ApiKeyStorage port. Same KV layout as the legacy apps/main/src/routes/
// api-keys.ts (sha256 hash key + per-tenant index). Matches what
// auth.ts already reads for x-api-key resolution.

import type { KvStore } from "@open-managed-agents/kv-store";
import type {
  ApiKeyMeta,
  ApiKeyRecord,
  ApiKeyStorage,
} from "@open-managed-agents/http-routes";

interface IndexEntry {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: string;
  source?: string;
}

function indexKey(tenantId: string): string {
  return `t:${tenantId}:apikeys`;
}

export function cfApiKeyStorage(kv: KvStore): ApiKeyStorage {
  return {
    async insert({ id, hash, prefix, record }) {
      await kv.put(`apikey:${hash}`, JSON.stringify(record));
      const idx = await readIndex(kv, record.tenant_id);
      idx.push({
        id,
        name: record.name,
        prefix,
        hash,
        created_at: record.created_at,
        ...(record.source ? { source: record.source } : {}),
      });
      await kv.put(indexKey(record.tenant_id), JSON.stringify(idx));
    },
    async listByTenant(tenantId) {
      const idx = await readIndex(kv, tenantId);
      return idx.map<ApiKeyMeta>(({ hash: _hash, ...rest }) => rest);
    },
    async findByHash(hash) {
      const raw = await kv.get(`apikey:${hash}`);
      return raw ? (JSON.parse(raw) as ApiKeyRecord) : null;
    },
    async deleteById(tenantId, id) {
      const idx = await readIndex(kv, tenantId);
      const entry = idx.find((e) => e.id === id);
      if (!entry) return false;
      const next = idx.filter((e) => e.id !== id);
      await kv.put(indexKey(tenantId), JSON.stringify(next));
      if (entry.hash) await kv.delete(`apikey:${entry.hash}`);
      return true;
    },
  };
}

async function readIndex(kv: KvStore, tenantId: string): Promise<IndexEntry[]> {
  const raw = await kv.get(indexKey(tenantId));
  return raw ? (JSON.parse(raw) as IndexEntry[]) : [];
}
