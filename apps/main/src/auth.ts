import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { tenant_id: string };
}>(async (c, next) => {
  // 1. Try API Key authentication (for CLI / SDK)
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    // Legacy: check static API_KEY env var for backwards compat
    if (c.env.API_KEY && c.env.API_KEY !== "" && apiKey === c.env.API_KEY) {
      c.set("tenant_id", "default");
      return next();
    }
    // Lookup hashed API key in KV
    const hash = await sha256(apiKey);
    const keyData = await c.env.CONFIG_KV.get(`apikey:${hash}`);
    if (!keyData) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    const { tenant_id } = JSON.parse(keyData) as { tenant_id: string };
    c.set("tenant_id", tenant_id);
    return next();
  }

  // 2. Try session cookie authentication (for Console)
  // Lazy import to avoid crashing workerd in test environments
  // where better-auth's Node.js deps aren't available
  if (c.env.AUTH_DB) {
    try {
      const { createAuth, getTenantId } = await import("./auth-config");
      const auth = createAuth(c.env);
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session?.user) {
        const tenantId = await getTenantId(c.env.AUTH_DB, session.user.id);
        if (!tenantId) {
          return c.json({ error: "User has no workspace. Please contact support." }, 403);
        }
        c.set("tenant_id", tenantId);
        return next();
      }
    } catch {
      // fall through to 401
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
