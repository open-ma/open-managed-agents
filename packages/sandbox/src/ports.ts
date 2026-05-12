// Runtime-agnostic sandbox port. Originally lived in
// apps/agent/src/harness/interface.ts as the `SandboxExecutor` and
// `ProcessHandle` interfaces; lifted here so non-CF runtimes (Node host,
// future deployments) can implement the same shape without taking on the
// apps/agent → cloudflare:workers → @cloudflare/sandbox import chain.
//
// Implementations:
//   - CloudflareSandbox  (apps/agent/src/runtime/sandbox.ts) — wraps the
//     @cloudflare/sandbox container SDK + DO storage. Stays where it is
//     so its CF-only deps don't bleed into this package.
//   - LocalSubprocessSandbox (./adapters/local-subprocess.ts) — Node
//     child_process + per-session workdir. Local dev. NO security
//     isolation — runs on the host filesystem. Don't ship to prod with
//     untrusted agents.
//   - E2BSandbox (TODO) — wraps @e2b/sdk for Firecracker microVM
//     isolation. Production self-host path.

export interface ProcessHandle {
  id: string;
  pid: number;
  kill(signal: string): Promise<void>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  getStatus(): Promise<string>;
}

export interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  /** Start a process without blocking. Returns handle for kill/status/logs. */
  startProcess?(command: string): Promise<ProcessHandle | null>;
  /** Set global environment variables for all subsequent exec calls. */
  setEnvVars?(envVars: Record<string, string>): Promise<void>;
  /** Native git checkout (if supported by sandbox). */
  gitCheckout?(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown>;
  /** Register secrets injected only for commands matching a prefix (e.g. "git", "gh"). */
  registerCommandSecrets?(commandPrefix: string, secrets: Record<string, string>): void;
  /**
   * Bind the outbound handler with this session's identifying context.
   * On CF the handler intercepts container HTTPS requests and RPCs into
   * the main worker for vault credential injection. On other backends it's
   * a no-op or implementation-specific.
   */
  setOutboundContext?(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Hand the (tenant, env, session) tuple to the OmaSandbox container DO so
   * its onActivityExpired hook (sleepAfter teardown) records the final
   * /workspace snapshot scoped to this session.
   */
  setBackupContext?(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Trigger an immediate /workspace snapshot via OmaSandbox. Used by the
   * explicit-destroy path to capture state before sandbox.destroy() wipes
   * the container.
   */
  snapshotWorkspaceNow?(): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  /**
   * Write raw bytes. Use this for binary files (PDFs, images, archives) —
   * the string-based writeFile would corrupt them via UTF-8 round-tripping.
   */
  writeFileBytes?(path: string, bytes: Uint8Array): Promise<string>;
  /**
   * Mount a memory store into the sandbox at /mnt/memory/<storeName>/.
   * On CF backed by R2 + FUSE; on Node we hydrate by copying. Read-only
   * mounts reject writes.
   */
  mountMemoryStore?(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void>;
  /**
   * Mount FILES_BUCKET at /mnt/session/outputs/ scoped to (tenantId, sessionId)
   * via R2 prefix. Anything the agent writes here appears in real time via
   * the caller-facing GET /v1/sessions/:id/outputs endpoint. AMA-aligned
   * "magic dir" pattern — agent uses standard file tools, no extra tool.
   */
  mountSessionOutputs?(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void>;
  /**
   * Snapshot /workspace into durable storage. Returns a serializable
   * handle; null on failure. CF: squashfs → R2. Node: tar → S3 (when wired).
   */
  createWorkspaceBackup?(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null>;
  /**
   * Restore a previously-created backup into /workspace. Returns
   * `{ok:true}` on success, `{ok:false, error?}` when the backup is
   * missing/expired/etc. Best-effort: callers treat ok=false as "/workspace
   * is empty, proceed". Matches the apps/agent SandboxExecutor signature so
   * adapters can satisfy both ports without divergence.
   */
  restoreWorkspaceBackup?(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Destroy the sandbox — kills processes, unmounts, stops. */
  destroy?(): Promise<void>;
  /**
   * Tell the sandbox container "I'm still active". Resets CF Container's
   * sleepAfter inactivity timer; long-running bg tasks keep the box alive
   * via this. No-op on impls that don't auto-sleep.
   */
  renewActivityTimeout?(): Promise<void>;
}

// ─── Factory contract ──────────────────────────────────────────────────
//
// Dependency-inversion entry point. Every adapter exports a single
// `sandboxFactory: SandboxFactory`; the host (main-node, future shells)
// only knows the provider name → import path map and never reads any
// adapter-specific env var. Adding a new adapter is "create file +
// register name in the map" — host code doesn't grow.
//
// Each factory reads its own env vars off the SandboxFactoryEnv arg
// (just `process.env` repackaged for testability). All factories see
// the same shared `ctx` (sessionId, per-session workdir, memory root)
// so adapters that don't need them just ignore them — the host never
// branches on which subset to pass.

export interface SandboxFactoryContext {
  /** Per-session id — adapters use it for naming, scoping, etc. */
  sessionId: string;
  /** Per-session host workdir. LocalSubprocess uses this as the cwd
   *  for child processes; remote / VM adapters can ignore it. */
  workdir: string;
  /** Memory blob root on the host. Adapters that mount memory stores
   *  via symlink (LocalSubprocess) read from this; remote adapters
   *  (Daytona/E2B) typically use s3fs and ignore it. */
  memoryRoot?: string;
  /** Session-outputs root on the host. LocalSubprocess symlinks
   *  per-(tenant, session) dirs under here when mountSessionOutputs
   *  is called; remote adapters that don't host-mount can ignore it. */
  outputsRoot?: string;
}

/** Read-only view of process env handed to the factory. Whole `process.env`
 *  is fine in practice — adapters cherry-pick the keys they care about
 *  (e.g. BoxRun reads `BOXRUN_URL`, E2B reads `E2B_API_KEY`). */
export type SandboxFactoryEnv = Readonly<Record<string, string | undefined>>;

export type SandboxFactory = (
  ctx: SandboxFactoryContext,
  env: SandboxFactoryEnv,
) => Promise<SandboxExecutor>;

// ─── Shared adapter helpers ─────────────────────────────────────────
//
// Lives here (not in any specific adapter file) so adapters can share
// without cross-importing each other — cross-imports drag Node-only
// modules into the CF Worker type-check graph (which excludes the
// individual adapter files).

/** Pluck S3-compatible memory-bucket config out of process env. Returns
 *  undefined when any required key is missing — adapters interpret that
 *  as "no remote memory mount available". Both Daytona and E2B share
 *  this shape (s3fs config). */
export function readS3MemoryBucket(env: SandboxFactoryEnv):
  | { endpoint: string; accessKey: string; secretKey: string; bucketName: string }
  | undefined {
  const e = env.MEMORY_S3_ENDPOINT;
  const a = env.MEMORY_S3_ACCESS_KEY;
  const s = env.MEMORY_S3_SECRET_KEY;
  const b = env.MEMORY_S3_BUCKET;
  return e && a && s && b
    ? { endpoint: e, accessKey: a, secretKey: s, bucketName: b }
    : undefined;
}
