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
//     isolation. Production CFless path.

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
   * Snapshot /workspace into durable storage. Returns a serializable
   * handle; null on failure. CF: squashfs → R2. Node: tar → S3 (when wired).
   */
  createWorkspaceBackup?(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null>;
  /**
   * Restore a previously-created backup into /workspace. Best-effort: false
   * means caller should treat /workspace as empty.
   */
  restoreWorkspaceBackup?(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<boolean>;
  /** Destroy the sandbox — kills processes, unmounts, stops. */
  destroy?(): Promise<void>;
}
