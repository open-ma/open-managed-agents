import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";

// Per-isolate sliding window rate limiter.
// Workers may spawn multiple isolates, so this only protects against
// burst traffic hitting a single isolate. For stricter limits, deploy
// Cloudflare Rate Limiting Rules in front of this worker.
const windows = new Map<string, number[]>();
let lastCleanup = Date.now();

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  // Periodic cleanup: every 60s, drop stale keys to prevent unbounded growth
  if (now - lastCleanup > 60_000) {
    for (const [k, ts] of windows) {
      if (ts.length === 0 || ts[ts.length - 1] < now - windowMs) {
        windows.delete(k);
      }
    }
    lastCleanup = now;
  }

  const timestamps = windows.get(key) || [];
  const recent = timestamps.filter(t => t > now - windowMs);
  if (recent.length >= limit) return true;
  recent.push(now);
  windows.set(key, recent);
  return false;
}

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const key = c.req.header("x-api-key") || "anonymous";
    const method = c.req.method;

    // Configurable limits via env, defaults: 60 write/min, 600 read/min
    const isWrite = method === "POST" || method === "PUT" || method === "DELETE";
    const limit = isWrite
      ? (c.env.RATE_LIMIT_WRITE || 60)
      : (c.env.RATE_LIMIT_READ || 600);
    const rateKey = `${key}:${isWrite ? "write" : "read"}`;

    if (isRateLimited(rateKey, limit, 60000)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    await next();
  }
);

// Exported for testing
export { isRateLimited, windows };
