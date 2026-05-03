// Daytona SaaS implementation of SandboxExecutor.
//
// Each session gets its own Daytona Sandbox (a managed Linux VM with
// FileSystem + Process APIs). Lazy-created on first use because sandbox
// boot is ~5–10s and the harness's first call is usually a real exec —
// we don't want to pay the latency before we know we need it.
//
// Driver dep is a peer with peerDependenciesMeta.optional so this package
// compiles + runs without `@daytonaio/sdk` installed. CFless deploys that
// want this adapter install it: `pnpm add @daytonaio/sdk`.
//
// Auth: pass apiKey in opts OR set DAYTONA_API_KEY in process.env.
//
// What's NOT implemented (and why):
//   - mountMemoryStore — Daytona Cloud doesn't expose host-mount of an
//     arbitrary local dir into a sandbox. The CFless analog (s3fs against
//     a per-session prefix) is doable but needs a per-image setup script
//     to install s3fs-fuse + mount on boot. Out of scope for this PoC; if
//     you need memory in a Daytona sandbox today, do read-thru via
//     `/v1/memory_stores/:id/memories` HTTP from inside the sandbox.
//   - createWorkspaceBackup / restoreWorkspaceBackup — Daytona's snapshots
//     could back this but the API differs from the
//     SandboxExecutor port enough that wiring it well is a separate pass.
//
// SECURITY: Daytona runs each sandbox in an isolated VM so this is the
// safer choice for production / untrusted agents vs LocalSubprocessSandbox.

import type { ProcessHandle, SandboxExecutor } from "../ports";

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
   *  tool relies on them. */
  image?: string;
  /** Default per-call timeout (ms). Per-call timeout overrides this. */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
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
    // Daytona sandboxes run on Daytona's infra, not the operator's host —
    // OMA_VAULT_CA_CERT (a host path) doesn't exist inside the sandbox.
    // Emit a warning and skip; injection would need cert upload via
    // fs.uploadFile + a bootstrap script. Track for follow-up.
    this.logger.warn(
      "[daytona] setOutboundContext: vault proxy + CA injection in remote " +
      "sandboxes is not yet supported — outbound traffic will NOT be intercepted. " +
      "If you need vault injection in Daytona, switch to LocalSubprocessSandbox " +
      "or wait for the cert-upload follow-up.",
    );
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

  // ── helpers ──────────────────────────────────────────────────────────────

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
      return sb;
    })();
    return this.sandboxPromise;
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
