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

  /**
   * @deprecated /workspace persistence is now via createBackup/restoreBackup
   * (see restoreWorkspaceBackup + createWorkspaceBackup below). This is kept
   * as a no-op so callers that call mountWorkspace() during warmup don't
   * break, but it does NOT mount R2 anymore.
   *
   * Why dropped:
   *   - `localBucket: true` silently fails to push writes back in real CF
   *     (only works in `wrangler dev`). Workspace was effectively ephemeral.
   *   - FUSE/s3fs mode would make every `/workspace/...` write a synchronous
   *     R2 PUT (~100-500ms per write), unacceptable for typical agent flows
   *     (compile, build, scratch files).
   *   - Cloudflare's recommended pattern for "fast workspace + persist
   *     across sessions" is createBackup at session end + restoreBackup at
   *     session warmup. See changelog 2026-02-23.
   */
  async mountWorkspace(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    // Intentionally no-op. /workspace is plain container disk now.
    // Persistence is wired in session-do.ts via restoreWorkspaceBackup
    // (warmup) and createWorkspaceBackup (destroy).
  }

  /**
   * Snapshot /workspace into R2 via squashfs. Returns a handle the caller
   * persists in D1 (workspace_backups table). Best-effort: failure is
   * logged but does not raise — losing a backup is recoverable (worst
   * case: next session starts from empty workspace).
   */
  async createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null> {
    const sandbox = await this.getSandbox();
    // Detect dev mode: in wrangler dev there are no R2 S3 keys (no
    // presigned URLs available), so the SDK requires localBucket: true
    // which uses BACKUP_BUCKET binding directly. In prod we omit it and
    // the SDK uses presigned URLs.
    const isDev = !this.env.R2_ENDPOINT || !this.env.R2_ACCESS_KEY_ID;
    // Don't catch — let caller surface the SDK error in trajectory.
    // Earlier swallowed errors made silent backup failures look identical
    // to "no backup needed" from the perspective of the next session.
    const backup = await sandbox.createBackup({
      dir: "/workspace",
      name: opts.name,
      ttl: opts.ttlSec,
      // Skip the obvious bloat. node_modules can be 100s of MB and is
      // re-installable. Same for build caches.
      excludes: ["node_modules", ".cache", "__pycache__", ".next", "target"],
      // If /workspace is a git repo, respect .gitignore — it covers
      // build artifacts the project itself declared as expendable.
      gitignore: true,
      ...(isDev ? { localBucket: true } : {}),
    });
    return {
      id: backup.id,
      dir: backup.dir,
      localBucket: backup.localBucket,
    };
  }

  /**
   * Restore a previously created backup into /workspace. Returns
   * `{ ok: true }` on success, `{ ok: false, error: <message> }` on
   * failure. Best-effort: failure is logged AND surfaced to the caller
   * so observability can capture the underlying reason (expired squashfs,
   * R2 fetch error, container restoreArchive non-success, etc.).
   *
   * Earlier shape (`Promise<boolean>`) only returned a bare boolean which
   * meant a silently-failing restore looked identical to "no backup
   * existed" — diagnosed during 2026-05-02 TB pilot when hello-world
   * file vanished post-recycle but no error surfaced.
   */
  async restoreWorkspaceBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const sandbox = await this.getSandbox();
      await sandbox.restoreBackup(handle);
      return { ok: true };
    } catch (err) {
      // Common: backup expired (BACKUP_EXPIRED), R2 lifecycle deleted the
      // squashfs, container's restoreArchive failed, etc. Either way, fall
      // through to empty workspace — agent can re-clone / re-install as
      // if it's a fresh session. Surface the message so callers can log.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sandbox] restoreWorkspaceBackup failed: ${msg}`,
      );
      return { ok: false, error: msg.slice(0, 500) };
    }
  }

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<store_name>/.
   * Uses sandbox.mountBucket with prefix scoping so the agent only sees this
   * store's keys (`<store_id>/...`) under the mount, regardless of what other
   * tenants have in MEMORY_BUCKET.
   *
   * Anthropic Managed Agents Memory contract: the agent reads/writes via
   * standard file tools — no bespoke memory_* tools (those were removed).
   *
   * Mode selection:
   *   - Production (FUSE / s3fs): used when R2_ENDPOINT + R2_ACCESS_KEY_ID
   *     + R2_SECRET_ACCESS_KEY are all bound. Writes flow synchronously
   *     over the S3 API and trigger R2 Event Notifications → CF Queue →
   *     consumer → D1 audit. This is the contract the rest of the memory
   *     subsystem assumes.
   *   - wrangler dev (`localBucket: true`): R2 binding-sync. Reads work,
   *     writes do NOT persist to R2 in real CF — only used here as a dev
   *     fallback so `pnpm wrangler dev` keeps working without R2 keys.
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

    const fuse = this.fuseR2ConfigOrNull();
    const bucketName = this.env.MEMORY_BUCKET_NAME;

    if (fuse && bucketName) {
      await sandbox.mountBucket(bucketName, mountPath, {
        endpoint: fuse.endpoint,
        provider: "r2",
        credentials: fuse.credentials,
        prefix,
        readOnly: opts.readOnly,
      });
    } else {
      // Dev fallback. In production this branch means agent writes won't
      // persist — log loudly so the operator catches the misconfig.
      console.warn(
        "[sandbox] mountMemoryStore: R2 FUSE creds missing (R2_ENDPOINT / " +
        "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / MEMORY_BUCKET_NAME) — " +
        "falling back to localBucket mode. Agent writes to /mnt/memory/ will " +
        "NOT persist to R2 in real CF; this is dev-only behavior.",
      );
      await sandbox.mountBucket("MEMORY_BUCKET", mountPath, {
        localBucket: true,
        prefix,
        readOnly: opts.readOnly,
      });
    }
  }

  /**
   * Returns the R2 S3 credentials block if all three FUSE env vars are
   * present, else null (dev fallback). Centralized so memory + workspace
   * share the same gating.
   */
  private fuseR2ConfigOrNull(): {
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  } | null {
    const endpoint = this.env.R2_ENDPOINT;
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) return null;
    return { endpoint, credentials: { accessKeyId, secretAccessKey } };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.getSandbox();
    const timeoutMs = timeout || 120000;
    const injectedSecrets = this.getSecretsForCommand(command);
    try {
      const execPromise = sandbox.exec(command, {
        timeout: timeoutMs,
        env: injectedSecrets,
      }).then((result: { stdout?: string; stderr?: string; exitCode?: number }) => {
        const out = result.stdout || "";
        const err = result.stderr || "";
        const combined = `exit=${result.exitCode}\n${out}${err ? "\nstderr: " + err : ""}`;
        return this.appendSecretRetryHint(command, combined, injectedSecrets);
      });
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(
          `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 100)}`,
        )), timeoutMs + 10000),
      );
      return await Promise.race([execPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`exec("${command.slice(0, 80)}") failed: ${msg}`);
    }
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
   * session's identifying context (tenantId, sessionId). The handler runs
   * in the agent worker scope; on every outbound HTTPS request the
   * sandbox makes, it RPCs to main with these identifiers, main does the
   * vault lookup live, injects the bearer, and forwards. The agent
   * worker's address space never holds plaintext vault credentials —
   * mirrors Anthropic Managed Agents' "credential proxy outside the
   * harness" pattern (see apps/agent/src/oma-sandbox.ts file header).
   */
  async setOutboundContext(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (!opts.tenantId || !opts.sessionId) return;
    try {
      const sandbox = await this.getSandbox();
      const hasFn = typeof sandbox.setOutboundHandler === "function";
      console.log(
        `[sandbox] setOutboundContext tenant=${opts.tenantId.slice(0, 8)} sid=${opts.sessionId.slice(0, 12)} hasFn=${hasFn}`,
      );
      if (!hasFn) return;
      await sandbox.setOutboundHandler("inject_vault_creds", {
        tenantId: opts.tenantId,
        sessionId: opts.sessionId,
      });
      console.log(`[sandbox] setOutboundHandler bound (RPC mode)`);
    } catch (err) {
      console.error(
        `[sandbox] setOutboundContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }


  async destroy(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.destroy === "function") await sandbox.destroy();
    } catch {}
  }

  /**
   * Reset the CF Container's sleepAfter inactivity timer. Called by SessionDO
   * while there are background_tasks rows so the container doesn't get
   * SIGTERM'd out from under a long-running `python script.py &` that the
   * agent is waiting on. The underlying SDK method is on the Container base
   * class — fail-soft if missing in case of SDK version drift.
   */
  async renewActivityTimeout(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.renewActivityTimeout === "function") {
        await sandbox.renewActivityTimeout();
      }
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
