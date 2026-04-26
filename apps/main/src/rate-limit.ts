import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

// Rate limiting via CF Workers Rate Limiting bindings (declared in
// wrangler.jsonc). Bindings give cross-isolate accuracy that the previous
// in-memory Map limiter lacked — a single isolate's counter underestimated
// real traffic by however many isolates the worker had spawned, which made
// the limit effectively N×limit/min in production.
//
// CF only supports period=10|60 (seconds), so all windows here are 60s.
// "X per hour" budgets get translated to a stricter "X' per minute" that
// covers the same threat model (e.g. 30/hour → 5/min).

/** Apply a rate-limiting binding. Soft-passes when binding is absent
 *  (dev/test harness). Returns true when the request should be rejected. */
async function exceeded(
  binding: RateLimit | undefined,
  key: string,
): Promise<boolean> {
  if (!binding) return false;
  try {
    const r = await binding.limit({ key });
    return !r.success;
  } catch (err) {
    // CF rate-limit binding very rarely errors; log and fail-open so
    // observability never breaks request handling.
    logWarn({ op: "rate_limit.binding", key, err }, "rate limit binding threw; failing open");
    return false;
  }
}

// ─── /v1/* limiter ───────────────────────────────────────────────────────
//
// Keyed by the authenticated principal so cookie-auth users each get their
// own bucket — the old "anonymous" fallback meant ALL cookie users shared
// one ceiling and a single user could DoS everyone else.
//
// Order: API key (CLI/SDK) > user_id (Console session) > IP (last-resort
// for unauthed bursts). Auth middleware runs before this and sets both
// tenant_id and user_id, so by the time we get here the right key is
// available unless the caller is genuinely anonymous.

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

export const rateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { tenant_id?: string; user_id?: string };
}>(async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  const userId = c.get("user_id");
  const principal = apiKey
    ? `apikey:${apiKey.slice(0, 16)}` // prefix only — full key already auth'd
    : userId
      ? `user:${userId}`
      : `ip:${clientIp(c.req.raw)}`;
  const isWrite =
    c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE";
  const binding = isWrite ? c.env.RL_API_USER_WRITE : c.env.RL_API_USER_READ;
  if (await exceeded(binding, principal)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
});

// ─── /auth/* limiter ─────────────────────────────────────────────────────
//
// Three layers, all backed by separate CF bindings:
//
//   1. RL_AUTH_IP        — generic per-IP cap on the entire /auth/* surface
//      (catches credential stuffing on /auth/sign-in/email by sheer volume).
//   2. RL_AUTH_SEND_IP   — per-IP cap on email-triggering endpoints (limits
//      mail-budget burn from a single attacker).
//   3. RL_AUTH_SEND_EMAIL — per-email throttle (anti-spam-the-victim — even
//      if attacker rotates IPs, one email address can't be flooded).
//
// Body is read from a clone so better-auth still sees the original.

const EMAIL_SEND_PATHS = new Set([
  "/auth/sign-up/email",
  "/auth/sign-in/email",
  "/auth/forget-password",
  "/auth/email-otp/send-verification-otp",
  "/auth/email-otp/reset-password",
]);

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
    if (await exceeded(c.env.RL_AUTH_IP, ip)) {
      logWarn({ op: "auth.rate_limit.ip", ip, path }, "IP rate-limited on /auth/*");
      return c.json({ error: "Too many requests" }, 429);
    }

    if (!EMAIL_SEND_PATHS.has(path)) return next();

    // Layer 2: per-IP cap on email-triggering endpoints.
    if (await exceeded(c.env.RL_AUTH_SEND_IP, ip)) {
      logWarn({ op: "auth.rate_limit.send_ip", ip, path }, "IP exceeded email-send budget");
      return c.json({ error: "Too many email requests from this IP" }, 429);
    }

    // Layer 3: per-email throttle (anti-spam-the-victim).
    const email = await peekEmail(c.req.raw);
    if (email && (await exceeded(c.env.RL_AUTH_SEND_EMAIL, email))) {
      return c.json(
        { error: "Please wait a minute before requesting another email" },
        429,
      );
    }

    return next();
  },
);

// ─── Per-tenant cap on POST /v1/sessions ─────────────────────────────────
//
// Session creation spins up a sandbox container = real $$ per call. The
// generic /v1/* limiter (60 writes/min per user) would let one user burn
// 3600 sessions/hour. This stricter binding caps creation per-tenant so
// every member of the same workspace shares the budget — matches the
// billing model.
//
// Wired in routes/sessions.ts on the POST handler.

export async function rateLimitSessionCreate(
  env: Env,
  tenantId: string,
): Promise<Response | null> {
  if (await exceeded(env.RL_SESSIONS_TENANT, `tenant:${tenantId}`)) {
    return Response.json(
      { error: "Too many session creations — wait a minute" },
      { status: 429 },
    );
  }
  return null;
}
