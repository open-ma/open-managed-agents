// E2B (e2b.dev) implementation of SandboxPort.
//
// Lazy-imports the `e2b` SDK so this package compiles without it. The
// driver dep lives in your deployment's package.json:
//   pnpm add e2b -w   # or wherever you build the Node entry
//
// Production path for self-host: each session becomes a Firecracker microVM
// spun up via E2B's API. Boot time ~250ms cold from a warm pool, sub-200MB
// memory, full filesystem, network access controlled by the template image.
//
// Mapping to SandboxPort:
//   exec(cmd)              → sandbox.commands.run(cmd) (sync mode, capture stdout/stderr/exitCode)
//   startProcess(cmd)      → sandbox.commands.run(cmd, { background: true })
//   readFile / writeFile   → sandbox.files.read / write
//   destroy()              → sandbox.kill()
//
// Auth: pass apiKey at construction. If unset, the SDK reads E2B_API_KEY
// from process.env.

import type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "../ports";
import { readS3MemoryBucket } from "../ports";

// Structural types so this file compiles without `e2b` installed. The
// driver shape is matched at runtime; mismatches surface as adapter
// errors rather than module-load errors.
interface E2BCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
interface E2BCommandHandle {
  pid: number;
  kill(): Promise<boolean | void>;
  wait?(): Promise<E2BCommandResult>;
  sendStdin?(data: string | Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
}
interface E2BCommandOptions {
  timeoutMs?: number;
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
}
interface E2BSandboxLike {
  sandboxId?: string;
  commands: {
    run(
      cmd: string,
      opts?: E2BCommandOptions,
    ): Promise<E2BCommandResult | E2BCommandHandle>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    makeDir?(path: string): Promise<void>;
  };
  kill(): Promise<void>;
  getInfo?(): Promise<{ state?: string }>;
  setTimeout?(timeoutMs: number): Promise<void>;
  pause?(opts?: { keepMemory?: boolean }): Promise<boolean>;
  connect?(): Promise<E2BSandboxLike>;
  createSnapshot?(opts?: { name?: string }): Promise<{
    snapshotId: string;
    names: string[];
  }>;
}

export interface E2BSandboxOptions {
  /** E2B API key. Falls back to process.env.E2B_API_KEY. */
  apiKey?: string;
  /** E2B-compatible control-plane URL. Falls back to E2B_API_URL. */
  apiUrl?: string;
  /** Optional sandbox traffic URL. Falls back to E2B_SANDBOX_URL. */
  sandboxUrl?: string;
  /** Optional E2B-compatible base domain. Falls back to E2B_DOMAIN. */
  domain?: string;
  /**
   * Template id (the `template` field in E2B's UI). Default "base" matches
   * the SDK's default — has python/node/git/curl etc preinstalled. Override
   * with a custom template per `environment.sandbox_template` config when
   * an agent needs additional packages.
   *
   * For mountMemoryStore to work, the template MUST have `s3fs` installed:
   *   Template().fromImage("ubuntu:latest").aptInstall(["s3fs"])
   */
  templateId?: string;
  /** Default per-command timeout in ms. */
  defaultTimeoutMs?: number;
  /** Logger for debug output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void };
  /**
   * S3-compatible bucket holding memory store content. Required only if
   * mountMemoryStore() will be called. Mirrors what apps/agent's
   * CloudflareSandbox reads from MEMORY_BUCKET_NAME / R2_ENDPOINT etc.
   * Works against R2 / Tigris / MinIO / AWS S3 — any S3 API.
   */
  memoryBucket?: {
    endpoint: string;       // e.g. https://<account>.r2.cloudflarestorage.com
    accessKey: string;
    secretKey: string;
    bucketName: string;
    /** Required for non-AWS S3 (R2 / MinIO / etc.). Defaults to true. */
    usePathRequestStyle?: boolean;
  };
}

/**
 * Build an E2BSandbox bound to a fresh remote sandbox. async because
 * the underlying Sandbox.create() is async. Caller awaits and then uses
 * the returned executor for the session lifetime.
 */
export async function createE2BSandbox(
  opts: E2BSandboxOptions = {},
): Promise<E2BSandboxExecutor> {
  const mod = await loadE2BModule();
  const sb = await mod.Sandbox.create(
    opts.templateId ?? "base",
    creationOptions(opts),
  );
  return new E2BSandboxExecutor(sb, opts);
}

export class E2BSandboxExecutor
  implements SandboxPort, SandboxDuplexProcessPort, SandboxRuntimePort {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private defaultTimeoutMs: number;
  private logger: NonNullable<E2BSandboxOptions["logger"]>;
  /** Tracks whether s3fs has already mounted the memory bucket root.
   *  We mount once per sandbox lifetime; subsequent mountMemoryStore calls
   *  just symlink prefixes. */
  private memoryBucketMounted = false;
  private memoryBucketConfig?: NonNullable<E2BSandboxOptions["memoryBucket"]>;

  constructor(
    private sandbox: E2BSandboxLike,
    opts: E2BSandboxOptions,
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[e2b-sandbox] ${msg}`, ctx ?? ""),
    };
    this.memoryBucketConfig = opts.memoryBucket;
  }

  runtimeHandle(): SandboxRuntimeHandle {
    return { provider: "e2b", runtimeId: this.requireRuntimeId() };
  }

  runtimeCapabilities(): SandboxRuntimeCapabilities {
    return {
      lease: true,
      suspend: ["filesystem", "memory"],
      checkpoint: ["memory"],
    };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (typeof this.sandbox.getInfo !== "function") return "unknown";
    const info = await this.sandbox.getInfo();
    if (info.state === "running") return "running";
    if (info.state === "paused") return "suspended";
    return "unknown";
  }

  async renewLease(input: { ttlMs: number }): Promise<void> {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("E2B lease ttlMs must be a positive integer");
    }
    if (typeof this.sandbox.setTimeout !== "function") {
      throw new Error("E2B SDK does not expose sandbox.setTimeout");
    }
    await this.sandbox.setTimeout(input.ttlMs);
  }

  async suspend(input: {
    kind: "filesystem" | "memory";
  }): Promise<SandboxCheckpointHandle> {
    if (typeof this.sandbox.pause !== "function") {
      throw new Error("E2B SDK does not expose sandbox.pause");
    }
    const runtimeId = this.requireRuntimeId();
    await this.sandbox.pause({ keepMemory: input.kind === "memory" });
    return {
      provider: "e2b",
      checkpointId: runtimeId,
      sourceRuntimeId: runtimeId,
      kind: input.kind,
      scope: "runtime",
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    const runtimeId = this.requireRuntimeId();
    if (
      checkpoint.provider !== "e2b"
      || checkpoint.scope !== "runtime"
      || checkpoint.checkpointId !== runtimeId
    ) {
      throw new Error("E2B runtime can only resume its own runtime-scoped checkpoint");
    }
    if (typeof this.sandbox.connect !== "function") {
      throw new Error("E2B SDK does not expose sandbox.connect");
    }
    this.sandbox = await this.sandbox.connect();
  }

  async checkpoint(input: {
    kind: "filesystem" | "memory";
    name?: string;
  }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "memory") {
      throw new Error("E2B durable checkpoints currently support memory state only");
    }
    if (typeof this.sandbox.createSnapshot !== "function") {
      throw new Error("E2B SDK does not expose sandbox.createSnapshot");
    }
    const runtimeId = this.requireRuntimeId();
    const snapshot = await this.sandbox.createSnapshot(
      input.name ? { name: input.name } : undefined,
    );
    return {
      provider: "e2b",
      checkpointId: snapshot.snapshotId,
      sourceRuntimeId: runtimeId,
      kind: "memory",
      scope: "portable",
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const wrapped = this.applyEnv(command);
    const result = (await this.sandbox.commands.run(wrapped, {
      timeoutMs: timeout ?? this.defaultTimeoutMs,
    })) as E2BCommandResult;
    // Match @cloudflare/sandbox's behaviour: combined stdout+stderr,
    // newline-trimmed, plus an exit-code suffix.
    const combined =
      (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).replace(/\s+$/, "") +
      (result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : "");
    return combined;
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const wrapped = this.applyEnv(command);
    const handle = (await this.sandbox.commands.run(wrapped, {
      background: true,
    })) as E2BCommandHandle;
    if (!handle.pid) return null;
    const id = `proc_${handle.pid}_${Date.now()}`;
    return new E2BProcessHandle(id, handle);
  }

  async spawnDuplexProcess(
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess> {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let streamsSettled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    const encoder = new TextEncoder();
    const settleStreams = (error?: Error) => {
      if (streamsSettled) return;
      streamsSettled = true;
      for (const controller of [stdoutController, stderrController]) {
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // The corresponding consumer may already have cancelled its stream.
        }
      }
    };
    const enqueue = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      data: string,
    ) => {
      if (streamsSettled || data.length === 0) return;
      try {
        controller.enqueue(encoder.encode(data));
      } catch {
        // The corresponding consumer may already have cancelled its stream.
      }
    };

    const command = [spec.command, ...(spec.args ?? [])]
      .map(shellEscape)
      .join(" ");
    const handle = (await this.sandbox.commands.run(command, {
      background: true,
      stdin: true,
      // E2B otherwise closes the process event stream after 60 seconds.
      // ConnectRPC treats a non-positive timeout as no deadline.
      timeoutMs: 0,
      cwd: spec.cwd,
      envs: this.buildCommandEnv(spec.command, spec.env),
      onStdout: (data) => enqueue(stdoutController, data),
      onStderr: (data) => enqueue(stderrController, data),
    })) as E2BCommandHandle;
    if (
      typeof handle.wait !== "function"
      || typeof handle.sendStdin !== "function"
      || typeof handle.closeStdin !== "function"
    ) {
      await handle.kill().catch(() => undefined);
      settleStreams();
      throw new Error(
        "E2B SDK does not expose the live-stdin CommandHandle required by ACP",
      );
    }

    let requestedSignal: "SIGTERM" | "SIGKILL" | null = null;
    let exitedSettled = false;
    let resolveExited!: (
      value: { code: number | null; signal: string | null },
    ) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => { resolveExited = resolve; },
    );
    const finish = (code: number | null, signal: string | null, error?: Error) => {
      settleStreams(error);
      if (exitedSettled) return;
      exitedSettled = true;
      resolveExited({ code, signal });
    };
    void handle.wait().then(
      (result) => finish(result.exitCode, requestedSignal),
      (cause: unknown) => {
        if (requestedSignal !== null) {
          finish(null, requestedSignal);
          return;
        }
        const exitCode = readExitCode(cause);
        if (exitCode !== null) {
          finish(exitCode, null);
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        finish(null, null, error);
      },
    );

    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (exitedSettled) throw new Error("cannot write to an exited E2B process");
        await handle.sendStdin!(chunk);
      },
      close: async () => {
        if (!exitedSettled) await handle.closeStdin!();
      },
      abort: async () => {
        if (exitedSettled) return;
        requestedSignal = "SIGKILL";
        await handle.kill();
        finish(null, requestedSignal);
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async (signal = "SIGTERM") => {
        if (exitedSettled) return;
        // E2B v2 currently exposes SIGKILL only. Preserve the caller's
        // requested signal in the portable lifecycle result.
        requestedSignal = signal;
        await handle.kill();
        finish(null, requestedSignal);
      },
    };
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // Wire HTTPS_PROXY → oma-vault sidecar + upload its self-signed CA so
    // node/curl/python trust the MITM cert. Requires (a) OMA_VAULT_PROXY_URL
    // reachable from the E2B sandbox network — set to a public URL or a
    // tunnel host; localhost won't resolve from inside the microVM —
    // and (b) a sandbox template that lets `sudo` install / write a CA
    // (most ubuntu-based templates do).
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;
    if (proxyUrl.startsWith("http://localhost") || proxyUrl.startsWith("http://127.")) {
      this.logger.warn(
        `E2B: OMA_VAULT_PROXY_URL points at localhost (${proxyUrl}) — ` +
        `unreachable from inside the E2B sandbox. Use a public URL or tunnel.`,
      );
    }
    this.pendingCaUpload = { hostPath: caCertPath };
    const inBoxCaPath = "/etc/ssl/oma-vault-ca.crt";
    await this.setEnvVars({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NODE_EXTRA_CA_CERTS: inBoxCaPath,
      SSL_CERT_FILE: inBoxCaPath,
      CURL_CA_BUNDLE: inBoxCaPath,
    });
    // Best-effort: upload now if the sandbox is already created. Otherwise
    // applyPendingCaUpload runs on the next call that creates the sandbox.
    try {
      await this.applyPendingCaUpload();
    } catch (err) {
      this.logger.warn(`E2B vault CA upload failed: ${(err as Error).message}`);
    }
  }

  private pendingCaUpload: { hostPath: string } | null = null;

  private async applyPendingCaUpload(): Promise<void> {
    if (!this.pendingCaUpload) return;
    const { promises: nodeFs } = await import("node:fs");
    const buf = await nodeFs.readFile(this.pendingCaUpload.hostPath);
    await this.sandbox.files.write("/etc/ssl/oma-vault-ca.crt", buf);
    this.pendingCaUpload = null;
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.files.read(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    // E2B's files.read returns string (UTF-8). Use a base64 shell helper
    // for binary safety — same workaround the CF SessionDO uses.
    const out = await this.exec(
      `base64 -w0 -- '${path.replace(/'/g, "'\\''")}'`,
      30_000,
    );
    if (out.includes("[exit ")) {
      throw new Error(`E2B readFileBytes failed: ${out.slice(0, 200)}`);
    }
    const b64 = out.trim();
    const bin = Buffer.from(b64, "base64");
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.sandbox.files.write(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.sandbox.files.write(path, bytes);
    return path;
  }

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<storeName>/.
   *
   * Strategy: s3fs mounts the WHOLE bucket once at /mnt/_oma_storage on the
   * first call; per-store mounts are then symlinks from that mount under
   * the store-id prefix. This avoids one s3fs process per store (hundreds
   * of stores per session would exhaust file descriptors otherwise).
   *
   * Requires:
   *   1. The E2B template has `s3fs` installed (apt-get install s3fs)
   *   2. memoryBucket: { endpoint, accessKey, secretKey, bucketName } was
   *      passed at sandbox construction
   *
   * Read-only enforcement: PoC limitation — symlinks don't enforce ro.
   * Future work: bind-mount with `-o ro` for read-only stores. Today
   * read-only is honoured at the application layer (memory tools refuse
   * write ops on stores the agent has read-only access to).
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const cfg = this.memoryBucketConfig;
    if (!cfg) {
      throw new Error(
        "mountMemoryStore: E2BSandbox constructed without memoryBucket config — " +
          "pass { memoryBucket: { endpoint, accessKey, secretKey, bucketName } } to createE2BSandbox",
      );
    }

    if (!this.memoryBucketMounted) {
      // First call: write s3fs credentials and mount the bucket root.
      await this.sandbox.files.write(
        "/root/.passwd-s3fs",
        `${cfg.accessKey}:${cfg.secretKey}\n`,
      );
      await this.runOrThrow("sudo chmod 600 /root/.passwd-s3fs");
      await this.runOrThrow("sudo mkdir -p /mnt/_oma_storage");
      const flags = [
        `-o url=${shellEscape(cfg.endpoint)}`,
        cfg.usePathRequestStyle === false ? "" : "-o use_path_request_style",
        // allow_other so the unprivileged sandbox user can read; nonempty
        // so we can re-mount over an existing dir without errors.
        "-o allow_other",
        "-o nonempty",
        "-o uid=1000",
        "-o gid=1000",
      ]
        .filter(Boolean)
        .join(" ");
      await this.runOrThrow(
        `sudo s3fs ${shellEscape(cfg.bucketName)} /mnt/_oma_storage ${flags}`,
      );
      this.memoryBucketMounted = true;
      this.logger.warn(
        `mountMemoryStore: bucket ${cfg.bucketName} mounted at /mnt/_oma_storage`,
      );
    }

    // Per-store: ensure the mount-point dir + symlink the prefix.
    const mountPoint = `/mnt/memory/${opts.storeName}`;
    const sourcePath = `/mnt/_oma_storage/${opts.storeId}`;
    await this.runOrThrow(`sudo mkdir -p /mnt/memory && sudo rm -rf ${shellEscape(mountPoint)}`);
    await this.runOrThrow(`sudo ln -sfn ${shellEscape(sourcePath)} ${shellEscape(mountPoint)}`);
    if (opts.readOnly) {
      // Best-effort chmod -w; s3fs respects FUSE-level read-only via
      // a remount which the sandbox SDK doesn't expose. Document the
      // residual gap in docs/self-host.md.
      await this.runOrThrow(
        `sudo chmod -R a-w ${shellEscape(sourcePath)} 2>/dev/null || true`,
      );
    }
  }

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    return this.memoryBucketConfig === undefined
      ? null
      : { durability: "durable" };
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    // Reuses the same s3fs bucket as memory under a session-scoped prefix.
    const cfg = this.memoryBucketConfig;
    if (!cfg) {
      throw new Error(
        "E2BSandbox.mountSessionOutputs: no memoryBucket config — sessions " +
        "outputs share the bucket with memory under session-outputs/<tenant>/<session>/",
      );
    }
    if (!this.memoryBucketMounted) {
      // mountMemoryStore handles mount-once; reuse via a no-op store
      // mount when the caller hasn't asked for any.
      await this.mountMemoryStore({
        storeName: "_outputs_bootstrap",
        storeId: "_outputs_bootstrap",
        readOnly: true,
      });
    }
    const mountPoint = `/mnt/session/outputs`;
    const sourcePath = `/mnt/_oma_storage/session-outputs/${opts.tenantId}/${opts.sessionId}`;
    await this.runOrThrow(
      `sudo mkdir -p /mnt/session && sudo rm -rf ${shellEscape(mountPoint)}`,
    );
    await this.runOrThrow(
      `sudo ln -sfn ${shellEscape(sourcePath)} ${shellEscape(mountPoint)}`,
    );
  }

  /** Run a command, throw with combined output on non-zero exit. Used for
   *  setup commands where silent failure (e.g. s3fs mount issues) would
   *  leave the agent staring at an empty mount-point with no clue why. */
  private async runOrThrow(command: string): Promise<void> {
    const out = await this.exec(command, 30_000);
    if (out.includes("[exit ")) {
      throw new Error(`E2BSandbox setup command failed: ${command}\n  → ${out}`);
    }
  }

  async destroy(): Promise<void> {
    try {
      await this.sandbox.kill();
    } catch (err) {
      this.logger.warn(`destroy failed: ${(err as Error).message}`);
    }
  }

  private requireRuntimeId(): string {
    if (!this.sandbox.sandboxId) {
      throw new Error("E2B SDK did not return a sandboxId");
    }
    return this.sandbox.sandboxId;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Prefix env-var assignments and command-prefix secrets for the legacy
   * string-command paths. Duplex processes use E2B v2's native `envs` field. */
  private applyEnv(command: string): string {
    const env = this.buildCommandEnv(command);
    if (Object.keys(env).length === 0) return command;
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(" ");
    return `${exports} ${command}`;
  }

  private buildCommandEnv(
    command: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string> {
    const env: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(env, secrets);
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    return env;
  }
}

class E2BProcessHandle implements ProcessHandle {
  pid: number;
  private stdout = "";
  private stderr = "";
  private waitPromise: Promise<E2BCommandResult> | null = null;
  private finalResult: E2BCommandResult | null = null;

  constructor(public id: string, private handle: E2BCommandHandle) {
    this.pid = handle.pid;
    if (handle.wait) {
      this.waitPromise = handle.wait().then((r) => {
        this.finalResult = r;
        this.stdout = r.stdout;
        this.stderr = r.stderr;
        return r;
      });
    }
  }

  async kill(signal: string): Promise<void> {
    // The E2B v2 command API only exposes SIGKILL; retain ProcessHandle's
    // portable signature while delegating to the supported primitive.
    void signal;
    try { await this.handle.kill(); } catch (err) {
      throw new Error(`kill failed: ${(err as Error).message}`);
    }
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  async getStatus(): Promise<string> {
    if (this.finalResult === null) return "running";
    if (this.finalResult.exitCode === 0) return "completed";
    return "error";
  }
}

function shellEscape(value: string): string {
  // Single-quote-wrap; double any embedded single quotes via the
  // ' '\'' ' idiom which is portable across POSIX shells.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readExitCode(cause: unknown): number | null {
  if (
    typeof cause === "object"
    && cause !== null
    && "exitCode" in cause
    && typeof cause.exitCode === "number"
  ) {
    return cause.exitCode;
  }
  return null;
}

// ── Factory (DIP entry point) ───────────────────────────────────────

type E2BConnectionOptions = Pick<
  E2BSandboxOptions,
  "apiKey" | "apiUrl" | "sandboxUrl" | "domain"
>;

type E2BCreateOptions = E2BConnectionOptions & {
  lifecycle: {
    onTimeout: { action: "pause"; keepMemory: true };
    autoResume: true;
  };
};

interface E2BModule {
  Sandbox: {
    create(template: string, args?: E2BCreateOptions): Promise<E2BSandboxLike>;
    connect(sandboxId: string, args?: E2BConnectionOptions): Promise<E2BSandboxLike>;
  };
}

async function loadE2BModule(): Promise<E2BModule> {
  return (await import(/* @vite-ignore */ "e2b" as string).catch((err) => {
    throw new Error(
      `E2B sandbox provider failed to load 'e2b' SDK — ` +
        `pnpm add e2b (cause: ${String(err)})`,
    );
  })) as E2BModule;
}

function connectionOptions(opts: E2BConnectionOptions): E2BConnectionOptions {
  return {
    apiKey: opts.apiKey,
    apiUrl: opts.apiUrl,
    sandboxUrl: opts.sandboxUrl,
    domain: opts.domain,
  };
}

function creationOptions(opts: E2BConnectionOptions): E2BCreateOptions {
  return {
    ...connectionOptions(opts),
    // ACP keeps a live JSON-RPC process in the sandbox. Killing the sandbox
    // at the end of its lease loses that process and forces a cold restore;
    // a memory pause preserves it and E2B resumes it transparently on the
    // next command or stdin write.
    lifecycle: {
      onTimeout: { action: "pause", keepMemory: true },
      autoResume: true,
    },
  };
}

function optionsFromFactory(env: SandboxFactoryEnv): E2BSandboxOptions {
  return {
    apiKey: env.E2B_API_KEY,
    apiUrl: env.E2B_API_URL,
    sandboxUrl: env.E2B_SANDBOX_URL,
    domain: env.E2B_DOMAIN,
    templateId: env.SANDBOX_IMAGE,
    memoryBucket: readS3MemoryBucket(env),
  };
}

export const sandboxProvider: SandboxProviderPort<E2BSandboxExecutor> = {
  create: async (_ctx, env) => createE2BSandbox(optionsFromFactory(env)),
  resume: async (handle, _ctx, env) => {
    if (handle.provider !== "e2b" || !handle.runtimeId) {
      throw new Error("E2B provider received an incompatible runtime handle");
    }
    const options = optionsFromFactory(env);
    const mod = await loadE2BModule();
    const sandbox = await mod.Sandbox.connect(
      handle.runtimeId,
      connectionOptions(options),
    );
    return new E2BSandboxExecutor(sandbox, options);
  },
  restore: async (checkpoint, _ctx, env) => {
    if (
      checkpoint.provider !== "e2b"
      || checkpoint.scope !== "portable"
      || !checkpoint.checkpointId
    ) {
      throw new Error("E2B provider received an incompatible portable checkpoint");
    }
    const options = optionsFromFactory(env);
    const mod = await loadE2BModule();
    const sandbox = await mod.Sandbox.create(
      checkpoint.checkpointId,
      creationOptions(options),
    );
    return new E2BSandboxExecutor(sandbox, options);
  },
};

export const sandboxFactory: SandboxFactory = (
  ctx: SandboxFactoryContext,
  env: SandboxFactoryEnv,
) => sandboxProvider.create(ctx, env);
