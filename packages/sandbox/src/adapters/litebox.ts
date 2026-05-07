// BoxLite (aka Litebox) implementation of SandboxExecutor.
//
// BoxLite (https://github.com/boxlite-ai/boxlite, npm: @boxlite-ai/boxlite)
// is a local-first micro-VM sandbox — each box gets its own kernel via
// Firecracker. Hardware-level isolation, no daemon required, ships a
// Rust core with a Node.js binding. The selling point vs LocalSubprocess:
// real isolation against `rm -rf /` from a prompt-injected agent without
// needing the operator to run docker.
//
// Driver dep is a peer with peerDependenciesMeta.optional — caller installs:
//   pnpm add @boxlite-ai/boxlite
//
// SDK shape (as of @boxlite-ai/boxlite ^0.8):
//   const box = new SimpleBox({ image, env, volumes, ... })
//   await box.exec("sh", ["-c", command], env, { timeoutSecs })
//   await box.copyIn(hostPath, containerPath)
//   await box.copyOut(containerPath, hostPath)
//   await box.stop()
//
// Lazy-create: BoxLite's box is created on first exec(), so any
// configuration that needs to land BEFORE creation (volumes, image, env)
// must be collected via setEnvVars / mountMemoryStore / ctor opts before
// the first exec/readFile/writeFile call. We track this via `created` —
// once true, mutating ops that affect ctor opts throw.

