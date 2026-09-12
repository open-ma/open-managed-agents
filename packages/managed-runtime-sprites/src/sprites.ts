import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import {
  createProviderManagedRuntime,
  type ProviderManagedRuntimeAcquisitionContext,
  type ProviderManagedRuntimeOptions,
  type ProviderManagedRuntimeProviderPort,
} from "@open-managed-agents/managed-runtime-sandbox";
import type {
  ManagedRuntimeProviderDriverPort,
  RuntimeResourceScope,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxFactory,
  SandboxMemoryWorkspacePort,
  SandboxPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";

const providerName = "sprites";
const keepAliveTaskName = "openma-runtime";
const processLockPath = "/run/openma-managed-agent.lock";

export interface SpriteExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
  exitCode: number;
}

export interface SpriteFilesystemPort {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
}

export interface SpriteCommandPort {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  start(): Promise<void>;
  once(event: "spawn" | "error", listener: (...args: unknown[]) => void): this;
  wait(): Promise<number>;
  kill(signal?: string): void;
  close(): void;
}

export interface SpriteSdkPort {
  readonly name: string;
  readonly id?: string;
  status?: string;
  labels: string[];
  filesystem(workingDir?: string): SpriteFilesystemPort;
  execFileHTTP(
    file: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      input?: string | Buffer;
      signal?: AbortSignal;
      timeout?: number;
    },
  ): Promise<SpriteExecResult>;
  spawn(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      tty?: boolean;
      maxRunAfterDisconnect?: string;
    },
  ): SpriteCommandPort;
  check(): Promise<{ status: string; reason?: string }>;
  updateNetworkPolicy(policy: SpritesNetworkPolicy): Promise<void>;
  closeControlConnection(): void;
  delete(): Promise<void>;
}

export interface SpritesCreateOptions {
  config?: { ramMB?: number; cpus?: number; region?: string; storageGB?: number };
  environment?: Record<string, string>;
  urlSettings?: { auth?: string; privateAccess?: "admins" | "org_users" };
  labels?: string[];
  waitForCapacity?: boolean;
  runtime?: "default" | "dev";
}

export interface SpritesNetworkPolicy {
  rules: Array<{
    domain?: string;
    action?: "allow" | "deny";
    include?: string;
  }>;
}

export interface SpritesClientPort {
  getSprite(name: string): Promise<SpriteSdkPort>;
  createSprite(name: string, options?: SpritesCreateOptions): Promise<SpriteSdkPort>;
  deleteSprite(name: string): Promise<void>;
}

type SafeCreateOptions = Omit<SpritesCreateOptions, "labels">;

export interface SpritesProviderOptions {
  client?: SpritesClientPort;
  token?: string;
  baseURL?: string;
  timeoutMs?: number;
  lifecycleRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
  };
  memoryWorkspace?: SandboxMemoryWorkspacePort;
  createOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
    ownershipLabels: string[];
  }): Promise<SafeCreateOptions> | SafeCreateOptions;
  networkPolicy?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SpritesNetworkPolicy | null> | SpritesNetworkPolicy | null;
}

function isTransientProviderError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const status = "statusCode" in error
      ? error.statusCode
      : "status" in error
        ? error.status
        : undefined;
    if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /network error|fetch failed|timed? ?out|econnreset|etimedout|ehostunreach|socket hang up/i.test(message);
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else setTimeout(() => signal.removeEventListener("abort", onAbort), milliseconds);
  });
}

async function retryLifecycle<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  options: SpritesProviderOptions["lifecycleRetry"],
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("Sprites lifecycle retry maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("Sprites lifecycle retry baseDelayMs must be non-negative");
  }
  const wait = options?.wait ?? waitForRetry;
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientProviderError(error)) throw error;
      await wait(Math.min(2_000, baseDelayMs * 2 ** (attempt - 1)), signal);
    }
  }
}

export interface SpritesManagedRuntimeOptions extends SpritesProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<SpritesRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<SpritesRuntime>["readiness"];
}

interface SpritesModulePort {
  SpritesClient: new (
    token: string,
    options?: { baseURL?: string; timeout?: number; controlMode?: boolean },
  ) => SpritesClientPort;
}

