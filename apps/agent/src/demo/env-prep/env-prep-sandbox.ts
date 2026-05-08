// EnvPrepSandbox — demo of the resurrected base_snapshot path.
//
// What this demo shows:
//   1. Container ↔ DO 1:1 binding lets the prep loop live INSIDE the
//      Sandbox subclass, not in the user-facing SessionDO. No more
//      "zombie SessionDO hammering the pool" (the killer of the original
//      env-images attempt — see commits 02d7d2d / 7ba6856, 2026-04-28).
//   2. keepAlive + sleepAfter renewal keeps the container alive across
//      the entire install (proven in production for /workspace backup,
//      see oma-sandbox.ts; same trick worked for the original env-images
//      prep in commit 7aec2da).
//   3. State machine + retry loop owned by the DO. If keepAlive somehow
//      fails (OOM, CF host migration, SDK bug), the next inbound RPC
//      observes status=building with a stale heartbeat → resumes.
//   4. The actual install runs as ONE sandbox.exec — that's a normal
//      HTTP request to the container, no SDK mutex involved (the trick
//      from commit e80a5c3 that bypassed the 10-15s blockConcurrencyWhile
//      cap). Snapshot uses the SDK's createBackup which is fine for
//      typical /home/env-cache sizes; for >100MB the same shell-tar +
//      presigned-R2-PUT pattern from e80a5c3 drops in unchanged.
//   5. The single-flight gate is "DO identity" itself. getEnvPrepSandbox(
//      env_id) always returns the same DO; concurrent beginPrep() calls
//      coalesce on the in-flight Promise.
//
// What this demo does NOT show (deliberately, for clarity):
//   - D1 row mirror (status / handle / updated_at). Production would
//     persist beyond the DO's storage so other workers can read state
//     without an RPC hop. Sketched in restore-helper.ts.
//   - Wrangler binding for the new DO class (see README.md).
//   - Auth / multi-tenant isolation. Production keys the DO by
//     `${tenantId}:${envId}` and validates inbound RPC.
//
// Cross-reference: ../README.md walks through the end-to-end flow.

import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "@open-managed-agents/shared";

const STATE_KEY = "env_prep_state";
const HEARTBEAT_STALE_MS = 90_000; // if no heartbeat in 90s, prep is dead
const MAX_RETRIES = 3;

// Strategy declared by the caller — the recipe the prep container should run.
// Kept tiny on purpose; production would have its own validated schema.
export interface PrepStrategy {
  /** e.g. "agentspit-bot-env-v3" — used for cache directory + R2 key. */
  envId: string;
  /** Shell snippet that, on success, writes /tmp/.prep-done. */
  installScript: string;
  /** Directory that holds the install artifact, e.g. "/home/env-cache/<envId>". */
  cacheDir: string;
}

// Persisted state machine.
type PrepState =
  | { status: "idle" }
  | {
      status: "building";
      strategy: PrepStrategy;
      startedAt: number;
      lastHeartbeatAt: number;
      attempt: number;
    }
  | {
      status: "ready";
      strategy: PrepStrategy;
      handle: PrepHandle;
      readyAt: number;
    }
  | {
      status: "failed";
      strategy: PrepStrategy;
      lastError: string;
      attempts: number;
      failedAt: number;
    };

export interface PrepHandle {
  /** SDK backup id — opaque, what restoreBackup() takes. */
  id: string;
  dir: string;
  ttlSec: number;
  recordedAt: number;
}

/**
 * EnvPrepSandbox — extends Sandbox so this DO IS the prep container's host.
 *
 * Caller pattern (from main worker or env-create handler):
 *   const stub = getEnvPrepSandbox(env, envId);
 *   await stub.beginPrep(strategy);          // returns immediately
 *   const snapshot = await stub.pollPrep();  // status object
 */
export class EnvPrepSandbox extends Sandbox {
  // Long sleepAfter — the install can take minutes. The heartbeat loop
  // (see runPrep below) renews this implicitly via sandbox.exec activity.
  override sleepAfter = "30m";

