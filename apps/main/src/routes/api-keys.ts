import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string };
}>();

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  const bytes = new Uint8Array(36);
  crypto.getRandomValues(bytes);
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "oma_";
  for (const b of bytes) {
    result += chars[b % chars.length];
  }
  return result;
}

interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
}

interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
}

// POST /v1/api_keys — create a new API key
app.post("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const name = body.name || "Untitled key";

  const rawKey = generateRawKey();
  const hash = await sha256(rawKey);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const record: ApiKeyRecord = { id, tenant_id: tenantId, name, created_at: now };
  await c.env.CONFIG_KV.put(`apikey:${hash}`, JSON.stringify(record));

  // Maintain per-tenant index
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.env.CONFIG_KV.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  index.push({ id, name, prefix: rawKey.slice(0, 8), created_at: now });
  await c.env.CONFIG_KV.put(indexKey, JSON.stringify(index));

  // Return the raw key only once — it is never stored or retrievable again
  return c.json({ id, name, key: rawKey, prefix: rawKey.slice(0, 8), created_at: now }, 201);
});

// GET /v1/api_keys — list current tenant's API keys
app.get("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.env.CONFIG_KV.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  return c.json({ data: index });
});

// DELETE /v1/api_keys/:id — revoke an API key
app.delete("/:id", async (c) => {
  const tenantId = c.get("tenant_id");
  const keyId = c.req.param("id");

  // Remove from tenant index
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.env.CONFIG_KV.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  const updated = index.filter((k) => k.id !== keyId);

  if (updated.length === index.length) {
    return c.json({ error: "API key not found" }, 404);
  }

  await c.env.CONFIG_KV.put(indexKey, JSON.stringify(updated));

  // Scan and remove the hash entry (we don't store hash→id mapping, so we scan)
  const list = await c.env.CONFIG_KV.list({ prefix: "apikey:" });
  for (const k of list.keys) {
    const data = await c.env.CONFIG_KV.get(k.name);
    if (!data) continue;
    const record: ApiKeyRecord = JSON.parse(data);
    if (record.id === keyId && record.tenant_id === tenantId) {
      await c.env.CONFIG_KV.delete(k.name);
      break;
    }
  }

  return c.json({ type: "api_key_deleted", id: keyId });
});

export default app;
