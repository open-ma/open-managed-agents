// E2B (e2b.dev) implementation of SandboxExecutor.
//
// Lazy-imports the `e2b` SDK so this package compiles without it. The
// driver dep lives in your deployment's package.json:
//   pnpm add e2b -w   # or wherever you build the Node entry
//
// Production path for CFless: each session becomes a Firecracker microVM
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

import type { ProcessHandle, SandboxExecutor } from "../ports";

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
   */
  templateId?: string;
  /** Default per-command timeout in ms. */
  defaultTimeoutMs?: number;
  /** Logger for debug output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void };
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

  constructor(
    private sandbox: E2BSandboxLike,
    opts: E2BSandboxOptions,
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[e2b-sandbox] ${msg}`, ctx ?? ""),
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

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(): Promise<void> {
    // E2B doesn't expose container outbound interception. Vault credential
    // injection happens at the application layer (HTTP_PROXY env var
    // pointing at main-node's /v1/proxy/outbound).
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.sandbox.files.write(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.sandbox.files.write(path, bytes);
    return path;
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
