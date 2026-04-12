import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@open-managed-agents/shared";
import { getSandbox as cfGetSandbox } from "@cloudflare/sandbox";

export class CloudflareSandbox implements SandboxExecutor {
  private sandboxPromise: Promise<any>;
  private env: Env;
  private sessionId: string;
  private mounted = false;
  private commandSecrets = new Map<string, Record<string, string>>();

  constructor(env: Env, sessionId: string) {
    this.env = env;
    this.sessionId = sessionId;
    try {
      this.sandboxPromise = Promise.resolve(cfGetSandbox(env.SANDBOX! as any, sessionId));
    } catch (err: any) {
      this.sandboxPromise = Promise.reject(
        new Error(`getSandbox failed (SANDBOX: ${typeof env.SANDBOX}, id: ${sessionId}): ${err?.message || err}`)
      );
    }
  }

  private async getSandbox() {
    return this.sandboxPromise;
  }

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

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.getSandbox();
    const timeoutMs = timeout || 120000;

    const execPromise = sandbox.exec(command, {
      timeout: timeoutMs,
      env: this.getSecretsForCommand(command),
    }).then((result: any) => {
      const out = result.stdout || "";
      const err = result.stderr || "";
      return `exit=${result.exitCode}\n${out}${err ? "\nstderr: " + err : ""}`;
    }).catch((err: any) => {
      throw new Error(`exec("${command.slice(0, 80)}") failed: ${err?.message || err}`);
    });

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(
        `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 100)}`
      )), timeoutMs + 10000)
    );

    return Promise.race([execPromise, timeoutPromise]);
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.startProcess !== "function") return null;
    try {
      const proc = await sandbox.startProcess(command, {
        env: this.getSecretsForCommand(command),
      });
      if (!proc?.id) return null;
      return {
        id: proc.id,
        pid: proc.pid,
        kill: (signal: string) => proc.kill(signal),
        getLogs: () => proc.getLogs(),
        getStatus: () => proc.getStatus(),
      };
    } catch {
      return null; // fallback to exec
    }
  }

  async readFile(path: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.readFile(path);
      // Handle both old ({content: string}) and new (string) return format
      return typeof result === "string" ? result : result.content;
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
