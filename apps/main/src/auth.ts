import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";
import { logWarn, logError } from "@open-managed-agents/shared";
import { CfKvStore } from "@open-managed-agents/kv-store";

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>(async (c, next) => {
  // Internal endpoints have their own header-secret auth (see routes/internal.ts)
  if (c.req.path.startsWith("/v1/internal/")) {
    return next();
  }
  // MCP proxy authenticates via Bearer oma_* on every request — its own
  // resolveProxyTarget validates token + session ownership in one shot.
  if (c.req.path.startsWith("/v1/mcp-proxy/")) {
    return next();
  }

  // 1. Try API Key authentication (for CLI / SDK)
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    // Legacy: check static API_KEY env var for backwards compat
    if (c.env.API_KEY && c.env.API_KEY !== "" && apiKey === c.env.API_KEY) {
      c.set("tenant_id", "default");
      return next();
    }
    // Lookup hashed API key in KV. authMiddleware runs before servicesMiddleware,
    // so c.var.services isn't populated yet — construct the kv adapter inline.
    const hash = await sha256(apiKey);
    const kv = new CfKvStore(c.env.CONFIG_KV);
    const keyData = await kv.get(`apikey:${hash}`);
    if (!keyData) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    const { tenant_id, user_id } = JSON.parse(keyData) as {
      tenant_id: string;
      user_id?: string;
    };
    c.set("tenant_id", tenant_id);
    if (user_id) {
      c.set("user_id", user_id);
    } else if (c.env.AUTH_DB) {
      // Backwards compat: legacy keys minted before user_id was tracked.
      // If the tenant has exactly one user, attribute the request to them so
      // user-scoped endpoints (e.g. /v1/integrations/*) keep working without
      // requiring everyone to regenerate. Multi-user tenants must explicitly
      // regenerate; we don't guess.
      try {
        const r = await c.env.AUTH_DB
          .prepare(`SELECT id FROM "user" WHERE tenantId = ? LIMIT 2`)
          .bind(tenant_id)
          .all<{ id: string }>();
        if (r.results?.length === 1) {
          c.set("user_id", r.results[0].id);
        }
      } catch (err) {
        // AUTH_DB query failed — proceed without user_id; downstream
        // user-scoped routes will reject with their own clear message.
        logWarn(
          { op: "auth.tenant_user_lookup", tenant_id, err },
          "AUTH_DB user lookup failed; proceeding without user_id",
        );
      }
    }
    return next();
  }

  // 2. Try session cookie authentication (for Console)
  // Lazy import to avoid crashing workerd in test environments
  // where better-auth's Node.js deps aren't available
  if (c.env.AUTH_DB) {
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
          const ok = await hasMembership(c.env.AUTH_DB, session.user.id, requested);
          if (ok) {
            tenantId = requested;
          } else {
            return c.json({ error: "Not a member of the requested tenant" }, 403);
          }
        }
        if (!tenantId) {
          tenantId = await getTenantId(c.env.AUTH_DB, session.user.id);
        }
        if (!tenantId) {
          // Self-heal: legacy users registered before the sign-up hook landed,
          // or hook silently failed at creation time, would otherwise be
          // permanently stuck. Mint a tenant on the fly.
          tenantId = await ensureTenant(c.env.AUTH_DB, session.user.id, session.user.name, session.user.email);
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
