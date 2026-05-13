// Per-tenant abuse-protection quotas. Three independent gates:
//
//   1. checkDailySessionCap — KV counter per tenant×day. Caps total
//      sandbox containers a single tenant can spawn in 24h.
//   2. checkUploadFreq — RateLimitGate per tenant.
//   3. checkUploadSize — synchronous content-length check.
//
// All three soft-pass when their underlying primitive is null/absent.
// Same shape as apps/main/src/quotas.ts pre-extract; CF gets KV-backed,
// Node gets SQL-backed via @open-managed-agents/kv-store/adapters/sql.

import type { KvStore } from "@open-managed-agents/kv-store";
import type { RateLimitGate } from "@open-managed-agents/rate-limit";

const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface QuotaResult {
  /** True when the request should be rejected. */
  reject: boolean;
  status?: number;
  message?: string;
  retryAfterSeconds?: number;
}

const ok: QuotaResult = { reject: false };

export interface QuotaService {
  checkDailySessionCap(tenantId: string): Promise<QuotaResult>;
  checkUploadFreq(tenantId: string): Promise<QuotaResult>;
  checkUploadSize(contentLength: number): QuotaResult;
}

export interface QuotaServiceOpts {
  kv: KvStore;
  uploadGate: RateLimitGate | null;
  /** Daily session cap per tenant. 0 / undefined = feature off. */
  dailySessionCap?: number;
  /** Upload size cap in bytes; defaults to 25MB. */
  uploadMaxBytes?: number;
}

export class DefaultQuotaService implements QuotaService {
  constructor(private readonly opts: QuotaServiceOpts) {}

  async checkDailySessionCap(tenantId: string): Promise<QuotaResult> {
    const cap = this.opts.dailySessionCap ?? 0;
    if (!cap || cap <= 0) return ok;
    const today = new Date().toISOString().slice(0, 10);
    const key = `quota:sessions:${tenantId}:${today}`;
    const raw = await this.opts.kv.get(key);
    const current = raw ? Number(raw) : 0;
    if (current >= cap) {
      return {
        reject: true,
        status: 429,
        message: `Daily session creation limit reached (${cap}/day for this tenant). Resets at 00:00 UTC.`,
      };
    }
    // Race window acceptable: this is an abuse cap, not exact accounting.
    await this.opts.kv.put(key, String(current + 1), { expirationTtl: 25 * 3600 });
    return ok;
  }

  async checkUploadFreq(tenantId: string): Promise<QuotaResult> {
    if (!this.opts.uploadGate) return ok;
    const r = await this.opts.uploadGate.consume(`tenant:${tenantId}`);
    if (!r.ok) {
      return {
        reject: true,
        status: 429,
        message: "Too many uploads — please wait a minute",
        retryAfterSeconds: r.retryAfter,
      };
    }
    return ok;
  }

  checkUploadSize(contentLength: number): QuotaResult {
    const max = this.opts.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
    if (contentLength > 0 && contentLength > max) {
      return {
        reject: true,
        status: 413,
        message: `Upload too large: ${contentLength} bytes exceeds limit of ${max} bytes`,
      };
    }
    return ok;
  }
}
