// E2B (e2b.dev) implementation of SandboxExecutor.
//
// Lazy-imports the `e2b` SDK so this package compiles without it. The
// driver dep lives in your deployment's package.json:
//   pnpm add e2b -w   # or wherever you build the Node entry
//
// Production path for self-host: each session becomes a Firecracker microVM
// spun up via E2B's API. Boot time ~250ms cold from a warm pool, sub-200MB
// memory, full filesystem, network access controlled by the template image.
//
// Mapping to SandboxExecutor port:
//   exec(cmd)              → sandbox.commands.run(cmd) (sync mode, capture stdout/stderr/exitCode)
//   startProcess(cmd)      → sandbox.commands.run(cmd, { background: true })
//   readFile / writeFile   → sandbox.files.read / write
//   destroy()              → sandbox.kill()
//
// Auth: pass apiKey at construction. If unset, the SDK reads E2B_API_KEY
// from process.env.

import type { ProcessHandle, SandboxExecutor, SandboxFactory } from "../ports";
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
  kill(signal?: string): Promise<void>;
  wait?(): Promise<E2BCommandResult>;
}
interface E2BSandboxLike {
  sandboxId?: string;
  commands: {
    run(
      cmd: string,
      opts?: { timeoutMs?: number; background?: boolean },
    ): Promise<E2BCommandResult | E2BCommandHandle>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    makeDir?(path: string): Promise<void>;
  };
  kill(): Promise<void>;
}

export interface E2BSandboxOptions {
  /** E2B API key. Falls back to process.env.E2B_API_KEY. */
  apiKey?: string;
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
  type E2BModule = {
    Sandbox: {
      create(args?: { apiKey?: string; template?: string }): Promise<E2BSandboxLike>;
    };
  };
  const mod = (await import(/* @vite-ignore */ "e2b" as string).catch((err) => {
    throw new Error(
      `createE2BSandbox: failed to load 'e2b' SDK — ` +
        `pnpm add e2b (cause: ${String(err)})`,
    );
  })) as E2BModule;
  const sb = await mod.Sandbox.create({
    apiKey: opts.apiKey,
    template: opts.templateId,
  });
  return new E2BSandboxExecutor(sb, opts);
}

export class E2BSandboxExecutor implements SandboxExecutor {
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

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Prefix env-var assignments AND command-prefix secrets to the command.
   * E2B's commands.run doesn't take an env option (the SDK's shape is bare
   * cmd string), so we shell-prefix instead. Matches the LocalSubprocess
   * adapter's behaviour from the model's perspective.
   */
  private applyEnv(command: string): string {
    const env: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(env, secrets);
    }
    if (Object.keys(env).length === 0) return command;
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(" ");
    return `${exports} ${command}`;
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
    try { await this.handle.kill(signal); } catch (err) {
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

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (_ctx, env) => {
  return await createE2BSandbox({
    apiKey: env.E2B_API_KEY,
    templateId: env.SANDBOX_IMAGE,
    memoryBucket: readS3MemoryBucket(env),
  });
};
