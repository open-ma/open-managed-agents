// Per-tenant abuse-protection quotas — kept in a single module so OSS
// adopters can lift the file out, swap the storage backend, or disable
// individual gates without touching the route layer.
//
// Three independent gates:
//
//   1. checkDailySessionCap   — KV counter per tenant×day. Caps total
//      sandbox containers a single tenant can spawn in 24h. Catches a
//      compromised key from running up unbounded $$ charges.
//
//   2. checkUploadFreq        — CF Rate Limiting binding per tenant.
//      Throttles POST /v1/files and POST /v1/skills/:id/versions so a
//      single tenant can't flood R2 even within their per-user write
//      budget.
//
//   3. checkUploadSize        — Synchronous content-length check. Keeps
//      a single request from being arbitrarily large; cheap upfront
//      reject before reading the body.
//
// All three soft-pass when the binding / env is absent. None of them
// touch the agent / session core: they live entirely on the route edge.

import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Per-tenant per-day session creation gate. Backed by KV so the counter
 * survives across isolates and across worker restarts. Each request
 * does one read + one write; the value auto-expires 25 hours after the
 * day starts, so old keys clean themselves up.
 *
 * Returns null when the request should proceed; returns a Response when
 * it should be rejected (so the caller can `if (rl) return rl;`).
 *
 * Race window: get-then-put isn't atomic, so under heavy concurrency a
 * tenant can sneak past the cap by ~N (where N = concurrent in-flight
 * creates). Acceptable for an abuse cap that's about runaway loops, not
 * exact accounting.
 */
export async function checkDailySessionCap(
  env: Env,
  tenantId: string,
): Promise<Response | null> {
  const cap = Number(env.SESSION_DAILY_CAP_PER_TENANT ?? 0);
  if (!cap || cap <= 0) return null; // feature off
  if (!env.CONFIG_KV) return null;   // dev/test without KV

  const today = new Date().toISOString().slice(0, 10);
  const key = `quota:sessions:${tenantId}:${today}`;
  const raw = await env.CONFIG_KV.get(key);
  const current = raw ? Number(raw) : 0;
  if (current >= cap) {
    logWarn(
      { op: "quota.daily_session_cap", tenant_id: tenantId, current, cap },
      "tenant exceeded daily session creation cap",
    );
    return Response.json(
      {
        error: `Daily session creation limit reached (${cap}/day for this tenant). Resets at 00:00 UTC.`,
      },
      { status: 429 },
    );
  }
  // 25h expiration — covers the rollover at midnight without us needing
  // a cleanup job.
  await env.CONFIG_KV.put(key, String(current + 1), { expirationTtl: 25 * 3600 });
  return null;
}

/**
 * Per-tenant upload rate limit (CF Rate Limiting binding).
 * Returns Response on reject, null on pass.
 */
export async function checkUploadFreq(
  env: Env,
  tenantId: string,
): Promise<Response | null> {
  if (!env.RL_UPLOAD_TENANT) return null; // soft-pass when unconfigured
  try {
    const r = await env.RL_UPLOAD_TENANT.limit({ key: `tenant:${tenantId}` });
    if (!r.success) {
      logWarn(
        { op: "quota.upload_freq", tenant_id: tenantId },
        "tenant exceeded upload rate limit",
      );
      return Response.json(
        { error: "Too many uploads — please wait a minute" },
        { status: 429 },
      );
    }
  } catch (err) {
    logWarn({ op: "quota.upload_freq.binding", err }, "RL_UPLOAD_TENANT binding error; failing open");
  }
  return null;
}

/**
 * Single-upload size gate. Returns Response on reject, null on pass.
 * Reads the Content-Length header; rejects before consuming the body.
 *
 * Workers' platform body limit is generally 100MB-ish, but most real
 * uploads should be much smaller. Default 25MB; override via
 * UPLOAD_MAX_BYTES env var (e.g. for self-hosters who legitimately
 * upload large skill bundles).
 */
export function checkUploadSize(env: Env, req: Request): Response | null {
  const maxBytes = Number(env.UPLOAD_MAX_BYTES ?? DEFAULT_UPLOAD_MAX_BYTES);
  const cl = Number(req.headers.get("content-length") ?? "0");
  if (cl > 0 && cl > maxBytes) {
    return Response.json(
      {
        error: `Upload too large: ${cl} bytes exceeds limit of ${maxBytes} bytes`,
      },
      { status: 413 },
    );
  }
  return null;
}