async function loadClient(options: SpritesProviderOptions): Promise<SpritesClientPort> {
  if (options.client !== undefined) return options.client;
  const token = options.token ?? process.env.SPRITES_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("Sprites managed runtime requires token or SPRITES_TOKEN");
  }
  let module: SpritesModulePort;
  try {
    module = await import(/* @vite-ignore */ "@fly/sprites" as string) as unknown as SpritesModulePort;
  } catch (error) {
    throw new Error(`Sprites managed runtime requires '@fly/sprites': ${String(error)}`);
  }
  return new module.SpritesClient(token, {
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    controlMode: true,
  });
}

type ClientResolver = () => Promise<SpritesClientPort>;

function createClientResolver(options: SpritesProviderOptions): ClientResolver {
  let promise: Promise<SpritesClientPort> | undefined;
  return () => promise ??= loadClient(options);
}

function stableName(sessionId: string): string {
  return `oma-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

function labelHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function ownershipLabels(environmentId: string, sessionId: string): string[] {
  return [
    "openma-managed",
    `openma-env-${labelHash(environmentId)}`,
    `openma-session-${labelHash(sessionId)}`,
  ];
}

function writableToWeb(stream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        stream.write(Buffer.from(chunk), (error) => error === null || error === undefined
          ? resolve()
          : reject(error));
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        stream.once("error", onError);
        stream.end(() => {
          stream.off("error", onError);
          resolve();
        });
      });
    },
    abort(reason) {
      stream.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });
}

function readableToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        controller.enqueue(new Uint8Array(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      };
      const onEnd = () => controller.close();
      const onError = (error: Error) => controller.error(error);
      stream.on("data", onData);
      stream.once("end", onEnd);
      stream.once("error", onError);
    },
    cancel(reason) {
      stream.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });
}

function validateSprite(
  sprite: SpriteSdkPort,
  name: string,
  environmentId: string,
  sessionId: string,
): void {
  const required = ownershipLabels(environmentId, sessionId);
  if (sprite.name !== name || required.some((label) => !sprite.labels.includes(label))) {
    throw new Error(
      `Refusing to attach Sprite ${sprite.name}: ownership labels do not match the requested environment and Session`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if ("statusCode" in error && error.statusCode === 404) return true;
    if ("status" in error && error.status === 404) return true;
  }
  return error instanceof Error && /not[ -]?found/i.test(error.message);
}

function isConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if ("statusCode" in error && error.statusCode === 409) return true;
    if ("status" in error && error.status === 409) return true;
  }
  return error instanceof Error && /already exists|conflict/i.test(error.message);
}

async function ensureReady(sprite: SpriteSdkPort, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const result = await sprite.execFileHTTP("/bin/mkdir", ["-p", "/workspace"], {
    cwd: "/",
    signal,
    timeout: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Sprite readiness probe failed: ${String(result.stderr)}`);
  }
  signal.throwIfAborted();
}

