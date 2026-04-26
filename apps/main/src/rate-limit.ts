import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

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

// ─── Auth route rate limiting ────────────────────────────────────────────
//
// Email-send endpoints under /auth/* trigger an outbound email per call,
// which costs money and floods target inboxes when abused. Three layers:
//
//   1. Generic per-IP cap on ANY /auth/* request (catches credential
//      stuffing on /auth/sign-in/email by sheer volume).
//   2. Per-IP cap on email-send specifically — slower than #1, prevents
//      a single attacker from burning the mail budget.
//   3. Per-email throttle (1 / minute, 5 / hour) — prevents targeting one
//      victim with a spam wave even if attacker rotates IPs. Body is read
//      from a clone so better-auth still sees the original.
//
// Limits are deliberately strict; legit users hit them only by request
// loop. Override via env: AUTH_RATE_LIMIT_IP_PER_MIN, AUTH_RATE_LIMIT_
// EMAIL_SEND_IP_PER_HOUR, AUTH_RATE_LIMIT_EMAIL_SEND_PER_MIN, AUTH_RATE_
// LIMIT_EMAIL_SEND_PER_HOUR.

const EMAIL_SEND_PATHS = new Set([
  "/auth/sign-up/email",
  "/auth/sign-in/email",
  "/auth/forget-password",
  "/auth/email-otp/send-verification-otp",
  "/auth/email-otp/reset-password",
]);

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

async function peekEmail(req: Request): Promise<string> {
  try {
    const cloned = req.clone();
    const body = (await cloned.json()) as { email?: string };
    return (body?.email ?? "").toLowerCase().trim();
  } catch {
    return "";
  }
}

export const authRateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const ip = clientIp(c.req.raw);
    const path = new URL(c.req.url).pathname;

    // Layer 1: generic per-IP throttle on the entire /auth/* surface.
    const ipPerMin = c.env.AUTH_RATE_LIMIT_IP_PER_MIN ?? 60;
    if (isRateLimited(`auth:any-ip:${ip}`, ipPerMin, 60_000)) {
      logWarn({ op: "auth.rate_limit.ip", ip, path }, "IP rate-limited on /auth/*");
      return c.json({ error: "Too many requests" }, 429);
    }

    if (!EMAIL_SEND_PATHS.has(path)) return next();

    // Layer 2: per-IP cap on email-triggering endpoints.
    const sendPerHour = c.env.AUTH_RATE_LIMIT_EMAIL_SEND_IP_PER_HOUR ?? 30;
    if (isRateLimited(`auth:send-ip:${ip}`, sendPerHour, 3_600_000)) {
      logWarn({ op: "auth.rate_limit.send_ip", ip, path }, "IP exceeded email-send budget");
      return c.json({ error: "Too many email requests from this IP" }, 429);
    }

    // Layer 3: per-email throttle (anti-spam-the-victim).
    const email = await peekEmail(c.req.raw);
    if (email) {
      const perMin = c.env.AUTH_RATE_LIMIT_EMAIL_SEND_PER_MIN ?? 1;
      if (isRateLimited(`auth:send-email-min:${email}`, perMin, 60_000)) {
        return c.json(
          { error: "Please wait a minute before requesting another email" },
          429,
        );
      }
      const perHour = c.env.AUTH_RATE_LIMIT_EMAIL_SEND_PER_HOUR ?? 5;
      if (isRateLimited(`auth:send-email-hr:${email}`, perHour, 3_600_000)) {
        return c.json(
          { error: "Too many email requests for this address — try again later" },
          429,
        );
      }
    }

    return next();
  },
);

// Exported for testing
export { isRateLimited, windows };
