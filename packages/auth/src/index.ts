// Runtime-agnostic auth Hono middleware.
//
// Resolution priority (matches both apps/main/src/auth.ts and
// apps/main-node/src/auth/middleware.ts pre-extract):
//
//   1. AUTH_DISABLED → tenant_id="default", user_id undefined.
//   2. x-api-key header → resolveApiKey() → {tenant_id, user_id?}.
//   3. Cookie session → resolveSession() → {user_id} → tenant via
//      x-active-tenant (validated against membership) or
//      defaultTenantForUser → ensureTenantForUser self-heal.
//   4. Otherwise 401.
//
// Resolvers are runtime-injected: CF passes resolvers backed by D1
// + better-auth + KV-hashed apikey lookup; Node passes the same shape
// backed by SqlClient + a new api_keys table + better-auth on PG/sqlite.

import { createMiddleware } from "hono/factory";

export interface AuthSession {
  userId: string;
  email?: string | null;
  name?: string | null;
}

export interface ApiKeyResolution {
  tenantId: string;
  userId?: string;
}

export interface AuthMiddlewareDeps {
  /** True bypasses auth entirely; tenant_id="default". */
  disabled: boolean;
  /** Resolve a session cookie → user info. Return null on miss. */
  resolveSession(headers: Headers): Promise<AuthSession | null>;
  /** Resolve an x-api-key value → tenant + optional user. Null on miss. */
  resolveApiKey(apiKey: string): Promise<ApiKeyResolution | null>;
  /** Look up the user's default tenant (first membership by created_at). */
  defaultTenantForUser(userId: string): Promise<string | null>;
  /** Validate (user, tenant) membership — used for x-active-tenant. */
  hasMembership(userId: string, tenantId: string): Promise<boolean>;
  /** Self-heal: mint a tenant for a logged-in user with no memberships. */
  ensureTenantForUser(session: AuthSession): Promise<string>;
  /** Path-prefix predicate — request paths matching are allowed through
   *  without auth. Default: /health and /auth/*.  Used for /v1/internal
   *  (header-secret) and /v1/mcp-proxy (Bearer-on-every-request). */
  bypassPath?(path: string): boolean;
}

const DEFAULT_BYPASS = (path: string) =>
  path === "/health" || path.startsWith("/auth/");

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const bypassPath = deps.bypassPath ?? DEFAULT_BYPASS;
  return createMiddleware<{
    Variables: { tenant_id: string; user_id?: string };
  }>(async (c, next) => {
    if (bypassPath(c.req.path)) return next();

    if (deps.disabled) {
      c.set("tenant_id", "default");
      return next();
    }

    // 1. API key
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const r = await deps.resolveApiKey(apiKey);
      if (!r) return c.json({ error: "Invalid API key" }, 401);
      c.set("tenant_id", r.tenantId);
      if (r.userId) c.set("user_id", r.userId);
      return next();
    }

    // 2. Cookie session
    let session: AuthSession | null = null;
    try {
      session = await deps.resolveSession(c.req.raw.headers);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    // 3. Tenant resolution.
    let tenantId: string | null = null;
    const requested = c.req.header("x-active-tenant") || "";
    if (requested) {
      const ok = await deps.hasMembership(session.userId, requested);
      if (!ok) return c.json({ error: "Not a member of the requested tenant" }, 403);
      tenantId = requested;
    }
    if (!tenantId) tenantId = await deps.defaultTenantForUser(session.userId);
    if (!tenantId) tenantId = await deps.ensureTenantForUser(session);

    c.set("tenant_id", tenantId);
    c.set("user_id", session.userId);
    return next();
  });
}