export class SpritesRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #client: SpritesClientPort;
  readonly #sprite: SpriteSdkPort;
  readonly #memoryWorkspace?: SandboxMemoryWorkspacePort;
  readonly #memoryMounts = new Map<string, { storeId: string; readOnly: boolean }>();
  readonly #commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  #environment: Record<string, string> = {};
  #destroyed = false;

  readonly mountMemoryStore?: (input: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }) => Promise<void>;

  readonly synchronizeMemoryStores?: () => Promise<void>;

  constructor(input: {
    client: SpritesClientPort;
    sprite: SpriteSdkPort;
    memoryWorkspace?: SandboxMemoryWorkspacePort;
  }) {
    this.#client = input.client;
    this.#sprite = input.sprite;
    this.#memoryWorkspace = input.memoryWorkspace;
    if (input.memoryWorkspace !== undefined) {
      this.mountMemoryStore = (mount) => this.#mountMemoryStore(mount);
      this.synchronizeMemoryStores = () => this.#synchronizeMemoryStores();
    }
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sprite.name };
  }

  runtimeCapabilities() {
    return { lease: true, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    try {
      const state = (await this.#sprite.check()).status.toLowerCase();
      if (["destroyed", "deleted", "failed", "stopped"].includes(state)) return "stopped";
      if (["running", "warm", "cold", "created"].includes(state)) return "running";
      return "unknown";
    } catch (error) {
      return isNotFound(error) ? "stopped" : "unknown";
    }
  }

  async renewLease(input: { ttlMs: number }): Promise<void> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new RangeError("Sprite keep-alive TTL must be positive");
    }
    const expireSeconds = Math.min(3_600, Math.max(1, Math.ceil(input.ttlMs / 1_000)));
    const result = await this.#sprite.execFileHTTP(
      "/bin/sh",
      [
        "-lc",
        `sprite-env curl -sS -H 'Content-Type: application/json' -X PUT /v1/tasks/${keepAliveTaskName} -d '{"expire":${expireSeconds}}' >/dev/null`,
      ],
      { cwd: "/", timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Sprite keep-alive renewal failed: ${String(result.stderr)}`,
      );
    }
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Sprites only retain filesystem state across sleep");
    }
    await this.#releaseKeepAlive();
    const result = await this.#sprite.execFileHTTP("/bin/sync", [], {
      cwd: "/",
      timeout: 60_000,
    });
    if (result.exitCode !== 0) throw new Error(`Sprite sync failed: ${String(result.stderr)}`);
    this.#sprite.closeControlConnection();
    return {
      provider: providerName,
      checkpointId: this.#sprite.name,
      sourceRuntimeId: this.#sprite.name,
      kind: "filesystem",
      scope: "runtime",
      metadata: { ownershipName: this.#sprite.name, sleepMode: "provider-auto" },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#sprite.name
    ) {
      throw new Error("Sprites runtime can only resume its own retained filesystem");
    }
    await ensureReady(this.#sprite, new AbortController().signal);
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "Sprite filesystem checkpoints are not promoted to portable OpenMA workspace checkpoints",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await this.#sprite.execFileHTTP("/bin/sh", ["-lc", command], {
      cwd: "/workspace",
      env: this.#environmentForCommand(command),
      timeout: timeoutMs,
    });
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    const output = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${result.exitCode}]`;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.#environment = { ...this.#environment, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.#commandSecrets.push({ prefix: commandPrefix, secrets: { ...secrets } });
  }

  async readFile(path: string): Promise<string> {
    return this.#sprite.filesystem("/").readFile(path, "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#sprite.filesystem("/").readFile(path));
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#sprite.filesystem("/").writeFile(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#sprite.filesystem("/").writeFile(path, Buffer.from(bytes));
    return path;
  }

  sessionOutputMountCapabilities(): { durability: "best_effort" } {
    // A Sprite's ext4 filesystem survives sleep, but it is still provider-
    // local until the Node host performs its fenced final collection.  Do not
    // advertise this directory as a provider-native durable mount.
    return { durability: "best_effort" };
  }

  async mountSessionOutputs(_input: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    const result = await this.#sprite.execFileHTTP(
      "/bin/mkdir",
      ["-p", "/mnt/session/outputs"],
      { cwd: "/", timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Sprite Session output directory preparation failed: ${String(result.stderr)}`,
      );
    }
  }

  async updateNetworkPolicy(policy: SpritesNetworkPolicy): Promise<void> {
    await this.#sprite.updateNetworkPolicy(policy);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const processEnvironment = {
      ...this.#environmentForCommand(spec.command),
      ...Object.fromEntries(
        Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] =>
          entry[1] !== undefined
        ),
      ),
    };
    const command = this.#sprite.spawn(
      "/usr/bin/flock",
      [
        "--nonblock",
        processLockPath,
        spec.command,
        ...(spec.args === undefined ? [] : [...spec.args]),
      ],
      {
        cwd: spec.cwd ?? "/workspace",
        ...(Object.keys(processEnvironment).length === 0
          ? {}
          : { env: processEnvironment }),
        tty: false,
        maxRunAfterDisconnect: "1h",
      },
    );
    await new Promise<void>((resolve, reject) => {
      command.once("spawn", () => resolve());
      command.once("error", (error) => reject(error));
    });
    return {
      stdin: writableToWeb(command.stdin),
      stdout: readableToWeb(command.stdout),
      stderr: readableToWeb(command.stderr),
      exited: command.wait().then((code) => {
        command.close();
        return { code, signal: null };
      }),
      async kill(signal = "SIGTERM") {
        command.kill(signal);
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#sprite.closeControlConnection();
    await this.#client.deleteSprite(this.#sprite.name);
    this.#destroyed = true;
  }

  async #releaseKeepAlive(): Promise<void> {
    await this.#sprite.execFileHTTP(
      "/bin/sh",
      [
        "-lc",
        `sprite-env curl -sS -X DELETE /v1/tasks/${keepAliveTaskName} >/dev/null`,
      ],
      { cwd: "/", timeout: 60_000 },
    ).catch(() => undefined);
  }

  async #mountMemoryStore(input: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const workspace = this.#memoryWorkspace;
    if (workspace === undefined) throw new Error("Sprites Memory workspace bridge is unavailable");
    const mountRoot = memoryMountRoot(input.storeName);
    await this.#mkdir(mountRoot);
    const prefix = `${safeBlobPrefix(input.storeId)}/`;
    for (const key of await listAllKeys(workspace, prefix)) {
      const relative = safeRelativeBlobPath(key, prefix);
      const value = await workspace.getText(key);
      if (value === null) continue;
      const target = `${mountRoot}/${relative}`;
      await this.#mkdir(target.slice(0, target.lastIndexOf("/")));
      await this.#sprite.filesystem("/").writeFile(target, value.text);
    }
    if (input.readOnly) {
      const result = await this.#sprite.execFileHTTP(
        "/bin/chmod",
        ["-R", "a-w", mountRoot],
        { cwd: "/", timeout: 60_000 },
      );
      if (result.exitCode !== 0) throw new Error(`Sprite read-only Memory projection failed: ${String(result.stderr)}`);
    }
    this.#memoryMounts.set(input.storeName, {
      storeId: input.storeId,
      readOnly: input.readOnly,
    });
  }

  async #synchronizeMemoryStores(): Promise<void> {
    const workspace = this.#memoryWorkspace;
    if (workspace === undefined) return;
    for (const [storeName, mount] of this.#memoryMounts) {
      if (mount.readOnly) continue;
      const mountRoot = memoryMountRoot(storeName);
      const result = await this.#sprite.execFileHTTP(
        "/usr/bin/find",
        [mountRoot, "-type", "f", "-print0"],
        { cwd: "/", timeout: 60_000 },
      );
      if (result.exitCode !== 0) throw new Error(`Sprite Memory collection failed: ${String(result.stderr)}`);
      const prefix = `${safeBlobPrefix(mount.storeId)}/`;
      const localKeys = new Set<string>();
      for (const absolutePath of String(result.stdout).split("\0").filter(Boolean)) {
        if (!absolutePath.startsWith(`${mountRoot}/`)) {
          throw new Error(`Sprite Memory file escaped its mount: ${absolutePath}`);
        }
        const relative = safeRelativeBlobPath(absolutePath.slice(mountRoot.length + 1), "");
        const key = `${prefix}${relative}`;
        localKeys.add(key);
        const written = await workspace.put(
          key,
          await this.#sprite.filesystem("/").readFile(absolutePath, "utf8"),
        );
        if (written === null) throw new Error(`Sprite Memory flush failed: ${relative}`);
      }
      for (const key of await listAllKeys(workspace, prefix)) {
        if (!localKeys.has(key)) await workspace.delete(key);
      }
    }
  }

  async #mkdir(path: string): Promise<void> {
    await this.#sprite.filesystem("/").mkdir(path, { recursive: true });
  }

  #environmentForCommand(command: string): Record<string, string> {
    const environment = { ...this.#environment };
    const trimmed = command.trimStart();
    for (const { prefix, secrets } of this.#commandSecrets) {
      if (!trimmed.startsWith(prefix)) continue;
      const boundary = trimmed.charAt(prefix.length);
      if (prefix.length > 0 && !/\s/u.test(prefix.at(-1)!) && boundary !== "" && !/\s/u.test(boundary)) {
        continue;
      }
      Object.assign(environment, secrets);
    }
    return environment;
  }
}

function memoryMountRoot(storeName: string): string {
  if (
    storeName.length === 0
    || storeName === "."
    || storeName === ".."
    || storeName.includes("/")
    || storeName.includes("\0")
  ) throw new Error("Sprite Memory Store name must be a safe path segment");
  return `/mnt/memory/${storeName}`;
}

function safeBlobPrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (
    normalized.length === 0
    || normalized.includes("\0")
    || normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) throw new Error("Sprite Memory Store id must be a safe blob prefix");
  return normalized;
}

function safeRelativeBlobPath(value: string, prefix: string): string {
  if (prefix !== "" && !value.startsWith(prefix)) {
    throw new Error(`Sprite Memory blob escaped its prefix: ${value}`);
  }
  const relative = prefix === "" ? value : value.slice(prefix.length);
  if (
    relative.length === 0
    || relative.startsWith("/")
    || relative.includes("\0")
    || relative.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) throw new Error(`Sprite Memory blob has an unsafe path: ${value}`);
  return relative;
}

async function listAllKeys(
  workspace: SandboxMemoryWorkspacePort,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await workspace.list(prefix, cursor);
    keys.push(...page.keys);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return [...new Set(keys)].sort();
}

function createProviderWithClient(
  options: SpritesProviderOptions,
  resolveClient: ClientResolver,
): ProviderManagedRuntimeProviderPort<SpritesRuntime> {
  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("Sprites managed allocation requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const client = await resolveClient();
      const name = stableName(context.sessionId);
      const labels = ownershipLabels(
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      let sprite: SpriteSdkPort;
      try {
        sprite = await retryLifecycle(
          () => client.getSprite(name),
          acquisition.signal,
          options.lifecycleRetry,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const extra = await options.createOptions?.({
          ...acquisition,
          name,
          ownershipLabels: labels,
        }) ?? {};
        try {
          sprite = await retryLifecycle(
            () => client.createSprite(name, { ...extra, labels }),
            acquisition.signal,
            options.lifecycleRetry,
          );
        } catch (createError) {
          if (!isConflict(createError)) throw createError;
          sprite = await retryLifecycle(
            () => client.getSprite(name),
            acquisition.signal,
            options.lifecycleRetry,
          );
        }
      }
      validateSprite(
        sprite,
        name,
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      const policy = await options.networkPolicy?.({ ...acquisition, name });
      if (policy !== undefined && policy !== null) {
        await sprite.updateNetworkPolicy(policy);
      }
      await ensureReady(sprite, acquisition.signal);
      return new SpritesRuntime({
        client,
        sprite,
        ...(options.memoryWorkspace === undefined ? {} : { memoryWorkspace: options.memoryWorkspace }),
      });
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Sprites provider received an incompatible runtime handle");
      }
      if (acquisition === undefined) {
        throw new Error("Sprites managed resume requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const client = await resolveClient();
      const sprite = await retryLifecycle(
        () => client.getSprite(handle.runtimeId),
        acquisition.signal,
        options.lifecycleRetry,
      );
      validateSprite(
        sprite,
        stableName(context.sessionId),
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      const policy = await options.networkPolicy?.({
        ...acquisition,
        name: handle.runtimeId,
      });
      if (policy !== undefined && policy !== null) {
        await sprite.updateNetworkPolicy(policy);
      }
      await ensureReady(sprite, acquisition.signal);
      return new SpritesRuntime({
        client,
        sprite,
        ...(options.memoryWorkspace === undefined ? {} : { memoryWorkspace: options.memoryWorkspace }),
      });
    },

    async restore() {
      throw new Error(
        "Sprites managed runtime does not advertise portable workspace restore",
      );
    },
  };
}

export function createSpritesProvider(
  options: SpritesProviderOptions,
): ProviderManagedRuntimeProviderPort<SpritesRuntime> {
  return createProviderWithClient(options, createClientResolver(options));
}

/**
 * Compose the official Sprites lifecycle behind the low-level SandboxFactory
 * used by the standalone Node host. The synthetic acquisition identity is
 * only used for stable ownership labels; durable execution fencing remains
 * owned by the Node session coordinator.
 */
export async function createSpritesSandbox(
  context: SandboxFactoryContext,
  environment: SandboxFactoryEnv,
  options: SpritesProviderOptions = {},
): Promise<SpritesRuntime> {
  const provider = createSpritesProvider({
    ...options,
    memoryWorkspace: options.memoryWorkspace ?? context.memoryWorkspace,
    token: options.token ?? environment.SPRITES_TOKEN,
    baseURL: options.baseURL ?? environment.SPRITES_API_URL,
  });
  const workspaceId = environment.OPENMA_WORKSPACE_ID ?? "node-standalone";
  const environmentId = environment.OPENMA_ENVIRONMENT_ID ?? "node-standalone";
  const workId = `work-${labelHash(context.sessionId)}`;
  const scope = {
    workspaceId,
    environmentId,
    sessionId: context.sessionId,
    workId,
  };
  const controller = new AbortController();

  return provider.create(context, environment, {
    scope,
    fence: {
      ...scope,
      ownerId: `node-${labelHash(context.sessionId)}`,
      generation: 1,
      token: `standalone-${labelHash(`${workspaceId}:${context.sessionId}`)}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    },
    plan: {
      workspaceStrategy: "retained_runtime",
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: {
        type: "ama_worker",
        process: { command: "openma-environment-worker" },
      },
    },
    workspace: { bindingId: `workspace-${labelHash(context.sessionId)}`, mountPath: "/workspace" },
    outputs: null,
    credentialEgress: null,
    signal: controller.signal,
  });
}

