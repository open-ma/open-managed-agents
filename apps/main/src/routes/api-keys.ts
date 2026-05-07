import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string; services: Services };
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
  hash: string;
  created_at: string;
}

interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  /**
   * Creating user. Set when the key was minted from a logged-in session;
   * absent on legacy keys created before user_id was tracked. User-scoped
   * endpoints (e.g. /v1/integrations/linear/*) require this field.
   */
  user_id?: string;
  name: string;
  created_at: string;
}

// POST /v1/api_keys — create a new API key
app.post("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const userId = c.get("user_id");
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const name = body.name || "Untitled key";

  const rawKey = generateRawKey();
  const hash = await sha256(rawKey);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const record: ApiKeyRecord = {
    id,
    tenant_id: tenantId,
    ...(userId ? { user_id: userId } : {}),
    name,
    created_at: now,
  };
  await c.var.services.kv.put(`apikey:${hash}`, JSON.stringify(record));

  // Maintain per-tenant index
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.var.services.kv.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  index.push({ id, name, prefix: rawKey.slice(0, 8), hash, created_at: now });
  await c.var.services.kv.put(indexKey, JSON.stringify(index));

  // Return the raw key only once — it is never stored or retrievable again
  return c.json({ id, name, key: rawKey, prefix: rawKey.slice(0, 8), created_at: now }, 201);
});

// GET /v1/api_keys — list current tenant's API keys
app.get("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.var.services.kv.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  return c.json({ data: index.map(({ hash: _, ...rest }) => rest) });
});

// DELETE /v1/api_keys/:id — revoke an API key
app.delete("/:id", async (c) => {
  const tenantId = c.get("tenant_id");
  const keyId = c.req.param("id");

  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await c.var.services.kv.get(indexKey);
  const index: ApiKeyMeta[] = existing ? JSON.parse(existing) : [];
  const entry = index.find((k) => k.id === keyId);

  if (!entry) {
    return c.json({ error: "API key not found" }, 404);
  }

  const updated = index.filter((k) => k.id !== keyId);
  await Promise.all([
    c.var.services.kv.put(indexKey, JSON.stringify(updated)),
    entry.hash
      ? c.var.services.kv.delete(`apikey:${entry.hash}`)
      : Promise.resolve(),
  ]);

  return c.json({ type: "api_key_deleted", id: keyId });
});

export default app;
