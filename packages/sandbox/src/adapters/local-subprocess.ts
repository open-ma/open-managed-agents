// LocalSubprocessSandbox — Node child_process backed SandboxExecutor.
//
// Per-session workdir under <baseDir>/<sessionId>/. exec spawns
// `/bin/sh -c <cmd>` with cwd=workdir and a timeout watchdog. read/write
// resolve relative paths inside workdir; absolute paths are accepted as-is
// (so the harness's existing /workspace/foo conventions still land
// somewhere — we transparently rewrite /workspace → workdir).
//
// SECURITY: this adapter has zero isolation. An agent that runs `rm -rf /`
// will hit the host. ONLY use for trusted local development. Production /
// untrusted agents must use the E2B or CloudflareSandbox adapters.

import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProcessHandle, SandboxExecutor } from "../ports";

export interface LocalSubprocessSandboxOptions {
  /** Per-session working directory. Created if missing. */
  workdir: string;
  /**
   * Default command timeout in milliseconds (matches the SandboxExecutor
   * port contract). Per-call timeout overrides this.
   */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. Defaults to console. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class LocalSubprocessSandbox implements SandboxExecutor {
  private workdir: string;
  private defaultTimeoutMs: number;
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private processes = new Map<string, BackgroundProcess>();
  private logger: NonNullable<LocalSubprocessSandboxOptions["logger"]>;

  constructor(opts: LocalSubprocessSandboxOptions) {
    this.workdir = resolve(opts.workdir);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[local-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[local-sandbox] ${msg}`),
    };
    mkdirSync(this.workdir, { recursive: true });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const timeoutMs = timeout ?? this.defaultTimeoutMs;
    const env = this.buildEnv(command);

    return new Promise<string>((resolveExec) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: this.workdir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          // Give SIGTERM a beat, then SIGKILL.
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }, 1_000);
        } catch (err) {
          this.logger.warn(`exec timeout-kill failed: ${(err as Error).message}`);
        }
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(killer);
        const exit = signal ? `signal=${signal}` : `exit=${code}`;
        // Match @cloudflare/sandbox's behaviour: combined stdout+stderr,
        // newline-trimmed, plus an exit-code suffix the harness can parse.
        const combined =
          (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
          (code !== 0 ? `\n[exit ${exit}]` : "");
        resolveExec(combined);
      });

      child.on("error", (err) => {
        clearTimeout(killer);
        resolveExec(`[error: ${err.message}]`);
      });
    });
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const env = this.buildEnv(command);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: this.workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    if (!child.pid) return null;
    const id = `proc_${child.pid}_${Date.now()}`;
    const proc = new BackgroundProcess(id, child);
    this.processes.set(id, proc);
    child.on("close", () => this.processes.delete(id));
    return proc;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // Wire outbound credential injection through the oma-vault sidecar
    // (apps/oma-vault). The sidecar runs a mockttp HTTPS MITM proxy with a
    // self-signed CA; we point the subprocess at it via standard
    // HTTP(S)_PROXY env vars + tell node/curl/python to trust the local CA.
    //
    // Both env vars are read from the host process — they're set in
    // docker-compose.cfless.yml (or the operator's env) and shared between
    // main-node and the sandbox subprocess. If either is missing the agent
    // just talks to upstreams directly with no credential injection — same
    // as the CF path with no oma-vault binding.
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;

    const env: Record<string, string> = {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      // Node TLS: trust the vault CA in addition to system roots.
      NODE_EXTRA_CA_CERTS: caCertPath,
      // curl & python's `requests` (when REQUESTS_CA_BUNDLE not set).
      SSL_CERT_FILE: caCertPath,
      // Some tools look for this name specifically.
      CURL_CA_BUNDLE: caCertPath,
    };
    await this.setEnvVars(env);
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolvePath(path), "utf8");
  }

  async writeFile(path: string, content: string): Promise<string> {
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return full;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
    return full;
  }

  async destroy(): Promise<void> {
    for (const proc of this.processes.values()) {
      try { await proc.kill("SIGKILL"); } catch { /* best-effort */ }
    }
    this.processes.clear();
    try {
      rmSync(this.workdir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`destroy: failed to remove workdir ${this.workdir}`, err);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve a sandbox-relative path to a host absolute path inside workdir.
   * The harness emits /workspace/foo conventions assuming a real container
   * mount; we transparently rewrite /workspace → workdir so existing tools
   * keep working without changes.
   */
  private resolvePath(p: string): string {
    let normalised = p;
    if (normalised.startsWith("/workspace/")) normalised = normalised.slice("/workspace/".length);
    else if (normalised === "/workspace") normalised = "";
    else if (normalised.startsWith("/")) normalised = normalised.slice(1);
    if (isAbsolute(normalised)) return normalised; // explicit absolute escape — caller's responsibility
    return join(this.workdir, normalised);
  }

  private buildEnv(command: string): NodeJS.ProcessEnv {
    const base: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.envVars,
      PWD: this.workdir,
    };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(base, secrets);
    }
    return base;
  }
}

class BackgroundProcess implements ProcessHandle {
  pid: number;
  private child: ChildProcess;
  private stdout = "";
  private stderr = "";
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

  constructor(public id: string, child: ChildProcess) {
    this.child = child;
    this.pid = child.pid ?? 0;
    child.stdout?.on("data", (b: Buffer) => { this.stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { this.stderr += b.toString("utf8"); });
    child.on("close", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal as NodeJS.Signals | null;
    });
  }

  async kill(signal: string): Promise<void> {
    try {
      this.child.kill(signal as NodeJS.Signals);
    } catch (err) {
      throw new Error(`kill failed: ${(err as Error).message}`);
    }
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  async getStatus(): Promise<string> {
    if (this.exitCode === null && this.exitSignal === null) return "running";
    // Match the status vocabulary @cloudflare/sandbox uses — pollWithStrategies
    // in apps/agent/src/harness/tools.ts checks for "completed" / "error" /
    // "killed" exactly. Returning "exited:0" / "signaled:SIGTERM" silently
    // hangs the harness's tool-call wait loop until the watchdog fires.
    if (this.exitSignal) return "killed";
    return this.exitCode === 0 ? "completed" : "error";
  }
}