export const sandboxFactory: SandboxFactory = (context, environment) =>
  createSpritesSandbox(context, environment);

export function createSpritesManagedRuntime(options: SpritesManagedRuntimeOptions) {
  const resolveClient = createClientResolver(options);
  const provider = createProviderWithClient(options, resolveClient);
  return createProviderManagedRuntime({
    providerName,
    provider,
    context: (scope: RuntimeResourceScope): SandboxFactoryContext => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: (): SandboxFactoryEnv => ({}),
    leaseTtlMs: options.leaseTtlMs,
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime"],
      retainedSuspendKind: "filesystem",
    },
    ...(options.outputStore === undefined || options.outputStore === null
      ? {}
      : {
          outputs: {
            store: options.outputStore,
            keyPrefix: options.outputKeyPrefix ?? "managed-runtime-output-candidates",
            durability: "durable" as const,
          },
        }),
    ...(options.credentialEgress === undefined
      ? {}
      : { credentialEgress: options.credentialEgress }),
    reapRuntime: async ({ scope, lease }) => {
      const client = await resolveClient();
      let sprite: SpriteSdkPort;
      try {
        sprite = await client.getSprite(lease.runtimeId);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      validateSprite(
        sprite,
        stableName(scope.sessionId),
        scope.environmentId,
        scope.sessionId,
      );
      await client.deleteSprite(lease.runtimeId);
    },
    drivers: ["ama_worker"],
  });
}

