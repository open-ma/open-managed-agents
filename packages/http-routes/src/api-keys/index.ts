// API key routes — POST returns plaintext once, GET lists, DELETE revokes.
//
// Storage is pluggable: CF uses CONFIG_KV apikey:<sha256> + per-tenant
// index lists; Node uses a SQL `api_keys` table (defined in
// @open-managed-agents/schema). Both runtimes implement the
// ApiKeyStorage port and pass it in.
//
// auth-middleware looks up the same hash via storage.findByHash() — so
// once a runtime swaps storage adapter, key resolution + management
// stay in sync without per-route conditionals.

import { Hono } from "hono";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

export interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  source?: string;
}

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  user_id?: string;
  name: string;
  created_at: string;
  source?: string;
}

export interface ApiKeyStorage {
  /** Persist a new key. `hash` is sha256(rawKey) hex; `prefix` is the
   *  first 8 chars of the raw key for display. */
  insert(input: {
    id: string;
    hash: string;
    prefix: string;
    record: ApiKeyRecord;
  }): Promise<void>;
  /** List the tenant's keys for /v1/api_keys GET — never include the hash
   *  itself, just the meta. */
  listByTenant(tenantId: string): Promise<ApiKeyMeta[]>;
  /** Find by hash — used by auth-middleware on every x-api-key request. */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  /** Delete by id. Returns true if it existed. */
  deleteById(tenantId: string, id: string): Promise<boolean>;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  const bytes = new Uint8Array(36);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "oma_";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

export interface ApiKeyRoutesDeps {
  storage: ApiKeyStorage;
}

export function buildApiKeyRoutes(deps: ApiKeyRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/", async (c) => {
    const tenantId = c.var.tenant_id;
    const userId = c.var.user_id;
    const body = await c.req
      .json<{ name?: string }>()
      .catch(() => ({}) as { name?: string });
    const name = body.name || "Untitled key";

    const raw = generateRawKey();
    const hash = await sha256Hex(raw);
    const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    await deps.storage.insert({
      id,
      hash,
      prefix: raw.slice(0, 8),
      record: {
        id,
        tenant_id: tenantId,
        ...(userId ? { user_id: userId } : {}),
        name,
        created_at: now,
      },
    });
    return c.json({ id, name, key: raw, prefix: raw.slice(0, 8), created_at: now }, 201);
  });

  app.get("/", async (c) => {
    const data = await deps.storage.listByTenant(c.var.tenant_id);
    return c.json({ data });
  });

  app.delete("/:id", async (c) => {
    const ok = await deps.storage.deleteById(c.var.tenant_id, c.req.param("id"));
    if (!ok) return c.json({ error: "API key not found" }, 404);
    return c.json({ type: "api_key_deleted", id: c.req.param("id") });
  });

  return app;
}

/** Helper exposed for /me/cli-tokens — same KV/SQL row shape, just the
 *  insert step. Returns the meta the route should echo back. */
export async function mintApiKeyOnStorage(
  storage: ApiKeyStorage,
  input: { tenantId: string; userId: string; name: string; source?: string },
): Promise<{ id: string; key: string; prefix: string; createdAt: string }> {
  const raw = generateRawKey();
  const hash = await sha256Hex(raw);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  await storage.insert({
    id,
    hash,
    prefix: raw.slice(0, 8),
    record: {
      id,
      tenant_id: input.tenantId,
      user_id: input.userId,
      name: input.name,
      created_at: now,
      source: input.source,
    },
  });
  return { id, key: raw, prefix: raw.slice(0, 8), createdAt: now };
}

export { sha256Hex };
