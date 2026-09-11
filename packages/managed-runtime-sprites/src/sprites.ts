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
  SandboxPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";

const providerName = "sprites";

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
  createOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
    ownershipLabels: string[];
  }): Promise<SafeCreateOptions> | SafeCreateOptions;
  networkPolicy?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SpritesNetworkPolicy | null> | SpritesNetworkPolicy | null;
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
  #destroyed = false;

  constructor(input: { client: SpritesClientPort; sprite: SpriteSdkPort }) {
    this.#client = input.client;
    this.#sprite = input.sprite;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sprite.name };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: ["filesystem" as const], checkpoint: [] };
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

  async renewLease(): Promise<void> {
    if (await this.status() === "stopped") throw new Error("Sprite is no longer available");
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Sprites only retain filesystem state across sleep");
    }
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
      timeout: timeoutMs,
    });
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    const output = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${result.exitCode}]`;
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

  async updateNetworkPolicy(policy: SpritesNetworkPolicy): Promise<void> {
    await this.#sprite.updateNetworkPolicy(policy);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const command = this.#sprite.spawn(
      spec.command,
      spec.args === undefined ? [] : [...spec.args],
      {
        cwd: spec.cwd ?? "/workspace",
        ...(spec.env === undefined ? {} : {
          env: Object.fromEntries(
            Object.entries(spec.env).filter((entry): entry is [string, string] =>
              entry[1] !== undefined
            ),
          ),
        }),
        tty: false,
        maxRunAfterDisconnect: "1h",
      },
    );
    await command.start();
    return {
      stdin: Writable.toWeb(command.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(command.stdout) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(command.stderr) as unknown as ReadableStream<Uint8Array>,
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
    await this.#client.deleteSprite(this.#sprite.name);
    this.#destroyed = true;
  }
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
        sprite = await client.getSprite(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const extra = await options.createOptions?.({
          ...acquisition,
          name,
          ownershipLabels: labels,
        }) ?? {};
        try {
          sprite = await client.createSprite(name, { ...extra, labels });
        } catch (createError) {
          if (!isConflict(createError)) throw createError;
          sprite = await client.getSprite(name);
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
      return new SpritesRuntime({ client, sprite });
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
      const sprite = await client.getSprite(handle.runtimeId);
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
      return new SpritesRuntime({ client, sprite });
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
