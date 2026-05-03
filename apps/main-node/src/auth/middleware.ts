// Auth middleware for the CFless Node side. Runs before /v1/* routes.
// Resolution priority:
//
//   1. AUTH_DISABLED=1 → tenant_id = "default" for every request
//      (escape hatch for local demos that don't want to set up a user
//      first; matches the behaviour from before this commit).
//   2. Cookie session → better-auth getSession → user.id → membership lookup
//      (with optional x-active-tenant header pin, validated against the
//      membership table — never trust the header blindly).
//   3. Otherwise → 401.
//
// API key auth (the x-api-key path apps/main supports) is deliberately
// out of scope for this PoC commit. Add it next pass when we have a /v1
// /api_keys route to mint them.
//
// Routes that bypass auth entirely:
//   - GET /health
//   - /auth/* (the better-auth handler — must not require auth itself).
//     Path matches CF: apps/main exposes better-auth at /auth/* too.

import { createMiddleware } from "hono/factory";
import type { Auth } from "./config.js";
import { ensureTenantSqlite, getDefaultTenantId, hasMembership } from "./tenants.js";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface AuthMiddlewareDeps {
  auth: Auth;
  mainSql: SqlClient;
  /** When true, bypass auth and pin tenant_id="default" on every request. */
  disabled: boolean;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  return createMiddleware<{
    Variables: { tenant_id: string; user_id?: string };
  }>(async (c, next) => {
    // Bypass paths.
    const path = c.req.path;
    if (path === "/health" || path.startsWith("/auth/")) {
      return next();
    }

    if (deps.disabled) {
      c.set("tenant_id", "default");
      return next();
    }

    let session: Awaited<ReturnType<Auth["api"]["getSession"]>> | null = null;
    try {
      session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    } catch (err) {
      console.error("[auth] session check threw:", err);
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!session?.user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Tenant resolution.
    //   1. x-active-tenant header (multi-tenant users picking active workspace)
    //   2. Default tenant from membership (first by created_at)
    //   3. ensureTenantSqlite self-heal (legacy users whose hook never ran)
    let tenantId: string | null = null;
    const requested = c.req.header("x-active-tenant") || "";
    if (requested) {
      const ok = await hasMembership(deps.mainSql, session.user.id, requested);
      if (!ok) {
        return c.json({ error: "Not a member of the requested tenant" }, 403);
      }
      tenantId = requested;
    }
    if (!tenantId) {
      tenantId = await getDefaultTenantId(deps.mainSql, session.user.id);
    }
    if (!tenantId) {
      tenantId = await ensureTenantSqlite(
        deps.mainSql,
        session.user.id,
        session.user.name ?? null,
        session.user.email ?? null,
      );
    }
    c.set("tenant_id", tenantId);
    c.set("user_id", session.user.id);
    return next();
  });
}
