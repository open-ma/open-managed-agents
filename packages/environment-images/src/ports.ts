// EnvironmentImageStrategy port — how an env's "sandbox image" is
// produced (when env is created/updated) and consumed (when a session
// boots). Adapters live in `./adapters/*`.
//
// Why a port: Cloudflare Sandbox is the production backend, but
// self-hosters may use k8s checkpointing, fly.io machines, or just
// "rebuild every session" for dev. The platform stays sandbox-agnostic
// — only the adapter knows which CF API to call.
//
// CFless contract: this package depends ONLY on @open-managed-agents/
// api-types and standard JS. CF-specific imports live exclusively in
// the cf-* adapter subpaths so non-CF deployments don't pay for them.

import type { EnvironmentConfig } from "@open-managed-agents/api-types";

/**
 * Opaque per-env state the strategy persists into D1 between
 * `prepare()` and `bootSandbox()`. The platform JSON-serializes it
 * into `environment.image_handle` and hands it back unchanged. Each
 * strategy defines its own shape — keep small (D1 row).
 */
export type ImageHandle = unknown;

export interface PrepareInput {
  /** Stable env id (e.g. `env-lvqed06glbi3ent0`). Use as part of any
   *  per-env path / cache key. */
  env_id: string;
  /** Tenant context. Useful for auth, accounting, multi-tenant
   *  isolation in adapters that share infra across tenants. */
  tenant_id: string;
  /** Full env config (after validation). The strategy reads the bits
   *  it cares about (`packages`, `dockerfile`, `networking`...) and
   *  ignores the rest. */
  config: EnvironmentConfig["config"];
}

export interface PrepareResult {
  /** `ready` = sandbox image ready to boot from. `building` = adapter
   *  kicked off async work; will callback the platform later. `error`
   *  = synchronous failure; surface to user. */
  status: "ready" | "building" | "error";
  /** Strategy-specific blob the platform will hand back to
   *  `bootSandbox()`. Keep small — gets stored in D1. */
  handle?: ImageHandle;
  /** Which Cloudflare Worker binding to route sessions of this env
   *  to. The platform resolves to `SANDBOX_${name.replace(/-/g, "_")}`.
   *  base-snapshot adapters typically return the shared `sandbox-default`;
   *  per-env-image adapters (e.g. dockerfile) return per-env names. */
  sandbox_worker_name?: string;
  /** Set when status === 'error'. Surfaced to user via env.build_error. */
  error?: string;
}

export interface BootInput {
  env_id: string;
  session_id: string;
  config: EnvironmentConfig["config"];
  /** What `prepare()` returned. May be undefined for legacy envs that
   *  predate the strategy field — adapter should handle gracefully
   *  (e.g. fall back to install-on-boot). */
  handle?: ImageHandle;
}

/**
 * Minimal sandbox surface the harness needs. The full `SandboxExecutor`
 * lives in `apps/agent/src/harness/interface.ts`; we re-declare the
 * shape here to keep environment-images depended on only by the agent
 * runtime, not by the harness. Adapters return concrete impls.
 */
export interface SandboxBoot {
  /** The actual sandbox handle (typed `unknown` here so this package
   *  doesn't depend on `@cloudflare/sandbox`). The session-do glue
   *  casts it to its real type. */
  sandbox: unknown;
  /** Whether this boot was a cache-hit (snapshot restore) vs cold
   *  (full install). Useful for metrics. */
  cache_hit: boolean;
  /** ms spent in adapter (install or restore). */
  duration_ms: number;
}

export interface EnvironmentImageStrategy {
  /** Identify the strategy in env config (`base_snapshot`, `dockerfile`, …). */
  readonly name: string;

  /**
   * Called when an env is created or its `packages` change. The
   * adapter installs/builds whatever it needs and returns a handle
   * the platform will hand back to `bootSandbox()`.
   *
   * `prepare()` may be slow (minutes) — main worker should treat
   * `status: "building"` as async and let the adapter callback when
   * done (CF Workers can't hold long requests).
   */
  prepare(input: PrepareInput): Promise<PrepareResult>;

  /**
   * Called once per session at boot. The adapter restores from the
   * handle (snapshot, image pull, whatever) and returns a sandbox
   * the harness can `exec()` against.
   *
   * Session boot is on the hot path — this should be FAST (< 5s
   * target). If the handle is missing or invalid, throw and let the
   * platform surface a session.error.
   */
  bootSandbox(input: BootInput): Promise<SandboxBoot>;

  /**
   * Optional: called when env config changes (packages added/removed).
   * Adapter MAY reuse parts of the old handle (e.g. incremental
   * install), or just discard and re-prepare. Default: discard via
   * `prepare()`.
   */
  reprepare?(input: PrepareInput & { previous_handle: ImageHandle }): Promise<PrepareResult>;
}
