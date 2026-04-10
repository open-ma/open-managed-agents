import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";

// Simple in-memory sliding window rate limiter
// Production should use DO or KV for distributed rate limiting
const windows = new Map<string, number[]>();

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
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
