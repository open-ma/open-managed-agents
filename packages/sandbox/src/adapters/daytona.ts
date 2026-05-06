// Daytona SaaS implementation of SandboxExecutor.
//
// Each session gets its own Daytona Sandbox (a managed Linux VM with
// FileSystem + Process APIs). Lazy-created on first use because sandbox
// boot is ~5–10s and the harness's first call is usually a real exec —
// we don't want to pay the latency before we know we need it.
//
// Driver dep is a peer with peerDependenciesMeta.optional so this package
// compiles + runs without `@daytonaio/sdk` installed. self-host deploys that
// want this adapter install it: `pnpm add @daytonaio/sdk`.
//
// Auth: pass apiKey in opts OR set DAYTONA_API_KEY in process.env.
//
// Outbound credential injection (oma-vault): on first sandbox creation we
// upload OMA_VAULT_CA_CERT into the box at /etc/ssl/oma-vault-ca.crt, then
// every exec gets HTTP(S)_PROXY / NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
// CURL_CA_BUNDLE pointing at the proxy + uploaded cert. The proxy URL must
// be reachable from inside the Daytona sandbox network — set OMA_VAULT_
// PROXY_URL to a public host (or a tunneled URL like ngrok) when running
// remote.
//
// Memory store mount via s3fs: when MEMORY_S3_* env vars are set, we
// install s3fs-fuse on first sandbox creation and mount the bucket at
// /mnt/_oma_storage. mountMemoryStore({storeName, storeId}) then symlinks
// /mnt/memory/<storeName> → /mnt/_oma_storage/<storeId>/. Without those
// env vars, mountMemoryStore throws (remote sandboxes can't bind a host
// dir; s3 is the only path).
//
// SECURITY: Daytona runs each sandbox in an isolated VM so this is the
// safer choice for production / untrusted agents vs LocalSubprocessSandbox.

import type { ProcessHandle, SandboxExecutor } from "../ports";
import { promises as fs } from "node:fs";

export interface DaytonaSandboxOptions {
  /** Per-session identifier — used as the Sandbox label so existing
   *  sandboxes can be looked up after a process restart. */
  sessionId: string;
  /** Daytona API key. Falls back to DAYTONA_API_KEY env var. */
  apiKey?: string;
  /** Daytona API URL (when self-hosting). Falls back to DAYTONA_API_URL. */
  apiUrl?: string;
  /** Container image to run. Default: `node:22-slim`. The image must
   *  ship `sh`, `curl`, and the standard coreutils — the harness's bash
   *  tool relies on them. For s3fs memory mounts the image needs `apt`
   *  (we install s3fs-fuse on boot). */
  image?: string;
  /** Default per-call timeout (ms). Per-call timeout overrides this. */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /** Optional s3 bucket config for memory store mounts. When set,
   *  ensureSandbox installs s3fs and mounts the bucket at
   *  /mnt/_oma_storage; mountMemoryStore symlinks per-store prefixes
   *  underneath. Mirrors the E2B adapter's memoryBucket pattern. */
  memoryBucket?: {
    endpoint: string;       // e.g. https://s3.amazonaws.com or your minio
    accessKey: string;
    secretKey: string;
    bucketName: string;
  };
}

// Minimal structural types so this file compiles without `@daytonaio/sdk`
// installed. The actual driver is dynamic-imported inside ensureSandbox.
interface DaytonaExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: { stdout?: string; stderr?: string };
}
interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecuteResponse>;
}
interface DaytonaFileSystem {
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  createFolder(path: string, mode: string): Promise<void>;
}
interface DaytonaSandboxInstance {
  id: string;
  process: DaytonaProcess;
  fs: DaytonaFileSystem;
}
interface DaytonaClient {
  create(params: {
    image?: string;
    labels?: Record<string, string>;
    envVars?: Record<string, string>;
  }): Promise<DaytonaSandboxInstance>;
  delete(sandbox: DaytonaSandboxInstance, timeout?: number): Promise<void>;
}

export class DaytonaSandbox implements SandboxExecutor {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private sandboxPromise: Promise<DaytonaSandboxInstance> | null = null;
  private daytona: DaytonaClient | null = null;
  private logger: NonNullable<DaytonaSandboxOptions["logger"]>;