  // No interceptHttps for the prep path — pip / npm / cargo all hit
  // public registries, no vault creds needed. (If we ever want vault
  // creds for private registries, set true and add an outboundHandler
  // mirroring inject_vault_creds; the R2 bypass in oma-sandbox.ts shows
  // how to keep R2 traffic raw.)
  override interceptHttps = false;

  // ---- Public RPC (called from main worker via DO stub) -----------------

  /**
   * Idempotent: kick off a prep run if the DO doesn't already think one
   * is in progress. Returns immediately — the actual work runs detached
   * inside this DO so the caller's request handler doesn't hold a mutex.
   */
  async beginPrep(strategy: PrepStrategy): Promise<{
    accepted: boolean;
    reason?: string;
    state: PrepState;
  }> {
    const current = (await this.ctx.storage.get<PrepState>(STATE_KEY)) ?? {
      status: "idle" as const,
    };

    // Already done for this exact strategy → no-op.
    if (
      current.status === "ready" &&
      current.strategy.envId === strategy.envId &&
      current.strategy.installScript === strategy.installScript
    ) {
      return { accepted: false, reason: "already_ready", state: current };
    }

    // Already building — coalesce. If heartbeat is stale, fall through
    // and restart (the previous runner is dead).
    if (current.status === "building") {
      const since = Date.now() - current.lastHeartbeatAt;
      if (since < HEARTBEAT_STALE_MS) {
        return { accepted: false, reason: "already_building", state: current };
      }
      console.log(
        `[env-prep] stale heartbeat (${Math.round(since / 1000)}s old) — restarting`,
      );
    }

    // Failed too many times → require explicit reset.
    if (current.status === "failed" && current.attempts >= MAX_RETRIES) {
      return { accepted: false, reason: "exhausted_retries", state: current };
    }

    const attempt =
      current.status === "failed" ? current.attempts + 1 : 1;

    const next: PrepState = {
      status: "building",
      strategy,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      attempt,
    };
    await this.ctx.storage.put(STATE_KEY, next);

    // Detached: don't await. The DO method returns now; the prep loop
    // runs in this DO's I/O context and can outlast the originating RPC.
    // ctx.waitUntil keeps the worker invocation alive long enough to
    // start the first sandbox.exec; the container's keepAlive does the
    // rest. (waitUntil IS effective on a Sandbox subclass — it's the
    // user-facing SessionDO where it's a no-op.)
    this.ctx.waitUntil(this.runPrep(strategy, attempt));

    return { accepted: true, state: next };
  }

  async pollPrep(): Promise<PrepState> {
    return (
      (await this.ctx.storage.get<PrepState>(STATE_KEY)) ?? {
        status: "idle",
      }
    );
  }

  /** Operator escape hatch: force a re-run after exhausted_retries. */
  async resetPrep(): Promise<void> {
    await this.ctx.storage.delete(STATE_KEY);
  }

  // ---- Internal prep loop -------------------------------------------------