export function createSpritesManagedRuntimeDriver(
  options: SpritesManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const hasOutputs = options.outputStore !== undefined && options.outputStore !== null;
  return {
    descriptor() {
      return {
        provider: providerName,
        version: "1.0.0",
        placements: ["in_process"],
        capabilities: {
          sandbox: {
            suspendResume: "supported",
            hardTerminate: "supported",
            runtimeCheckpoints: [],
          },
          workspace: { strategies: ["retained_runtime"] },
          outputs: {
            strategies: hasOutputs
              ? [{ strategy: "final_collect", durability: "durable" }]
              : [],
          },
          harness: { drivers: ["ama_worker", "openma_supervised"] },
        },
        credentialEgress: options.credentialEgress?.capabilities ?? {
          enforcement: "unsupported",
          credentialMode: "snapshot",
          interceptedProtocols: [],
        },
      };
    },
    async create(input) {
      if (input.placement !== "in_process") {
        throw new Error(`Sprites driver does not support ${input.placement} placement`);
      }
      const resources = createSpritesManagedRuntime(options);
      return {
        sandbox: resources.sandbox,
        workspace: resources.workspace,
        outputs: resources.outputs,
        harnessDriver: resources.harness,
        supervisorTransport: resources.supervisorTransport,
        ...(resources.credentialEgress === undefined
          ? {}
          : { credentialEgress: resources.credentialEgress }),
        ...(options.sessionInputs === undefined ? {} : { sessionInputs: options.sessionInputs }),
      };
    },
  };
}
