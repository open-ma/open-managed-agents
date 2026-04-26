// Per-IP and per-tenant rate limits for the integrations webhook surface.
//
// Webhook receivers are intentionally public — Linear / GitHub / Slack
// POST here unauthenticated, and we sig-verify in the handler. But sig
// verification still costs HMAC CPU, and a flood of garbage from a
// single attacker IP can starve real webhook deliveries even when every
// request is rejected.
//
// Two separate gates:
//   - per-IP runs BEFORE the handler (cheap reject for garbage floods)
//   - per-tenant runs AFTER the handler returns its outcome with a
//     tenantId set (catches misconfigured legit workspaces sending
//     loops; only kicks in once we know which tenant)
//
// Both soft-pass when their binding is absent so OSS / dev deployments
// that haven't configured CF Rate Limiting still work.
//
// Limits live in wrangler.jsonc → "ratelimits".

import { createMiddleware } from "hono/factory";
import type { Env } from "./env";

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

export const webhookRateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    if (!c.env.RL_WEBHOOK_IP) return next(); // soft-pass when unconfigured
    const ip = clientIp(c.req.raw);
    try {
      const r = await c.env.RL_WEBHOOK_IP.limit({ key: ip });
      if (!r.success) {
        // Cheap reject — the actual webhook handler never runs, no DB
        // write, no HMAC check.
        console.warn(`[webhook-ratelimit] IP ${ip} rejected on ${c.req.path}`);
        return c.text("Too Many Requests", 429);
      }
    } catch (err) {
      // Fail-open if the binding itself errors — observability shouldn't
      // break webhook delivery for legit traffic.
      console.warn(`[webhook-ratelimit] binding error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return next();
  },
);

/**
 * Per-tenant rate gate, called from the route AFTER handleWebhook returns
 * its outcome with a tenantId set. Returns true when the request should
 * be dropped (skip deferred dispatch, log, return 200 anyway so upstream
 * doesn't retry and compound the problem).
 *
 * Soft-passes when binding is absent.
 */
export async function shouldDropForTenantRateLimit(
  env: Env,
  tenantId: string,
): Promise<boolean> {
  if (!env.RL_WEBHOOK_TENANT) return false;
  try {
    const r = await env.RL_WEBHOOK_TENANT.limit({ key: `tenant:${tenantId}` });
    if (!r.success) {
      console.warn(`[webhook-ratelimit] tenant ${tenantId} exceeded webhook budget`);
      return true;
    }
  } catch (err) {
    console.warn(`[webhook-ratelimit] tenant binding error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}
