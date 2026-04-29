import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@open-managed-agents/shared";
import { getSandbox as cfGetSandbox } from "@cloudflare/sandbox";
// `bash-parser` is CJS; the bundler handles interop for worker builds.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import parseShell from "bash-parser";

const parseShellCommand = parseShell as (command: string) => {
  type: string;
  commands?: Array<Record<string, any>>;
};

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

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<store_name>/.
   * Uses sandbox.mountBucket with prefix scoping so the agent only sees this
   * store's keys (`<store_id>/...`) under the mount, regardless of what other
   * tenants have in MEMORY_BUCKET.
   *
   * The Anthropic Managed Agents Memory contract uses standard file tools
   * over /mnt/memory/<store>/ — we deliberately do NOT register memory_*
   * tools (those were removed in this migration).
   *
   * Local dev (`wrangler dev`): R2 binding sync via `localBucket: true`.
   * Production (CF): S3FS-FUSE — should be wired by the sandbox SDK using
   * the same binding name when running outside the local simulator.
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (!this.env.MEMORY_BUCKET) {
      throw new Error(
        `MEMORY_BUCKET binding missing — cannot mount memory store ${opts.storeName}`,
      );
    }
    const sandbox = await this.getSandbox();
    const mountPath = `/mnt/memory/${opts.storeName}`;
    // Trailing slash on the prefix ensures we don't accidentally match
    // sibling prefixes (e.g. "abc/" vs "abcd/...").
    const prefix = `/${opts.storeId}/`;
    await sandbox.mountBucket("managed-agents-memory", mountPath, {
      localBucket: true,
      prefix,
      readOnly: opts.readOnly,
    });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.getSandbox();
    const timeoutMs = timeout || 120000;
    const injectedSecrets = this.getSecretsForCommand(command);

    const execPromise = sandbox.exec(command, {
      timeout: timeoutMs,
      env: injectedSecrets,
    }).then((result: any) => {
      const out = result.stdout || "";
      const err = result.stderr || "";
      const combined = `exit=${result.exitCode}\n${out}${err ? "\nstderr: " + err : ""}`;
      return this.appendSecretRetryHint(command, combined, injectedSecrets);
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
      const result = await sandbox.readFile(path, { encoding: "utf-8" });
      // Handle both string and {content: string} return formats
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

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const sandbox = await this.getSandbox();
    // Encode to base64 client-side and ask the sandbox to decode. Avoids any
    // UTF-8 reinterpretation of the bytes in flight. The SDK's encoding hint
    // tells the sandbox how to interpret the string we send.
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const b64 = btoa(bin);
    try {
      await sandbox.writeFile(path, b64, { encoding: "base64" });
      return "ok";
    } catch (err: any) {
      throw new Error(`writeFileBytes(${path}) failed: ${err?.message || err}`);
    }
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.setEnvVars(envVars);
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.set(commandPrefix, secrets);
  }

  /**
   * Bind the OmaSandbox `inject_vault_creds` outbound handler with the
   * session's vault credentials. After this call, any HTTPS request the
   * container makes whose hostname matches a credential's `mcp_server_url`
   * gets a Bearer header injected before being forwarded upstream.
   * The credentials never leave the Workers runtime.
   */
  async setVaultCredentialsForOutbound(
    vault_credentials: Array<{ vault_id: string; credentials: unknown[] }>,
  ): Promise<void> {
    if (!vault_credentials.length) return;
    try {
      const sandbox = await this.getSandbox();
      const hasFn = typeof sandbox.setOutboundHandler === "function";
      console.log(`[sandbox] setVaultCredentialsForOutbound vaults=${vault_credentials.length} hasFn=${hasFn}`);
      if (!hasFn) return;
      await sandbox.setOutboundHandler("inject_vault_creds", { vault_credentials });
      console.log(`[sandbox] setOutboundHandler bound`);
    } catch (err) {
      console.error(`[sandbox] setVaultCredentialsForOutbound failed: ${(err as Error).message ?? err}`);
    }
  }


  async destroy(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.destroy === "function") await sandbox.destroy();
    } catch {}
  }

  private getSecretsForCommand(command: string): Record<string, string> | undefined {
    const commandName = this.getSimpleCommandName(command);
    if (!commandName) return undefined;
    for (const [prefix, secrets] of this.commandSecrets) {
      if (commandName === prefix) return secrets;
    }
    return undefined;
  }


  private getSimpleCommandName(command: string): string | undefined {
    try {
      const ast = parseShellCommand(command);
      if (ast?.type !== "Script" || !Array.isArray(ast.commands) || ast.commands.length !== 1) return undefined;
      const [node] = ast.commands;
      if (node?.type !== "Command") return undefined;
      if (!node.name || typeof node.name.text !== "string" || !node.name.text) return undefined;
      if (Array.isArray(node.suffix) && node.suffix.some((part: any) => part?.type === "Redirect")) return undefined;
      if (Array.isArray(node.prefix) && node.prefix.some((part: any) => part?.type === "Redirect")) return undefined;
      return node.name.text;
    } catch {
      return undefined;
    }
  }

  private appendSecretRetryHint(
    command: string,
    result: string,
    injectedSecrets?: Record<string, string>,
  ): string {
    if (injectedSecrets) return result;
    const exitMatch = result.match(/^exit=(\d+)/);
    if (!exitMatch || exitMatch[1] === "0") return result;
    if (!this.isCompositeCommand(command)) return result;

    const matchedPrefix = this.findSecretBackedCommandPrefix(command);
    if (!matchedPrefix) return result;

    return `${result}\n\nHint: This chained shell command includes a secret-backed command (\`${matchedPrefix}\`) and failed. Retry with a single authenticated command when possible.`;
  }

  private isCompositeCommand(command: string): boolean {
    return /&&|\|\||;|\||\n/.test(command);
  }

  private findSecretBackedCommandPrefix(command: string): string | undefined {
    const atoms = command
      .split(/&&|\|\||;|\||\n/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const atom of atoms) {
      const commandName = this.getSimpleCommandName(atom);
      if (!commandName) continue;
      for (const prefix of this.commandSecrets.keys()) {
        if (commandName === prefix) return prefix;
      }
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
  async writeFileBytes(_path: string, _bytes: Uint8Array): Promise<string> {
    return "ok";
  }
}

export function createSandbox(env: Env, sessionId: string): SandboxExecutor {
  return new CloudflareSandbox(env, sessionId);
}
