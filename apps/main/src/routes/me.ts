// /v1/me — current-user identity, tenants, and CLI token mint.
//
// Pattern A multi-tenant: GET /v1/me/tenants returns every tenant the
// user belongs to (one row per `membership`). The CLI shows a picker
// when there's more than one and mints a per-tenant token via
// POST /v1/me/cli-tokens — switching tenants in the CLI re-runs that
// flow so each token stays scoped to a single tenant.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import { listMemberships, hasMembership } from "../auth-config";

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

// GET /v1/me — current user, current tenant (the one resolved by auth
// middleware for THIS request, honoring x-active-tenant), and every
// tenant the user belongs to.
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
  const [user, tenant, memberships] = await Promise.all([
    loadUser(c.env.AUTH_DB, userId),
    loadTenant(c.env.AUTH_DB, tenantId),
    listMemberships(c.env.AUTH_DB, userId),
  ]);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    tenant: tenant ? { id: tenant.id, name: tenant.name } : { id: tenantId, name: "" },
    tenants: memberships,
  });
});

// GET /v1/me/tenants — list of tenants the user has access to. CLI calls
// this to populate its tenant picker; Console calls it to populate the
// sidebar tenant switcher.
app.get("/tenants", async (c) => {
  const userId = c.get("user_id");
  if (!userId) {
    return c.json({ data: [{ id: c.get("tenant_id"), name: "", role: "member" }] });
  }
  const memberships = await listMemberships(c.env.AUTH_DB, userId);
  return c.json({ data: memberships });
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
  /** Optional — if omitted, uses the current session's tenant. Must be a
   *  tenant the user belongs to (membership table is the source of truth). */
  tenant_id?: string;
  /** Display name shown on the API Keys page so the user knows where the
   *  key is being used (typically "CLI on <hostname>" from the CLI side). */
  name?: string;
}

// POST /v1/me/cli-tokens — mint a CLI token bound to a specific tenant.
// Cookie-auth only: api-key requesters can't mint new keys here (they
// already have one).
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

  // Validate against the membership table — never trust client-claimed
  // tenant ids without confirming the user actually has access.
  const requested = body.tenant_id ?? sessionTenantId;
  const ok = await hasMembership(c.env.AUTH_DB, userId, requested);
  if (!ok) {
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
      tenant_id: requested,
      user_id: userId,
      name,
      created_at: now,
      source: "cli",
    }),
  );
  const indexKey = `t:${requested}:apikeys`;
  const existingIndex = await c.env.CONFIG_KV.get(indexKey);
  type Meta = { id: string; name: string; prefix: string; hash: string; created_at: string };
  const index: Meta[] = existingIndex ? (JSON.parse(existingIndex) as Meta[]) : [];
  index.push({ id, name, prefix: rawKey.slice(0, 8), hash, created_at: now });
  await c.env.CONFIG_KV.put(indexKey, JSON.stringify(index));

  return c.json(
    {
      key_id: id,
      token: rawKey,
      tenant_id: requested,
      user_id: userId,
      created_at: now,
    },
    201,
  );
});

export default app;