import type { ProcessHandle, SandboxExecutor, SandboxFactory } from "../ports";
import { promises as fs, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export interface LiteBoxSandboxOptions {
  /** Container image. Default: `node:22-slim`. */
  image?: string;
  /** Optional VM resource limits. */
  memoryMib?: number;
  cpus?: number;
  /** Default per-call timeout (ms). */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /** Optional name (must be unique). */
  name?: string;
}

interface LiteBoxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface LiteBoxInstance {
  exec(
    cmd: string,
    args: string[],
    env?: Record<string, string>,
    options?: { cwd?: string; user?: string; timeoutSecs?: number },
  ): Promise<LiteBoxExecResult>;
  copyIn(hostPath: string, containerDest: string, options?: unknown): Promise<void>;
  copyOut(containerSrc: string, hostDest: string, options?: unknown): Promise<void>;
  stop(): Promise<void>;
}

export class LiteBoxSandbox implements SandboxExecutor {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private volumes: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }> = [];
  private boxPromise: Promise<LiteBoxInstance> | null = null;
  private logger: NonNullable<LiteBoxSandboxOptions["logger"]>;
  private tmpRoot: string;

  constructor(private opts: LiteBoxSandboxOptions = {}) {
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[litebox-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[litebox-sandbox] ${msg}`),
    };
    // Per-instance host scratch dir for copyIn / copyOut staging. Cleaned
    // up on destroy.
    this.tmpRoot = join(tmpdir(), `oma-litebox-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.tmpRoot, { recursive: true });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const box = await this.ensureBox();
    const env = this.buildEnv(command);
    const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
    try {
      const r = await box.exec("sh", ["-c", command], env, {
        timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
      });
      const combined =
        (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).replace(/\s+$/, "") +
        (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
      return combined;
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    }
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    // BoxLite's exec is blocking; backgrounding would need a separate API
    // (and a ProcessHandle bookkeeping pass). Returning null keeps the
    // harness's startProcess callers correct — they fall back to exec
    // with a longer timeout.
    return null;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // BoxLite supports network — we route via env vars same as the
    // LocalSubprocess path. The CA cert lives on the host though, so
    // copy it into the box on first exec via ensureBox.
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;

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
    // Schedule the CA upload on first ensureBox call. We keep it as a
    // pending action because the box may not exist yet.
    this.pendingCaUpload = { hostPath: caCertPath, guestPath: inBoxCaPath };
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (this.boxPromise) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: box already created — mounts must " +
        "be configured before the first exec/readFile/writeFile call",
      );
    }
    const memoryRoot = process.env.MEMORY_BLOB_DIR
      ? resolve(process.env.MEMORY_BLOB_DIR)
      : null;
    if (!memoryRoot) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: MEMORY_BLOB_DIR env var not set — " +
        "set it to the LocalFsBlobStore baseDir so mounts can find the on-disk content",
      );
    }
    const hostPath = join(memoryRoot, opts.storeId);
    mkdirSync(hostPath, { recursive: true });
    const guestPath = `/mnt/memory/${opts.storeName}`;
    this.volumes.push({ hostPath, guestPath, readOnly: opts.readOnly });
  }

  async readFile(path: string): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `read-${randomBytes(6).toString("hex")}`);
    try {
      await box.copyOut(this.normalise(path), tmp);
      return await fs.readFile(tmp, "utf8");
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${randomBytes(6).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, content, "utf8");
    try {
      await box.copyIn(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    return target;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${randomBytes(6).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, bytes);
    try {
      await box.copyIn(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    return target;
  }

  async destroy(): Promise<void> {
    if (this.boxPromise) {
      try {
        const box = await this.boxPromise;
        await box.stop();
      } catch (err) {
        this.logger.warn(`destroy stop failed: ${(err as Error).message}`);
      } finally {
        this.boxPromise = null;
      }
    }
    await fs.rm(this.tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pendingCaUpload: { hostPath: string; guestPath: string } | null = null;

  private async ensureBox(): Promise<LiteBoxInstance> {
    if (this.boxPromise) return this.boxPromise;
    this.boxPromise = (async () => {
      type LiteBoxModule = {
        SimpleBox: new (options: {
          image?: string;
          memoryMib?: number;
          cpus?: number;
          name?: string;
          volumes?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
        }) => LiteBoxInstance;
      };
      const mod = (await import(
        /* @vite-ignore */ "@boxlite-ai/boxlite" as string,
      ).catch((err) => {
        throw new Error(
          `LiteBoxSandbox: failed to load '@boxlite-ai/boxlite' — ` +
          `pnpm add @boxlite-ai/boxlite (cause: ${String(err)})`,
        );
      })) as LiteBoxModule;
      this.logger.log(`creating box (image=${this.opts.image ?? "node:22-slim"})`);
      const box = new mod.SimpleBox({
        image: this.opts.image ?? "node:22-slim",
        memoryMib: this.opts.memoryMib,
        cpus: this.opts.cpus,
        name: this.opts.name,
        volumes: this.volumes,
      });
      // Apply pending CA cert upload now that the box exists (a no-op exec
      // forces lazy creation per BoxLite's contract).
      if (this.pendingCaUpload) {
        const { hostPath, guestPath } = this.pendingCaUpload;
        try {
          await box.copyIn(hostPath, guestPath);
        } catch (err) {
          this.logger.warn(
            `vault CA cert upload failed (${(err as Error).message}); ` +
            `outbound TLS through oma-vault will fail with cert errors`,
          );
        }
      }
      return box;
    })();
    return this.boxPromise;
  }

  /**
   * /workspace/foo → /workspace/foo (BoxLite has no opinion on workdir
   * by default; the harness assumes /workspace exists). We don't rewrite
   * paths the way LocalSubprocess does because BoxLite IS isolated, and
   * /workspace is just a regular dir inside the VM's rootfs.
   */
  private normalise(p: string): string {
    if (p.startsWith("/")) return p;
    return `/workspace/${p}`;
  }

  private buildEnv(command: string): Record<string, string> {
    const out: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(out, secrets);
    }
    return out;
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  return new LiteBoxSandbox({
    image: env.SANDBOX_IMAGE,
    memoryMib: env.LITEBOX_MEMORY_MIB ? Number(env.LITEBOX_MEMORY_MIB) : undefined,
    cpus: env.LITEBOX_CPUS ? Number(env.LITEBOX_CPUS) : undefined,
    name: `oma-${ctx.sessionId}`,
  });
};
