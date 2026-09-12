// LocalSubprocessSandbox — Node child_process backed SandboxExecutor.
//
// Per-session workdir under <baseDir>/<sessionId>/. exec spawns
// `/bin/sh -c <cmd>` with cwd=workdir and a timeout watchdog. read/write
// resolve relative paths inside workdir; absolute paths are accepted as-is
// (so the harness's existing /workspace/foo conventions still land
// somewhere — we transparently rewrite /workspace → workdir).
//
// /mnt/memory and /mnt/session/outputs are represented inside the workdir's
// `.mnt/...` tree and exposed through OMA_* environment variables. A caller
// that owns an exclusive mount namespace (for example the main-node
// container) may opt into rootMountBase=/mnt. Root mounts are never created
// implicitly: process-global `/mnt` symlinks are unsafe when local sessions
// run concurrently.
//
// SECURITY: this adapter has zero process isolation. An agent that runs
// `rm -rf /` will hit the host. ONLY use for trusted local development.
// Production / untrusted agents must use E2B / Daytona / LiteBox / BoxRun
// or CloudflareSandbox.

import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxFactory,
} from "../ports";
import { getLogger } from "@open-managed-agents/observability";

const moduleLogger = getLogger("local-sandbox");

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
  /**
   * Absolute path to the directory backing memory blob content. Required
   * to support mountMemoryStore — when set, mountMemoryStore symlinks
   * <workdir>/.mnt/memory/<storeName> → <memoryRoot>/<storeId>/, so reads
   * and writes flow directly to the BlobStore's on-disk layout. When omitted,
   * mountMemoryStore is a hard error (matches CF behaviour without
   * MEMORY_BUCKET).
   */
  memoryRoot?: string;
  /**
   * Absolute path to the directory backing per-session output deliveries
   * (the `/mnt/session/outputs/` magic dir). Required to support
   * mountSessionOutputs — when set, mountSessionOutputs symlinks
   * <workdir>/.mnt/session/outputs → <outputsRoot>/<tenantId>/<sessionId>/.
   * main-node's GET /v1/sessions/:id/outputs reads from the same root.
   * When omitted, mountSessionOutputs is a hard error (matches CF
   * behaviour without FILES_BUCKET).
   */
  outputsRoot?: string;
  /**
   * Explicit root used to expose `/memory/<name>` and `/session/outputs`
   * symlinks to subprocesses. Set this to `/mnt` only when the process owns
   * an exclusive mount namespace. Omitted by default so concurrent local
   * sessions cannot overwrite one another's process-global mounts.
   */
  rootMountBase?: string;
}

interface MemoryMount {
  storeName: string;
  storeId: string;
  readOnly: boolean;
  /** Real path the symlink targets — `<memoryRoot>/<storeId>/`. */
  targetDir: string;
  /** Workdir-relative mount path — `.mnt/memory/<storeName>`. */
  mountRel: string;
}

interface OutputsMount {
  tenantId: string;
  sessionId: string;
  /** Real path the symlink targets — `<outputsRoot>/<tenantId>/<sessionId>/`. */
  targetDir: string;
  /** Workdir-relative mount path — `.mnt/session/outputs`. */
  mountRel: string;
}