  constructor(private opts: DaytonaSandboxOptions) {
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[daytona-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[daytona-sandbox] ${msg}`),
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sb = await this.ensureSandbox();
    const env = this.buildEnv(command);
    const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
    try {
      // Daytona's executeCommand timeout is in seconds; round up to the
      // nearest second so a 100ms timeout doesn't degenerate to 0.
      const r = await sb.process.executeCommand(
        command,
        undefined,
        env,
        Math.max(1, Math.ceil(timeoutMs / 1000)),
      );
      const stdout = r.artifacts?.stdout ?? "";
      const stderr = r.artifacts?.stderr ?? "";
      // Match @cloudflare/sandbox + LocalSubprocess: combined output, exit
      // suffix on non-zero. The harness's bash tool parser keys off this.
      const combined =
        (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
        (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
      return combined;
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    }
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    // Daytona has session-based async commands but mapping that onto our
    // ProcessHandle (with kill/getStatus/getLogs) needs a session-per-pid
    // bookkeeping pass we haven't done yet. Returning null means the
    // harness's startProcess callers fall back to exec() with a longer
    // timeout — correct behaviour, just no kill primitive.
    void command;
    return null;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;
    // Defer the actual cert upload until the sandbox is created — we need
    // the box to exist before we can fs.uploadFile into it. The proxy URL
    // must be reachable from inside the Daytona sandbox network; if it's
    // a localhost URL the operator probably wants ngrok / a public URL
    // for remote deploys.
    if (proxyUrl.startsWith("http://localhost") || proxyUrl.startsWith("http://127.")) {
      this.logger.warn(
        `[daytona] OMA_VAULT_PROXY_URL points at localhost (${proxyUrl}) — ` +
        `this is unreachable from inside Daytona's network. Set a public URL ` +
        `or tunnel the vault (e.g. ngrok http 14322).`,
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
  }

  async readFile(path: string): Promise<string> {
    const sb = await this.ensureSandbox();
    const buf = await sb.fs.downloadFile(this.normalise(path));
    return buf.toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<string> {
    const sb = await this.ensureSandbox();
    const target = this.normalise(path);
    await this.ensureParentDir(sb, target);
    await sb.fs.uploadFile(Buffer.from(content, "utf8"), target);
    return target;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const sb = await this.ensureSandbox();
    const target = this.normalise(path);
    await this.ensureParentDir(sb, target);
    await sb.fs.uploadFile(Buffer.from(bytes), target);
    return target;
  }

  async destroy(): Promise<void> {
    if (!this.sandboxPromise) return;
    try {
      const sb = await this.sandboxPromise;
      await this.daytona?.delete(sb);
    } catch (err) {
      this.logger.warn(`destroy failed: ${(err as Error).message}`);
    } finally {
      this.sandboxPromise = null;
    }
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) {
      throw new Error(
        "DaytonaSandbox.mountMemoryStore: no memoryBucket config — pass " +
        "memoryBucket: { endpoint, accessKey, secretKey, bucketName } to " +
        "the constructor (or set E2B_MEMORY_S3_* env vars in main-node) " +
        "so we can mount via s3fs. Without it, /mnt/memory has nowhere to " +
        "land in a remote sandbox.",
      );
    }
    const sb = await this.ensureSandbox();
    if (!this.memoryBucketMounted) {
      await this.mountMemoryBucketRoot(sb, cfg);
      this.memoryBucketMounted = true;
    }
    // Symlink /mnt/memory/<storeName> → /mnt/_oma_storage/<storeId>/. The
    // store-id directory may not exist on the bucket yet; that's fine,
    // s3fs surfaces it as an empty directory listing and writes create
    // the prefix lazily.
    const link = `/mnt/memory/${opts.storeName}`;
    const target = `/mnt/_oma_storage/${opts.storeId}`;
    await sb.process.executeCommand(
      `mkdir -p /mnt/memory && rm -rf ${shellEscape(link)} && ln -s ${shellEscape(target)} ${shellEscape(link)}`,
      undefined,
      undefined,
      30,
    );
    this.logger.log(`mounted memory store ${opts.storeName} → ${target}`);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pendingCaUpload: { hostPath: string } | null = null;
  private memoryBucketMounted = false;

  private async ensureSandbox(): Promise<DaytonaSandboxInstance> {
    if (this.sandboxPromise) return this.sandboxPromise;
    this.sandboxPromise = (async () => {
      const apiKey = this.opts.apiKey ?? process.env.DAYTONA_API_KEY;
      if (!apiKey) {
        throw new Error(
          "DaytonaSandbox: apiKey not provided and DAYTONA_API_KEY env var not set",
        );
      }
      type DaytonaModule = {
        Daytona: new (config: { apiKey: string; apiUrl?: string }) => DaytonaClient;
      };
      const mod = (await import(
        /* @vite-ignore */ "@daytonaio/sdk" as string,
      ).catch((err) => {
        throw new Error(
          `DaytonaSandbox: failed to load '@daytonaio/sdk' — ` +
          `pnpm add @daytonaio/sdk (cause: ${String(err)})`,
        );
      })) as DaytonaModule;
      this.daytona = new mod.Daytona({
        apiKey,
        apiUrl: this.opts.apiUrl ?? process.env.DAYTONA_API_URL,
      });
      this.logger.log(`creating sandbox for session ${this.opts.sessionId}`);
      const sb = await this.daytona.create({
        image: this.opts.image ?? "node:22-slim",
        labels: { "oma-session-id": this.opts.sessionId },
      });
      this.logger.log(`sandbox ${sb.id} ready`);

      // Apply pending CA upload now that the box exists. Fire-and-forget
      // so a CA-less image doesn't block the harness on first exec; if
      // upload fails the per-exec env vars still point at the missing path
      // and outbound TLS will fail with cert errors — surfaced naturally.
      if (this.pendingCaUpload) {
        try {
          const buf = await fs.readFile(this.pendingCaUpload.hostPath);
          await sb.fs.createFolder("/etc/ssl", "0755").catch(() => { /* exists */ });
          await sb.fs.uploadFile(buf, "/etc/ssl/oma-vault-ca.crt");
          this.logger.log(`uploaded vault CA cert (${buf.byteLength} bytes)`);
        } catch (err) {
          this.logger.warn(
            `vault CA upload failed: ${(err as Error).message} — outbound ` +
            `TLS through oma-vault will fail with cert errors`,
          );
        }
      }
      return sb;
    })();
    return this.sandboxPromise;
  }

  /**
   * One-time setup for the s3fs-mounted memory bucket. Installs s3fs-fuse
   * via apt (image must have apt + sudo or run as root), writes a creds
   * file, and mounts the bucket at /mnt/_oma_storage. Idempotent on the
   * adapter (memoryBucketMounted flag).
   */
  private async mountMemoryBucketRoot(
    sb: DaytonaSandboxInstance,
    cfg: NonNullable<DaytonaSandboxOptions["memoryBucket"]>,
  ): Promise<void> {
    // Heredoc the creds file so the secret never appears in `ps`.
    const setup = [
      "set -e",
      "if ! command -v s3fs >/dev/null 2>&1; then",
      "  apt-get update -qq && apt-get install -y -qq s3fs >/dev/null",
      "fi",
      "mkdir -p /mnt/_oma_storage",
      `cat > /etc/passwd-s3fs <<'EOF'\n${cfg.accessKey}:${cfg.secretKey}\nEOF`,
      "chmod 600 /etc/passwd-s3fs",
      "mountpoint -q /mnt/_oma_storage || " +
        `s3fs ${shellEscape(cfg.bucketName)} /mnt/_oma_storage ` +
        `-o url=${shellEscape(cfg.endpoint)} -o use_path_request_style -o allow_other`,
    ].join(" && ");
    const r = await sb.process.executeCommand(setup, undefined, undefined, 120);
    if (r.exitCode !== 0) {
      throw new Error(
        `Daytona s3fs mount failed (exit=${r.exitCode}): ${r.artifacts?.stderr ?? r.result ?? ""}`,
      );
    }
    this.logger.log(`s3fs mounted bucket ${cfg.bucketName} at /mnt/_oma_storage`);
  }

  /**
   * Map sandbox-relative paths to absolute container paths. Mirror
   * LocalSubprocessSandbox: /workspace/foo → /workspace/foo (Daytona's
   * default workdir is /workspace anyway), absolute paths pass through.
   */
  private normalise(p: string): string {
    if (p.startsWith("/")) return p;
    return `/workspace/${p}`;
  }

  private async ensureParentDir(sb: DaytonaSandboxInstance, filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = filePath.slice(0, slash);
    try {
      await sb.fs.createFolder(dir, "0755");
    } catch {
      // Already exists or permission denied; let the upload's own error
      // surface if the dir really isn't writable.
    }
  }

  private buildEnv(command: string): Record<string, string> {
    const out: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(out, secrets);
    }
    return out;
  }
}

/** Shell-escape an arbitrary string for safe inclusion in a `sh -c` command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
