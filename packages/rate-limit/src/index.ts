// Rate-limit port + buckets bundle.
//
// Same five buckets P0 wired in apps/main on CF Workers Rate Limiting,
// generalized so Node can use a memory backend (rate-limiter-flexible /
// in-process counter). Five named gates make up `RateLimitGates`:
//
//   - authIp:        per-IP cap on /auth/*
//   - authSendIp:    per-IP cap on email-triggering /auth endpoints
//   - authSendEmail: per-email throttle to anti-spam-the-victim
//   - apiWrite:      generic /v1/* write cap
//   - sessionsTenant: per-tenant cap on POST /v1/sessions
//
// Routes ask the bundle for the right gate by name; runtime swap is
// transparent. Hono middleware factory below mounts a gate by name.
//
// Bypass: AUTH_DISABLED=1 short-circuits the middleware (matches P0
// behavior: the demo escape hatch shouldn't be rate-limited either).

import type { MiddlewareHandler } from "hono";

export interface RateLimitConsumeResult {
  ok: boolean;
  /** Seconds until the bucket refills. Best-effort; some adapters can't
   *  compute it and return undefined. */
  retryAfter?: number;
}

export interface RateLimitGate {
  consume(key: string, cost?: number): Promise<RateLimitConsumeResult>;
}

export type RateLimitBucketName =
  | "authIp"
  | "authSendIp"
  | "authSendEmail"
  | "apiWrite"
  | "sessionsTenant";

export interface RateLimitGates {
  authIp: RateLimitGate;
  authSendIp: RateLimitGate;
  authSendEmail: RateLimitGate;
  apiWrite: RateLimitGate;
  sessionsTenant: RateLimitGate;
}

/** Allow-everything gate. Used when a runtime hasn't wired a particular
 *  bucket yet (e.g. main-node before someone adds rate-limiter-flexible
 *  to the deps). Soft-pass matches the historical "binding absent →
 *  pass" behavior on CF. */
export class NoopRateLimitGate implements RateLimitGate {
  async consume(): Promise<RateLimitConsumeResult> {
    return { ok: true };
  }
}

export const noopGates: RateLimitGates = {
  authIp: new NoopRateLimitGate(),
  authSendIp: new NoopRateLimitGate(),
  authSendEmail: new NoopRateLimitGate(),
  apiWrite: new NoopRateLimitGate(),
  sessionsTenant: new NoopRateLimitGate(),
};

export interface RateLimitMiddlewareOpts {
  gate: RateLimitGate;
  /** Build the bucket key from the request context. */
  keyFn: (c: import("hono").Context) => string | Promise<string>;
  /** Bypass entirely — used by AUTH_DISABLED demos. */
  bypass?: () => boolean;
  /** Override the rejected response body. Default: JSON 429. */
  rejectMessage?: string;
}

/** Generic Hono middleware factory. Routes mount with their bucket of
 *  choice + a key-extractor closure (typically `c.var.tenant_id` or IP). */
export function rateLimit(opts: RateLimitMiddlewareOpts): MiddlewareHandler {
  return async (c, next) => {
    if (opts.bypass?.()) return next();
    const key = await opts.keyFn(c);
    const r = await opts.gate.consume(key);
    if (!r.ok) {
      if (r.retryAfter !== undefined) {
        c.header("Retry-After", String(r.retryAfter));
      }
      return c.json(
        { error: opts.rejectMessage ?? "Rate limit exceeded" },
        429,
      );
    }
    return next();
  };
}
