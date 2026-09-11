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
  credential?:
    | { type: "workspace" }
    | { type: "environment"; environmentId: string }
    | {
        type: "environment_work_session";
        environmentId: string;
        sessionId: string;
        workId: string;
        claimedAt: string;
        generation: number;
      };
}

export interface BearerTokenRequest {
  token: string;
  method: string;
  path: string;
}

export interface AuthMiddlewareDeps {
  /** True bypasses auth entirely; tenant_id="default". */
  disabled: boolean;
  /** Resolve a session cookie → user info. Return null on miss. */
  resolveSession(headers: Headers): Promise<AuthSession | null>;
  /** Resolve an x-api-key value → tenant + optional user. Null on miss. */
  resolveApiKey(apiKey: string): Promise<ApiKeyResolution | null>;
  /** Resolve and scope-check a short-lived worker bearer. Workspace and
   * environment API keys are handled by resolveApiKey as a fallback. */
  resolveBearerToken?(
    request: BearerTokenRequest,
  ): Promise<ApiKeyResolution | null>;
  /** Look up the user's default tenant (first membership by created_at). */
  defaultTenantForUser(userId: string): Promise<string | null>;
  /** Validate (user, tenant) membership — used for x-active-tenant. */
  hasMembership(userId: string, tenantId: string): Promise<boolean>;
  /** Self-heal: mint a tenant for a logged-in user with no memberships. */
  ensureTenantForUser(session: AuthSession): Promise<string>;
  /** Path-prefix predicate — request paths matching are allowed through
   *  without auth. Default: /health and /auth/*.  Used for /v1/oma/internal
   *  (header-secret) and /v1/oma/mcp-proxy (Bearer-on-every-request). */
  bypassPath?(path: string): boolean;
}

function environmentWorkPath(environmentId: string): string {
  return `/v1/environments/${encodeURIComponent(environmentId)}/work`;
}

/** Environment service keys are Bearer-only and cannot escape their Work API. */
export function allowsApiKeyRequest(
  resolution: ApiKeyResolution,
  request: Pick<BearerTokenRequest, "path"> & { transport: "bearer" | "x-api-key" },
): boolean {
  if (resolution.credential?.type === "environment") {
    if (request.transport !== "bearer") return false;
    const root = environmentWorkPath(resolution.credential.environmentId);
    return request.path === root || request.path.startsWith(`${root}/`);
  }
  if (resolution.credential?.type === "environment_work_session") {
    // The cryptographic Work-token resolver already validates the exact
    // Session/Work route, method, claim generation, and expiry.
    return request.transport === "bearer";
  }

  // A workspace key may administer Work through the normal x-api-key API,
  // but it must never become a standing Environment Worker bearer. Embedded
  // and external workers therefore enter through the same environment-scoped
  // credential boundary.
  const isEnvironmentWork = /^\/v1\/environments\/[^/]+\/work(?:\/|$)/.test(
    request.path,
  );
  return !(request.transport === "bearer" && isEnvironmentWork);
}

const DEFAULT_BYPASS = (path: string) =>
  path === "/health" || path.startsWith("/auth/");

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const bypassPath = deps.bypassPath ?? DEFAULT_BYPASS;
  return createMiddleware<{
    Variables: {
      tenant_id: string;
      user_id?: string;
      auth_credential?: ApiKeyResolution["credential"];
    };
  }>(async (c, next) => {
    if (bypassPath(c.req.path)) return next();

    if (deps.disabled) {
      c.set("tenant_id", "default");
      // AUTH_DISABLED is dev-only ("every request becomes tenant_id=default").
      // Also synthesize user_id=default so user-scoped endpoints
      // (/v1/oma/integrations/*, /v1/oma/api_keys, etc.) work for local single-user
      // testing — without this, the integrations surface is unusable under
      // AUTH_DISABLED because every user-scoped route rejects with
      // "legacy keys lack user_id". Only main-node consumes this shared
      // middleware (apps/main has its own auth.ts), so the blast radius is
      // dev-only.
      c.set("user_id", "default");
      return next();
    }

    // 1. API key
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const r = await deps.resolveApiKey(apiKey);
      if (!r) return c.json({ error: "Invalid API key" }, 401);
      if (!allowsApiKeyRequest(r, { path: c.req.path, transport: "x-api-key" })) {
        return c.json({ error: "API key is not authorized for this resource" }, 403);
      }
      c.set("tenant_id", r.tenantId);
      if (r.userId) c.set("user_id", r.userId);
      if (r.credential !== undefined) c.set("auth_credential", r.credential);
      return next();
    }

    // 2. Official Managed Agents helpers use Bearer auth for both the
    // standing environment key and the per-work sessions token. Resolve the
    // scoped token first; the policy guard below prevents a workspace key from
    // masquerading as the standing Environment Worker bearer.
    const authorization = c.req.header("authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      const scoped = deps.resolveBearerToken === undefined
        ? null
        : await deps.resolveBearerToken({
            token,
            method: c.req.method,
            path: c.req.path,
          });
      const resolved = scoped ?? await deps.resolveApiKey(token);
      if (!resolved) return c.json({ error: "Invalid bearer token" }, 401);
      if (!allowsApiKeyRequest(resolved, { path: c.req.path, transport: "bearer" })) {
        return c.json({ error: "Bearer token is not authorized for this resource" }, 403);
      }
      c.set("tenant_id", resolved.tenantId);
      if (resolved.userId) c.set("user_id", resolved.userId);
      if (resolved.credential !== undefined) {
        c.set("auth_credential", resolved.credential);
      }
      return next();
    }

    // 3. Cookie session
    let session: AuthSession | null = null;
    try {
      session = await deps.resolveSession(c.req.raw.headers);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    // 4. Tenant resolution.
    let tenantId: string | null = null;
    const requested = c.req.header("x-active-tenant") || "";
    if (requested) {
      const ok = await deps.hasMembership(session.userId, requested);
      if (!ok) {
        return c.json(
          {
            type: "error",
            error: { type: "not_a_member", message: "Not a member of the requested tenant" },
          },
          403,
        );
      }
      tenantId = requested;
    }
    if (!tenantId) tenantId = await deps.defaultTenantForUser(session.userId);
    if (!tenantId) tenantId = await deps.ensureTenantForUser(session);

    c.set("tenant_id", tenantId);
    c.set("user_id", session.userId);
    return next();
  });
}
