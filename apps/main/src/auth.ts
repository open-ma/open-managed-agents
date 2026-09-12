import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";
import { logWarn, logError } from "@open-managed-agents/shared";
import { CfKvStore } from "@open-managed-agents/kv-store";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import {
  authenticateEnvironmentWorkSessionBearer,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import { isCurrentEnvironmentWorkClaim } from "@open-managed-agents/environment-work-store";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import {
  allowsApiKeyRequest,
  type ApiKeyResolution,
} from "@open-managed-agents/auth";

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveWorkspaceApiKey(env: Env, apiKey: string): Promise<{
  tenantId: string;
  userId?: string;
  credential?: ApiKeyResolution["credential"];
} | null> {
  if (env.API_KEY && env.API_KEY !== "" && apiKey === env.API_KEY) {
    return { tenantId: "default" };
  }
  const hash = await sha256(apiKey);
  const keyData = await new CfKvStore(env.CONFIG_KV).get(`apikey:${hash}`);
  if (!keyData) return null;
  const { tenant_id, user_id, credential } = JSON.parse(keyData) as {
    tenant_id: string;
    user_id?: string;
    credential?: ApiKeyResolution["credential"];
  };
  if (user_id) return { tenantId: tenant_id, userId: user_id, credential };
  if (!env.MAIN_DB) return { tenantId: tenant_id, credential };
  try {
    const result = await env.MAIN_DB
      .prepare(`SELECT id FROM "user" WHERE tenantId = ? LIMIT 2`)
      .bind(tenant_id)
      .all<{ id: string }>();
    return result.results?.length === 1
      ? { tenantId: tenant_id, userId: result.results[0].id, credential }
      : { tenantId: tenant_id, credential };
  } catch (err) {
    logWarn(
      { op: "auth.tenant_user_lookup", tenant_id, err },
      "MAIN_DB user lookup failed; proceeding without user_id",
    );
    return { tenantId: tenant_id, credential };
  }
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
}>(async (c, next) => {
  // Internal endpoints have their own header-secret auth (see routes/internal.ts)
  if (c.req.path.startsWith("/v1/oma/internal/")) {
    return next();
  }
  // 1. Try API Key authentication (for CLI / SDK)
  const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const resolved = await resolveWorkspaceApiKey(c.env, apiKey);
      if (!resolved) return c.json({ error: "Invalid API key" }, 401);
      if (!allowsApiKeyRequest(resolved, { path: c.req.path, transport: "x-api-key" })) {
        return c.json({ error: "API key is not authorized for this resource" }, 403);
      }
    c.set("tenant_id", resolved.tenantId);
    if (resolved.userId) c.set("user_id", resolved.userId);
    if (resolved.credential !== undefined) {
      c.set("auth_credential", resolved.credential);
    }
    return next();
  }

  // 2. Official EnvironmentWorker auth. Its helper clients deliberately emit
  // only Authorization: Bearer for both the standing environment key and the
  // per-work sessions token.
  const authorization = c.req.header("authorization") ?? "";
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    let resolved: ApiKeyResolution | null = null;
    if (token.startsWith("sk-ant-req-v1.") && c.env.PLATFORM_ROOT_SECRET) {
      const platformRootSecret = c.env.PLATFORM_ROOT_SECRET;
      const scoped = await authenticateEnvironmentWorkSessionBearer({
        token,
        method: c.req.method,
        path: c.req.path,
        crypto: new WebCryptoAesGcm(
          platformRootSecret,
          "managed.environment-work.session-token",
        ),
        now: () => new Date(),
        isCurrent: async (claim) => {
          const tenantDb = await buildCfTenantDbProvider(c.env).resolve(
            claim.workspaceId,
          );
          const secretCrypto = new WebCryptoAesGcm(
            platformRootSecret,
            "managed.environment-work.secret",
          );
          const store = new SqlEnvironmentWorkStore(
            new CfD1SqlClient(tenantDb),
            {
              seal: async ({ plaintext }) => ({
                ciphertext: await secretCrypto.encrypt(plaintext),
              }),
              open: async ({ ciphertext }) => ({
                plaintext: await secretCrypto.decrypt(ciphertext),
              }),
            },
          );
          return isCurrentEnvironmentWorkClaim(
            { store, now: () => new Date() },
            claim,
          );
        },
      });
      if (scoped !== null) {
        resolved = {
          tenantId: scoped.workspaceId,
          credential: {
            type: "environment_work_session",
            environmentId: scoped.environmentId,
            sessionId: scoped.sessionId,
            workId: scoped.workId,
            claimedAt: scoped.claimedAt,
            generation: scoped.generation,
          },
        };
      }
    } else {
      resolved = await resolveWorkspaceApiKey(c.env, token);
    }
    if (resolved === null) return c.json({ error: "Invalid bearer token" }, 401);
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

  // 3. Try session cookie authentication (for Console)
  // Lazy import to avoid crashing workerd in test environments
  // where better-auth's Node.js deps aren't available
  if (c.env.MAIN_DB) {
    try {
      const { createAuth, getTenantId, ensureTenant, hasMembership } = await import("./auth-config");
      const auth = createAuth(c.env);
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session?.user) {
        // Pattern A multi-tenant: cookie auth resolves tenant from
        //   1. x-active-tenant header (set by Console after user picks),
        //      validated against membership table — never trust the header
        //      blindly or a logged-in user could read any tenant's data.
        //   2. user.tenantId default (legacy / single-tenant users).
        //   3. ensureTenant on demand for never-onboarded users.
        const requested = c.req.header("x-active-tenant") || "";
        let tenantId: string | null = null;
        if (requested) {
          const ok = await hasMembership(c.env.MAIN_DB, session.user.id, requested);
          if (ok) {
            tenantId = requested;
          } else {
            return c.json(
              {
                type: "error",
                error: { type: "not_a_member", message: "Not a member of the requested tenant" },
              },
              403,
            );
          }
        }
        if (!tenantId) {
          tenantId = await getTenantId(c.env.MAIN_DB, session.user.id);
        }
        if (!tenantId) {
          // Self-heal: legacy users registered before the sign-up hook landed,
          // or hook silently failed at creation time, would otherwise be
          // permanently stuck. Mint a tenant on the fly.
          tenantId = await ensureTenant(c.env, session.user.id, session.user.name, session.user.email);
        }
        c.set("tenant_id", tenantId);
        c.set("user_id", session.user.id);
        return next();
      }
    } catch (err) {
      // fall through to 401 — but log first so we can tell "no session" from
      // "session check threw" in prod (better-auth import / DB errors etc.).
      logError(
        { op: "auth.session_check", err },
        "session cookie auth threw; returning 401",
      );
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