  private async runPrep(
    strategy: PrepStrategy,
    attempt: number,
  ): Promise<void> {
    console.log(
      `[env-prep] start envId=${strategy.envId} attempt=${attempt}/${MAX_RETRIES}`,
    );

    const heartbeat = setInterval(() => {
      void this.touchHeartbeat();
    }, 15_000);

    try {
      // 1. Run install script. ONE sandbox.exec — bypasses the
      //    blockConcurrencyWhile cap because it's an HTTP request to
      //    the container, not a DO method holding the mutex. The
      //    container can take as long as it needs.
      //
      //    Trailing `&& touch /tmp/.prep-done` lets us double-check
      //    success without trusting just the exit code (some installers
      //    exit 0 then the post-install hook fails). Defensive.
      const wrappedScript = `
        set -euo pipefail
        rm -f /tmp/.prep-done
        mkdir -p ${shellQuote(strategy.cacheDir)}
        ${strategy.installScript}
        touch /tmp/.prep-done
      `;

      const result = await this.exec(wrappedScript);
      if (result.exitCode !== 0) {
        throw new Error(
          `install_failed exit=${result.exitCode} stderr=${(result.stderr || "").slice(0, 500)}`,
        );
      }

      // 2. Verify marker — defense in depth.
      const verify = await this.exec("test -f /tmp/.prep-done && echo ok");
      if (!verify.stdout.includes("ok")) {
        throw new Error("marker_missing — install script lied about success");
      }

      // 3. Snapshot the cache dir into BACKUP_BUCKET via the SDK.
      //    For artifacts >~100MB or >~10s, swap this for the shell-tar
      //    + presigned-R2-PUT pattern (commit e80a5c3) — same handle
      //    shape, no SDK mutex involvement.
      const env = this.env as Env;
      const isDev = !env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID;
      const backup = await this.createBackup({
        dir: strategy.cacheDir,
        name: `env-${strategy.envId}`,
        ttl: 30 * 24 * 3600,
        excludes: [".cache", "__pycache__", ".pytest_cache"],
        ...(isDev ? { localBucket: true } : {}),
      });
      if (!backup) throw new Error("createBackup returned null");

      // 4. Mark ready. Optionally also write to D1 here so other workers
      //    don't need an RPC hop to the DO; sketched in restore-helper.ts.
      const ready: PrepState = {
        status: "ready",
        strategy,
        handle: {
          id: backup.id,
          dir: backup.dir,
          ttlSec: 30 * 24 * 3600,
          recordedAt: Date.now(),
        },
        readyAt: Date.now(),
      };
      await this.ctx.storage.put(STATE_KEY, ready);
      console.log(
        `[env-prep] ready envId=${strategy.envId} backup=${backup.id} attempt=${attempt}`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(
        `[env-prep] failed envId=${strategy.envId} attempt=${attempt}: ${msg}`,
      );

      // Decide: retry from inside the DO, or surface as failed?
      // Container died (5xx, connection reset) → likely transient, retry.
      // Install script bad (exit≠0) → likely permanent, surface failure.
      // We can't always tell; use attempt budget as the safety net.
      const transient =
        /5\d{2}|connection|timed? ?out|ECONNRESET|fetch failed/i.test(msg);

      if (transient && attempt < MAX_RETRIES) {
        console.log(`[env-prep] transient — auto-retry in 5s`);
        await sleep(5_000);
        // Recurse: same DO, same container slot (or a fresh one if
        // the container died — keepAlive ref is gone but a new exec
        // re-creates it). Heartbeat ticker is restarted in runPrep().
        clearInterval(heartbeat);
        return this.runPrep(strategy, attempt + 1);
      }

      const failed: PrepState = {
        status: "failed",
        strategy,
        lastError: msg.slice(0, 500),
        attempts: attempt,
        failedAt: Date.now(),
      };
      await this.ctx.storage.put(STATE_KEY, failed);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async touchHeartbeat(): Promise<void> {
    const cur = await this.ctx.storage.get<PrepState>(STATE_KEY);
    if (cur?.status !== "building") return;
    cur.lastHeartbeatAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, cur);
  }

  // ---- Lifecycle hooks for visibility ------------------------------------

  override async onStop(...args: unknown[]): Promise<void> {
    const params = (args[0] ?? {}) as { exitCode?: number; reason?: string };
    console.log(
      `[env-prep] container onStop exit=${params.exitCode ?? -1} reason=${params.reason ?? "?"}`,
    );
    // Note: do NOT mutate state here. If we're mid-prep and the container
    // dies, the next beginPrep() call will see stale heartbeat (>90s) and
    // restart. Mutating from onStop races the runPrep() catch handler.
  }
}

// ---- Helpers --------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convenience: name-keyed DO stub. Production passes a composite key like
 * `${tenantId}:${envId}` so each tenant gets isolated prep state.
 */
export function getEnvPrepSandbox(
  env: Env & { ENV_PREP?: DurableObjectNamespace },
  envId: string,
): DurableObjectStub<EnvPrepSandbox> {
  if (!env.ENV_PREP) {
    throw new Error(
      "ENV_PREP DO binding missing — see demo/env-prep/README.md for wrangler setup",
    );
  }
  const id = env.ENV_PREP.idFromName(`env-prep:${envId}`);
  return env.ENV_PREP.get(id) as DurableObjectStub<EnvPrepSandbox>;
}
