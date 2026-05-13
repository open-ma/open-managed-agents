// In-memory rate-limit gate. Token bucket — `points` per `durationSec`.
// Sufficient for a single Node process; multi-replica deploys SHOULD
// front the buckets with Postgres or Redis (deferred — current
// self-host scale doesn't need it).
//
// No external dep — keeps main-node's deps small. If we later want
// `rate-limiter-flexible`'s richer behavior (block-on-exceed, insurance
// budget, distributed) it can drop in behind the same RateLimitGate.

import type { RateLimitConsumeResult, RateLimitGate, RateLimitGates } from "../index";

interface BucketEntry {
  remaining: number;
  resetAt: number;
}

export class MemoryRateLimitGate implements RateLimitGate {
  private buckets = new Map<string, BucketEntry>();

  constructor(
    private readonly points: number,
    private readonly durationSec: number,
  ) {}

  async consume(key: string, cost = 1): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    let entry = this.buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { remaining: this.points, resetAt: now + this.durationSec * 1000 };
      this.buckets.set(key, entry);
    }
    if (entry.remaining < cost) {
      return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.remaining -= cost;
    return { ok: true };
  }
}

export interface MemoryGatesOpts {
  /** Per-IP /auth/* limit. CF default: 60/min. */
  authIp?: { points: number; durationSec: number };
  /** Per-IP cap on email-triggering /auth/*. CF default: 10/min. */
  authSendIp?: { points: number; durationSec: number };
  /** Per-email throttle. CF default: 3/min. */
  authSendEmail?: { points: number; durationSec: number };
  /** /v1/* writes per principal. CF default: 60/min. */
  apiWrite?: { points: number; durationSec: number };
  /** POST /v1/sessions per tenant. CF default: 30/min. */
  sessionsTenant?: { points: number; durationSec: number };
}

const DEFAULTS: Required<MemoryGatesOpts> = {
  authIp: { points: 60, durationSec: 60 },
  authSendIp: { points: 10, durationSec: 60 },
  authSendEmail: { points: 3, durationSec: 60 },
  apiWrite: { points: 60, durationSec: 60 },
  sessionsTenant: { points: 30, durationSec: 60 },
};

export function buildMemoryGates(opts?: MemoryGatesOpts): RateLimitGates {
  const merged = { ...DEFAULTS, ...opts };
  return {
    authIp: new MemoryRateLimitGate(merged.authIp.points, merged.authIp.durationSec),
    authSendIp: new MemoryRateLimitGate(merged.authSendIp.points, merged.authSendIp.durationSec),
    authSendEmail: new MemoryRateLimitGate(merged.authSendEmail.points, merged.authSendEmail.durationSec),
    apiWrite: new MemoryRateLimitGate(merged.apiWrite.points, merged.apiWrite.durationSec),
    sessionsTenant: new MemoryRateLimitGate(merged.sessionsTenant.points, merged.sessionsTenant.durationSec),
  };
}
