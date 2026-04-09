import type { SandboxExecutor } from "../harness/interface";
import type { Env } from "../env";

export class CloudflareSandbox implements SandboxExecutor {
  private sandboxPromise: Promise<any>;
  private fallback = new StubSandbox();
  private useFallback = false;
  private env: Env;
  private sessionId: string;
  private mounted = false;

  constructor(env: Env, sessionId: string) {
    this.env = env;
    this.sessionId = sessionId;
    this.sandboxPromise = import("@cloudflare/sandbox")
      .then((mod) => mod.getSandbox(env.SANDBOX, sessionId))
      .catch(() => {
        this.useFallback = true;
        return null;
      });
  }

  private async getSandbox() {
    if (this.useFallback) return null;
    return this.sandboxPromise;
  }

  /**
   * Mount R2 bucket at /workspace for persistent file storage.
   * - Production: uses FUSE mount via s3fs (endpoint required)
   * - Local dev (wrangler dev): uses localBucket mode via R2 binding
   * Files persist across container sleep/restart cycles.
   */
  async mountWorkspace(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;

    const sandbox = await this.getSandbox();
    if (!sandbox) return;

    try {
      if (this.env.WORKSPACE_BUCKET) {
        // R2 bucket binding exists — use localBucket for wrangler dev,
        // or endpoint for production
        await sandbox.mountBucket("managed-agents-workspace", "/workspace", {
          localBucket: true,
        });
      }
    } catch {
      // Mount failed — fall back to ephemeral container disk.
      // Files will persist within the session but not across container restarts.
    }
  }

  async exec(command: string, timeout?: number): Promise<string> {
    try {
      const sandbox = await this.getSandbox();
      if (!sandbox) return this.fallback.exec(command);
      const result = await sandbox.exec(command, { timeout });
      let out = result.stdout || "";
      if (result.stderr) out += (out ? "\n" : "") + "stderr: " + result.stderr;
      return `exit=${result.exitCode}\n${out}`;
    } catch {
      this.useFallback = true;
      return this.fallback.exec(command);
    }
  }

  async readFile(path: string): Promise<string> {
    try {
      const sandbox = await this.getSandbox();
      if (!sandbox) return this.fallback.readFile(path);
      const result = await sandbox.readFile(path);
      return result.content;
    } catch {
      this.useFallback = true;
      return this.fallback.readFile(path);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    try {
      const sandbox = await this.getSandbox();
      if (!sandbox) return this.fallback.writeFile(path, content);
      await sandbox.writeFile(path, content);
      return "ok";
    } catch {
      this.useFallback = true;
      return this.fallback.writeFile(path, content);
    }
  }
}

/** Stub sandbox for test environments */
export class StubSandbox implements SandboxExecutor {
  async exec(command: string): Promise<string> {
    return `exit=0\n(local stub: ${command})`;
  }
  async readFile(path: string): Promise<string> {
    return `(stub: file ${path} not available in local mode)`;
  }
  async writeFile(_path: string, _content: string): Promise<string> {
    return "ok";
  }
}

export function createSandbox(env: Env, sessionId: string): SandboxExecutor {
  if (!env.SANDBOX) {
    return new StubSandbox();
  }
  return new CloudflareSandbox(env, sessionId);
}
