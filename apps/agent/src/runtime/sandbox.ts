import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@open-managed-agents/shared";
// Static import so vitest's resolve.alias can stub it out.
// Dynamic import("@cloudflare/sandbox") doesn't get aliased in vitest-pool-workers,
// causing it to load the real module which depends on @cloudflare/containers native code.
import { getSandbox as cfGetSandbox } from "@cloudflare/sandbox";

export class CloudflareSandbox implements SandboxExecutor {
  private sandboxPromise: Promise<any>;
  private env: Env;
  private sessionId: string;
  private mounted = false;
  // Per-command secrets: injected as env vars only for matching commands
  private commandSecrets = new Map<string, Record<string, string>>();

  constructor(env: Env, sessionId: string) {
    this.env = env;
    this.sessionId = sessionId;
    try {
      this.sandboxPromise = Promise.resolve(cfGetSandbox(env.SANDBOX! as any, sessionId));
    } catch (err: any) {
      this.sandboxPromise = Promise.reject(
        new Error(`getSandbox failed (SANDBOX binding: ${typeof env.SANDBOX}, sessionId: ${sessionId}): ${err?.stack || err?.message || err}`)
      );
    }
  }

  private async getSandbox() {
    return this.sandboxPromise;
  }

  /**
   * Mount R2 bucket at /workspace for persistent file storage.
   */
  async mountWorkspace(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    const sandbox = await this.getSandbox();
    try {
      if (this.env.WORKSPACE_BUCKET) {
        await sandbox.mountBucket("managed-agents-workspace", "/workspace", {
          localBucket: true,
        });
      }
    } catch {
      // Mount failed — fall back to ephemeral container disk.
    }
  }

  /**
   * Blocking exec with Promise.race safety net.
   * Used by read/write/glob/grep/web_fetch tools.
   * No strategy logic — just run and return.
   */
  async exec(command: string, timeout?: number): Promise<string> {
    let sandbox: any;
    try {
      sandbox = await this.getSandbox();
    } catch (err: any) {
      throw new Error(`Sandbox init failed (env.SANDBOX=${typeof this.env.SANDBOX}): ${err?.message || err}`);
    }
    const timeoutMs = timeout || 120000;

    const execPromise = sandbox.exec(command, {
      timeout: timeoutMs,
      env: this.getSecretsForCommand(command),
    }).then((result: any) => {
      let out = result.stdout || "";
      if (result.stderr) out += (out ? "\n" : "") + "stderr: " + result.stderr;
      return `exit=${result.exitCode}\n${out}`;
    }).catch((err: any) => {
      throw new Error(`sandbox.exec("${command.slice(0, 60)}") failed: ${err?.stack || err?.message || err}`);
    });

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(
        `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 100)}`
      )), timeoutMs + 10000)
    );

    return Promise.race([execPromise, timeoutPromise]);
  }

  /**
   * Start a process without blocking. Returns a ProcessHandle for
   * kill/status/logs — the bash tool uses this for the 3-strategy lifecycle.
   * Returns null if the container doesn't support startProcess.
   */
  async startProcess(command: string): Promise<ProcessHandle | null> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.startProcess !== "function") return null;
    const proc = await sandbox.startProcess(command, {
      env: this.getSecretsForCommand(command),
    });
    return {
      id: proc.id,
      pid: proc.pid,
      kill: (signal: string) => proc.kill(signal),
      getLogs: () => proc.getLogs(),
      getStatus: () => proc.getStatus(),
    };
  }

  async readFile(path: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.readFile(path);
      return result.content;
    } catch (err: any) {
      throw new Error(`readFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      await sandbox.writeFile(path, content);
      return "ok";
    } catch (err: any) {
      throw new Error(`writeFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.setEnvVars(envVars);
  }

  /**
   * Register secrets that are only injected for commands matching certain prefixes.
   * e.g. registerCommandSecrets("git", { GITHUB_TOKEN: "ghp_xxx", GH_TOKEN: "ghp_xxx" })
   * Only `git ...` and `gh ...` commands see the token. `echo $GITHUB_TOKEN` sees nothing.
   */
  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.set(commandPrefix, secrets);
  }

  private getSecretsForCommand(command: string): Record<string, string> | undefined {
    const trimmed = command.trim();
    for (const [prefix, secrets] of this.commandSecrets) {
      if (trimmed.startsWith(prefix)) return secrets;
    }
    return undefined;
  }

  async gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown> {
    const sandbox = await this.getSandbox();
    return sandbox.gitCheckout(repoUrl, options);
  }
}

/**
 * Test-only sandbox. Used by vitest — not in production builds.
 */
export class TestSandbox implements SandboxExecutor {
  async exec(command: string): Promise<string> {
    return `exit=0\n(test: ${command})`;
  }
  async readFile(path: string): Promise<string> {
    return `(test: file ${path})`;
  }
  async writeFile(_path: string, _content: string): Promise<string> {
    return "ok";
  }
}

export function createSandbox(env: Env, sessionId: string): SandboxExecutor {
  return new CloudflareSandbox(env, sessionId);
}
