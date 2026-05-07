// Restore-side helper — what a user-facing SessionDO would call when warming
// up a sandbox in an env that's been pre-baked by EnvPrepSandbox.
//
// Two-tier lookup:
//   1. Fast path: D1 mirror of the prep state. Any worker can read this
//      without an RPC hop into the EnvPrepSandbox DO.
//   2. Authoritative path: if D1 mirror is missing (haven't wired the
//      writer yet) or stale, RPC into the EnvPrepSandbox DO.
//
// Restore itself is just sandbox.restoreBackup(handle) on the user's
// sandbox container — the SDK handles the squashfs mount. (For the
// shell-tar variant, swap restoreBackup for `sandbox.exec("curl ... | tar -xf")`.)

import type { Env } from "@open-managed-agents/shared";
import type { OmaSandbox } from "../../oma-sandbox";
import { getEnvPrepSandbox, type PrepHandle, type PrepStrategy } from "./env-prep-sandbox";

interface PrepMirrorRow {
  env_id: string;
  status: "building" | "ready" | "failed";
  handle: string | null; // JSON-serialized PrepHandle
  updated_at: number;
}

/**
 * Resolve a ready handle for `envId`. If the env hasn't been prepped yet,
 * kick off prep via the EnvPrepSandbox DO and return null — caller decides
 * whether to wait, error to the user, or fall back to a slow on-demand
 * install.
 *
 * Designed to be called from inside SessionDO.warmUpSandbox() after the
 * user's sandbox container is ready but BEFORE any user code runs.
 */
export async function resolveEnvHandle(
  env: Env & { AUTH_DB?: D1Database; ENV_PREP?: DurableObjectNamespace },
  envId: string,
  strategy: PrepStrategy,
): Promise<{ status: "ready"; handle: PrepHandle } | { status: "not_ready"; reason: string }> {
  // 1. D1 fast path — production would maintain this mirror via a
  //    `setReady(handle)` RPC the EnvPrepSandbox calls at the end of
  //    runPrep(). Schema:
  //      CREATE TABLE env_prep_mirror (
  //        env_id     TEXT PRIMARY KEY,
  //        status     TEXT NOT NULL,
  //        handle     TEXT,           -- JSON, NULL when not ready
  //        updated_at INTEGER NOT NULL
  //      );
  if (env.AUTH_DB) {
    try {
      const row = await env.AUTH_DB
        .prepare("SELECT env_id, status, handle, updated_at FROM env_prep_mirror WHERE env_id = ?")
        .bind(envId)
        .first<PrepMirrorRow>();
      if (row?.status === "ready" && row.handle) {
        return { status: "ready", handle: JSON.parse(row.handle) };
      }
    } catch {
      // Table might not exist yet in dev — fall through to RPC path.
    }
  }

  // 2. RPC into the prep DO.
  const stub = getEnvPrepSandbox(env, envId);
  const state = await stub.pollPrep();

  if (state.status === "ready") {
    return { status: "ready", handle: state.handle };
  }

  // 3. Not ready — kick off prep so the next session benefits. Idempotent
  //    on the DO side (coalesces if already building).
  if (state.status === "idle" || state.status === "failed") {
    const begin = await stub.beginPrep(strategy);
    return {
      status: "not_ready",
      reason: begin.accepted ? "prep_kicked_off" : (begin.reason ?? "unknown"),
    };
  }

  return { status: "not_ready", reason: `prep_${state.status}` };
}

/**
 * Apply a ready handle to a freshly-warmed user sandbox. Call this once
 * per warmup, after the sandbox container is up but before any user code.
 *
 * No-throw: a restore failure leaves the sandbox in a clean (empty) state
 * which is recoverable — the agent's first turn will see a fresh /home
 * and can re-install on demand if it knows how. We log loudly so it's
 * visible in the metrics.
 */
export async function applyEnvHandle(
  userSandbox: OmaSandbox,
  handle: PrepHandle,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await userSandbox.restoreBackup({
      id: handle.id,
      dir: handle.dir,
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[env-prep restore] failed handle=${handle.id}: ${msg}`);
    return { ok: false, reason: msg };
  }
}
