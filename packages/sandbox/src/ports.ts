// Runtime-agnostic sandbox port. Originally lived in
// apps/agent/src/harness/interface.ts as the legacy `SandboxExecutor` and
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
//   - E2BSandboxExecutor (./adapters/e2b.ts) — wraps the official `e2b`
//     SDK. The configured API may be E2B Cloud or any compatible service.

export interface ProcessHandle {
  id: string;
  pid: number;
  kill(signal: string): Promise<void>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  getStatus(): Promise<string>;
}

/** Structured command used when a caller needs a live stdio channel instead
 * of the log-oriented `startProcess` handle. Kept in the sandbox package so
 * protocol runtimes (ACP today, other harnesses later) do not leak their own
 * process types into sandbox adapters. */
export interface SandboxDuplexProcessSpec {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** A sandbox-resident process with live stdio. This is intentionally
 * structurally compatible with openma-common's ACP `ChildHandle`; the ACP
 * adapter can pass it through without coupling the sandbox package to ACP. */
export interface SandboxDuplexProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/** Narrow capability Port for protocol runtimes that require live stdio.
 * Keeping this separate from SandboxPort makes the requirement explicit at
 * composition time instead of discovering an optional method mid-session. */
export interface SandboxDuplexProcessPort {
  spawnDuplexProcess(
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess>;
}

/** Stable identity for a provider-owned sandbox resource. The host persists
 * this value; adapters must never require callers to serialize SDK objects. */
export interface SandboxRuntimeHandle {
  provider: string;
  runtimeId: string;
}

export type SandboxCheckpointKind = "filesystem" | "memory";
export type SandboxCheckpointScope = "runtime" | "portable";
export type SandboxRuntimeStatus =
  | "running"
  | "suspended"
  | "stopped"
  | "unknown";

/** Serializable checkpoint reference. `runtime` scope resumes the same
 * resource; `portable` scope may create a replacement resource. */
export interface SandboxCheckpointHandle {
  provider: string;
  checkpointId: string;
  sourceRuntimeId: string;
  kind: SandboxCheckpointKind;
  scope: SandboxCheckpointScope;
  /** Serializable provider data needed to reopen the checkpoint. Hosts
   * persist it opaquely and must not branch on adapter-specific keys. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SandboxRuntimeCapabilities {
  lease: boolean;
  suspend: readonly SandboxCheckpointKind[];
  checkpoint: readonly SandboxCheckpointKind[];
}

/** Narrow resource-lifecycle Port. It is deliberately separate from file and
 * process execution so a host cannot infer pause/checkpoint support from an
 * optional method on the broad SandboxPort. */
export interface SandboxRuntimePort {
  runtimeHandle(): SandboxRuntimeHandle;
  runtimeCapabilities(): SandboxRuntimeCapabilities;
  status(): Promise<SandboxRuntimeStatus>;
  renewLease(input: { ttlMs: number }): Promise<void>;
  suspend(input: {
    kind: SandboxCheckpointKind;
  }): Promise<SandboxCheckpointHandle>;
  resume(checkpoint: SandboxCheckpointHandle): Promise<void>;
  checkpoint(input: {
    kind: SandboxCheckpointKind;
    name?: string;
  }): Promise<SandboxCheckpointHandle>;
}

/** Provider primitive for creating and restoring portable `/workspace`
 * backups. This is intentionally separate from {@link SandboxPort}: process
 * execution does not imply durable workspace support. Runtime hosts normally
 * adapt this primitive to `WorkspacePersistencePort`. */
export interface SandboxWorkspaceBackupPort {
  createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null>;
  restoreWorkspaceBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
}

/** Cloud/runtime-host managed workspace lifecycle. The host supplies the
 * durable scope before the provider's own idle/destroy hook snapshots it. */
export interface SandboxManagedWorkspaceLifecyclePort {
  setBackupContext(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void>;
  snapshotWorkspaceNow(): Promise<void>;
}

/** Provider primitive for attaching the Managed Agents output directory.
 * Runtime hosts normally adapt it to `SessionOutputPort`; it is not a generic
 * compute capability. */
export interface SandboxSessionOutputMountPort {
  sessionOutputMountCapabilities(): {
    durability: "durable" | "best_effort";
  } | null;
  mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void>;
}

export function supportsWorkspaceBackup(
  value: unknown,
): value is SandboxWorkspaceBackupPort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SandboxWorkspaceBackupPort>;
  return typeof candidate.createWorkspaceBackup === "function"
    && typeof candidate.restoreWorkspaceBackup === "function";
}

export function supportsManagedWorkspaceLifecycle(
  value: unknown,
): value is SandboxManagedWorkspaceLifecyclePort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SandboxManagedWorkspaceLifecyclePort>;
  return typeof candidate.setBackupContext === "function"
    && typeof candidate.snapshotWorkspaceNow === "function";
}

export function supportsSessionOutputMount(
  value: unknown,
): value is SandboxSessionOutputMountPort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SandboxSessionOutputMountPort>;
  if (
    typeof candidate.sessionOutputMountCapabilities !== "function"
    || typeof candidate.mountSessionOutputs !== "function"
  ) return false;
  try {
    return candidate.sessionOutputMountCapabilities() !== null;
  } catch {
    return false;
  }
}

export interface SandboxPort {
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
  readFile(path: string): Promise<string>;
  /** Read raw bytes — required for binary-safe `POST /v1/sessions/:id/files`
   *  promotion. Optional so adapters that only see text can omit it. */
  readFileBytes?(path: string): Promise<Uint8Array>;
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
  /** Destroy the sandbox — kills processes, unmounts, stops. */
  destroy?(): Promise<void>;
  /**
   * Tell the sandbox container "I'm still active". Resets CF Container's
   * sleepAfter inactivity timer; long-running bg tasks keep the box alive
   * via this. No-op on impls that don't auto-sleep.
   */
  renewActivityTimeout?(): Promise<void>;
}

/**
 * @deprecated Use `SandboxPort`. Kept as a source-compatible migration alias
 * while downstream harness and adapter packages adopt the Port name.
 */
export type SandboxExecutor = SandboxPort;

/** Runtime narrowing for applications that select a sandbox adapter from a
 * generic SandboxFactory before composing an ACP or other process runtime. */
export function supportsDuplexProcess(
  sandbox: SandboxPort,
): sandbox is SandboxPort & SandboxDuplexProcessPort {
  return "spawnDuplexProcess" in sandbox
    && typeof sandbox.spawnDuplexProcess === "function";
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
) => Promise<SandboxPort>;

/** SDK-style provider composition. `SandboxFactory` remains the v0 create
 * adapter; new runtime hosts use this Port when resources must survive the
 * current process and be attached or restored later. */
export interface SandboxProviderPort<
  Runtime extends SandboxPort & SandboxRuntimePort = SandboxPort & SandboxRuntimePort,
> {
  create(
    ctx: SandboxFactoryContext,
    env: SandboxFactoryEnv,
  ): Promise<Runtime>;
  resume(
    handle: SandboxRuntimeHandle,
    ctx: SandboxFactoryContext,
    env: SandboxFactoryEnv,
  ): Promise<Runtime>;
  restore(
    checkpoint: SandboxCheckpointHandle,
    ctx: SandboxFactoryContext,
    env: SandboxFactoryEnv,
  ): Promise<Runtime>;
}

export function supportsSandboxRuntime(
  sandbox: SandboxPort,
): sandbox is SandboxPort & SandboxRuntimePort {
  const candidate = sandbox as Partial<SandboxRuntimePort>;
  return typeof candidate.runtimeHandle === "function"
    && typeof candidate.runtimeCapabilities === "function"
    && typeof candidate.status === "function"
    && typeof candidate.renewLease === "function"
    && typeof candidate.suspend === "function"
    && typeof candidate.resume === "function"
    && typeof candidate.checkpoint === "function";
}

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
