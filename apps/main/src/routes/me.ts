// /v1/me — current-user identity, tenants, and CLI token mint.
//
// Designed multi-tenant-ready: GET /v1/me/tenants returns an array of all
// orgs the user belongs to. Today the array always has exactly one entry
// (1 user = 1 tenant — see auth-config.ts ensureTenant). When membership
// table lands, the array shape stays the same and the picker on the CLI
// login page automatically lights up — no client change needed.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>();

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  tenantId: string | null;
  role: string | null;
}

interface TenantRow {
  id: string;
  name: string;
}

async function loadUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT id, email, name, tenantId, role FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
}

async function loadTenant(db: D1Database, tenantId: string): Promise<TenantRow | null> {
  return db
    .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
    .bind(tenantId)
    .first<TenantRow>();
}

async function loadUserTenants(
  db: D1Database,
  userId: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  // Today every user has exactly one tenant (ensureTenant invariant).
  // The query is shaped to make the future migration trivial — when a
  // memberships join table lands, swap this for a JOIN against it and
  // the response shape stays identical.
  const user = await loadUser(db, userId);
  if (!user?.tenantId) return [];
  const tenant = await loadTenant(db, user.tenantId);
  if (!tenant) return [];
  return [{ id: tenant.id, name: tenant.name, role: user.role ?? "member" }];
}

// GET /v1/me — current user, current tenant, all tenants the user belongs to.
app.get("/", async (c) => {
  const userId = c.get("user_id");
  const tenantId = c.get("tenant_id");
  if (!userId) {
    // API key minted before user_id was tracked — return what we know.
    return c.json({
      user: null,
      tenant: { id: tenantId, name: "" },
      tenants: [{ id: tenantId, name: "", role: "member" }],
    });
  }
  const [user, tenant, tenants] = await Promise.all([
    loadUser(c.env.AUTH_DB, userId),
    loadTenant(c.env.AUTH_DB, tenantId),
    loadUserTenants(c.env.AUTH_DB, userId),
  ]);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    tenant: tenant ? { id: tenant.id, name: tenant.name } : { id: tenantId, name: "" },
    tenants,
  });
});

// GET /v1/me/tenants — list of tenants the user has access to. CLI calls
// this to populate its tenant picker.
app.get("/tenants", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ data: [{ id: c.get("tenant_id"), name: "", role: "member" }] });
  const tenants = await loadUserTenants(c.env.AUTH_DB, userId);
  return c.json({ data: tenants });
});

// ─── CLI token mint ──────────────────────────────────────────────────────
//
// Reuses the existing api_keys storage (KV: apikey:<sha256> → record;
// per-tenant index at t:<tenantId>:apikeys). The minted key is
// indistinguishable from a console-created key; user can revoke it from
// the API Keys page.

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
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

interface CliTokenBody {
  /** Optional — if omitted, uses the current session's tenant. When multi-
   *  tenant lands, this MUST be one of the tenants the user belongs to. */
  tenant_id?: string;
  /** Display name shown on the API Keys page so the user knows where the
   *  key is being used (typically "CLI on <hostname>" from the CLI side). */
  name?: string;
}

// POST /v1/me/cli-tokens — mint a CLI token (reuses the api_keys store).
// Cookie-auth only: api-key-auth requesters can't mint new keys via this.
app.post("/cli-tokens", async (c) => {
  const userId = c.get("user_id");
  const sessionTenantId = c.get("tenant_id");
  if (!userId) {
    return c.json({ error: "Cookie session required to mint CLI tokens" }, 403);
  }
  const body = await c.req.json<CliTokenBody>().catch((err) => {
    logWarn({ op: "me.cli_tokens.body_parse", user_id: userId, err }, "body parse failed; using defaults");
    return {} as CliTokenBody;
  });

  // Validate requested tenant against memberships. Today the membership set
  // is { user.tenantId }; in the future this is the join-table check that
  // makes per-tenant access enforcement real.
  const allowed = await loadUserTenants(c.env.AUTH_DB, userId);
  const requested = body.tenant_id ?? sessionTenantId;
  const match = allowed.find((t) => t.id === requested);
  if (!match) {
    return c.json({ error: "Not a member of the requested tenant" }, 403);
  }

  const rawKey = generateRawKey();
  const hash = await sha256(rawKey);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const name = body.name?.slice(0, 80) || "CLI";

  // Same KV layout as POST /v1/api_keys so the auth middleware looks them
  // up identically and the API Keys page lists CLI tokens alongside others.
  await c.env.CONFIG_KV.put(
    `apikey:${hash}`,
    JSON.stringify({
      id,
      tenant_id: match.id,
      user_id: userId,
      name,
      created_at: now,
      source: "cli",
    }),
  );
  const indexKey = `t:${match.id}:apikeys`;
  const existingIndex = await c.env.CONFIG_KV.get(indexKey);
  type Meta = { id: string; name: string; prefix: string; hash: string; created_at: string };
  const index: Meta[] = existingIndex ? (JSON.parse(existingIndex) as Meta[]) : [];
  index.push({ id, name, prefix: rawKey.slice(0, 8), hash, created_at: now });
  await c.env.CONFIG_KV.put(indexKey, JSON.stringify(index));

  return c.json(
    {
      key_id: id,
      token: rawKey,
      tenant_id: match.id,
      user_id: userId,
      created_at: now,
    },
    201,
  );
});

export default app;