export class LocalSubprocessSandbox
  implements SandboxExecutor, SandboxDuplexProcessPort {
  private workdir: string;
  private defaultTimeoutMs: number;
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private processes = new Map<string, BackgroundProcess>();
  private duplexProcesses = new Set<SandboxDuplexProcess>();
  private mounts = new Map<string, MemoryMount>();
  private outputsMount: OutputsMount | null = null;
  private memoryRoot: string | null;
  private outputsRoot: string | null;
  private rootMountBase: string | null;
  private ownedRootSymlinks = new Map<string, string>();
  private logger: NonNullable<LocalSubprocessSandboxOptions["logger"]>;

  constructor(opts: LocalSubprocessSandboxOptions) {
    this.workdir = resolve(opts.workdir);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.memoryRoot = opts.memoryRoot ? resolve(opts.memoryRoot) : null;
    this.outputsRoot = opts.outputsRoot ? resolve(opts.outputsRoot) : null;
    this.rootMountBase = opts.rootMountBase ? resolve(opts.rootMountBase) : null;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
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
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
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

  async spawnDuplexProcess(
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess> {
    const env = this.buildEnv(spec.command);
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = this.resolveProcessEnvValue(value);
    }
    const child: ChildProcessWithoutNullStreams = spawn(
      spec.command,
      spec.args ?? [],
      {
        cwd: spec.cwd ? this.resolvePath(spec.cwd) : this.workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = childExit(child);
    const process: SandboxDuplexProcess = {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
      exited,
      kill: async (signal = "SIGTERM") => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill(signal as NodeJS.Signals);
        if (await childExitedWithin(exited, 2_000)) return;
        if (signal !== "SIGKILL") {
          child.kill("SIGKILL");
          await childExitedWithin(exited, 2_000);
        }
      },
    };
    this.duplexProcesses.add(process);
    void exited.then(() => this.duplexProcesses.delete(process));
    return process;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = {
      ...this.envVars,
      ...Object.fromEntries(Object.entries(envVars).map(([key, value]) =>
        [key, this.resolveProcessEnvValue(value)]
      )),
    };
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string },
  ): Promise<void> {
    const targetDir = this.resolvePath(options.targetDir ?? "/workspace");
    await fs.mkdir(dirname(targetDir), { recursive: true });
    const args = [
      "clone",
      ...(options.branch ? ["--branch", options.branch] : []),
      "--",
      repoUrl,
      targetDir,
    ];
    await new Promise<void>((resolveCheckout, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.workdir,
          env: this.buildEnv("git"),
          timeout: this.defaultTimeoutMs,
        },
        (error) => error ? reject(error) : resolveCheckout(),
      );
    });
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
    // docker-compose.yml (or the operator's env) and shared between
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

  /**
   * Bind a memory store into the sandbox at /mnt/memory/<storeName>.
   *
   * Two-tier mount strategy:
   *   1. Always: workdir-relative `.mnt/memory/<storeName>` symlink to
   *      `<memoryRoot>/<storeId>/`. The path resolver rewrites
   *      `/mnt/memory/<storeName>/...` → `.mnt/memory/<storeName>/...` so
   *      harness read/write/edit/glob/grep tools land directly on the
   *      BlobStore's on-disk layout — no copy, no sync-back.
   *   2. Explicit opt-in: when rootMountBase is configured, create an owned
   *      `<rootMountBase>/memory/<storeName>` symlink. Existing paths are a
   *      collision and fail closed; destroy removes only links created by
   *      this instance while they still target the expected path.
   *
   * read_only enforcement: copy the backing snapshot into a sandbox-owned
   * view and remove write bits recursively. The backing store remains owned
   * by the collector/GC and is never chmod'ed by the sandbox adapter.
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (!this.memoryRoot) {
      throw new Error(
        `LocalSubprocessSandbox.mountMemoryStore: memoryRoot not configured — ` +
        `pass it to the constructor or skip memory mounts`,
      );
    }
    const backingDir = join(this.memoryRoot, opts.storeId);
    mkdirSync(backingDir, { recursive: true });

    let targetDir = backingDir;
    if (opts.readOnly) {
      targetDir = join(
        this.workdir,
        ".openma",
        "read-only-memory",
        opts.storeName,
      );
      makeWritableRecursive(targetDir);
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(dirname(targetDir), { recursive: true });
      cpSync(backingDir, targetDir, { recursive: true, dereference: true });
      makeReadOnlyRecursive(targetDir);
    }

    const mountParent = join(this.workdir, ".mnt", "memory");
    mkdirSync(mountParent, { recursive: true });

    const workdirSymlink = join(mountParent, opts.storeName);
    try {
      rmSync(workdirSymlink, { recursive: true, force: true });
    } catch { /* best-effort */ }
    try {
      symlinkSync(targetDir, workdirSymlink, "dir");
    } catch (err) {
      throw new Error(
        `mountMemoryStore: symlink ${workdirSymlink} → ${targetDir} failed: ` +
        (err as Error).message,
      );
    }

    if (this.rootMountBase) {
      this.createOwnedRootSymlink(
        join(this.rootMountBase, "memory", opts.storeName),
        targetDir,
      );
    }

    this.mounts.set(opts.storeName, {
      storeName: opts.storeName,
      storeId: opts.storeId,
      readOnly: opts.readOnly,
      targetDir,
      mountRel: join(".mnt", "memory", opts.storeName),
    });

    // Expose to bash via env. Setting per-store too in case the agent
    // wants the absolute path without parsing.
    await this.setEnvVars({
      OMA_MEMORY_DIR: mountParent,
      [`OMA_MEMORY_${opts.storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]: workdirSymlink,
    });
  }

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    return this.outputsRoot === null ? null : { durability: "durable" };
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (!this.outputsRoot) {
      throw new Error(
        `LocalSubprocessSandbox.mountSessionOutputs: outputsRoot not configured — ` +
        `pass it to the constructor or skip outputs mounts`,
      );
    }
    const targetDir = join(this.outputsRoot, opts.tenantId, opts.sessionId);
    mkdirSync(targetDir, { recursive: true });

    const mountParent = join(this.workdir, ".mnt", "session");
    mkdirSync(mountParent, { recursive: true });

    const workdirSymlink = join(mountParent, "outputs");
    try {
      rmSync(workdirSymlink, { recursive: true, force: true });
    } catch { /* best-effort */ }
    try {
      symlinkSync(targetDir, workdirSymlink, "dir");
    } catch (err) {
      throw new Error(
        `mountSessionOutputs: symlink ${workdirSymlink} → ${targetDir} failed: ` +
        (err as Error).message,
      );
    }

    if (this.rootMountBase) {
      this.createOwnedRootSymlink(
        join(this.rootMountBase, "session", "outputs"),
        targetDir,
      );
    }

    this.outputsMount = {
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      targetDir,
      mountRel: join(".mnt", "session", "outputs"),
    };

    await this.setEnvVars({ OMA_OUTPUTS_DIR: workdirSymlink });
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolvePath(path), "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolvePath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.assertWritable(path);
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return full;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    this.assertWritable(path);
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
    return full;
  }

  async destroy(): Promise<void> {
    await Promise.all(
      [...this.duplexProcesses].map((proc) =>
        proc.kill("SIGKILL").catch(() => undefined)
      ),
    );
    this.duplexProcesses.clear();
    for (const proc of this.processes.values()) {
      try { await proc.kill("SIGKILL"); } catch { /* best-effort */ }
    }
    this.processes.clear();
    for (const mount of this.mounts.values()) {
      if (mount.readOnly) makeWritableRecursive(mount.targetDir);
    }
    this.removeOwnedRootSymlinks();
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
   *
   * /mnt/memory and /mnt/session/outputs paths always resolve to the
   * workdir-relative `.mnt/...` view for harness tools. Subprocesses use the
   * OMA_* environment variables, or an explicitly configured root mount.
   */
  private resolvePath(p: string): string {
    let normalised = p;
    // Memory mount: /mnt/memory/<storeName>/<rest> → <workdir>/.mnt/memory/...
    if (normalised.startsWith("/mnt/memory/") || normalised === "/mnt/memory") {
      normalised = normalised === "/mnt/memory"
        ? ".mnt/memory"
        : ".mnt/memory/" + normalised.slice("/mnt/memory/".length);
    } else if (
      normalised.startsWith("/mnt/session/outputs/") ||
      normalised === "/mnt/session/outputs"
    ) {
      normalised = normalised === "/mnt/session/outputs"
        ? ".mnt/session/outputs"
        : ".mnt/session/outputs/" + normalised.slice("/mnt/session/outputs/".length);
    } else if (normalised.startsWith("/workspace/")) normalised = normalised.slice("/workspace/".length);
    else if (normalised === "/workspace") normalised = "";
    else if (normalised.startsWith("/")) normalised = normalised.slice(1);
    if (isAbsolute(normalised)) return normalised; // explicit absolute escape — caller's responsibility
    return join(this.workdir, normalised);
  }

  /**
   * A local subprocess sees host paths, while every real sandbox sees the
   * logical `/workspace` mount. Translate only an entire logical workspace
   * path (not arbitrary strings containing that word) so agent-specific home
   * variables such as CODEX_HOME and CLAUDE_CONFIG_DIR behave identically in
   * local conformance tests.
   */
  private resolveProcessEnvValue(value: string): string {
    return value === "/workspace" || value.startsWith("/workspace/")
      ? this.resolvePath(value)
      : value;
  }

  private createOwnedRootSymlink(linkPath: string, targetDir: string): void {
    const expectedTarget = resolve(targetDir);
    const previouslyOwned = this.ownedRootSymlinks.get(linkPath);
    if (previouslyOwned) this.removeOwnedRootSymlink(linkPath, previouslyOwned);

    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      lstatSync(linkPath);
      throw new Error(
        `root mount collision at ${linkPath}; refusing to replace an existing path`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    symlinkSync(expectedTarget, linkPath, "dir");
    this.ownedRootSymlinks.set(linkPath, expectedTarget);
  }

  private removeOwnedRootSymlinks(): void {
    for (const [linkPath, expectedTarget] of this.ownedRootSymlinks) {
      this.removeOwnedRootSymlink(linkPath, expectedTarget);
    }
    this.ownedRootSymlinks.clear();
  }

  private removeOwnedRootSymlink(linkPath: string, expectedTarget: string): void {
    try {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return;
      const actualTarget = resolve(dirname(linkPath), readlinkSync(linkPath));
      if (actualTarget !== expectedTarget) return;
      unlinkSync(linkPath);
      this.ownedRootSymlinks.delete(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.ownedRootSymlinks.delete(linkPath);
        return;
      }
      this.logger.warn(`failed to remove owned root mount ${linkPath}`, err);
    }
  }

  /**
   * Throw if `p` resolves into a read-only memory mount and `mode` is "write".
   * Read/write tools call this so the agent gets a clear error rather than a
   * silent successful write that gets blown away on the next mount.
   */
  private assertWritable(p: string): void {
    if (!p.startsWith("/mnt/memory/")) return;
    const rest = p.slice("/mnt/memory/".length);
    const slash = rest.indexOf("/");
    const storeName = slash === -1 ? rest : rest.slice(0, slash);
    const mount = this.mounts.get(storeName);
    if (mount?.readOnly) {
      throw new Error(
        `EACCES: memory store ${storeName} mounted read-only at /mnt/memory/${storeName}/`,
      );
    }
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

function makeReadOnlyRecursive(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) {
      makeReadOnlyRecursive(join(path, entry));
    }
    chmodSync(path, 0o555);
    return;
  }
  if (info.isFile()) chmodSync(path, 0o444);
}

function makeWritableRecursive(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) {
      makeWritableRecursive(join(path, entry));
    }
    return;
  }
  if (info.isFile()) chmodSync(path, 0o644);
}

function childExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    };
    child.once("exit", settle);
    child.once("close", settle);
    child.once("error", () => settle(null, null));
  });
}

async function childExitedWithin(
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    child.stdout?.on("data", (b: Buffer) => { this.stdout += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { this.stderr += b.toString(); });
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

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx) => {
  return new LocalSubprocessSandbox({
    workdir: ctx.workdir,
    memoryRoot: ctx.memoryRoot,
    outputsRoot: ctx.outputsRoot,
  });
};
