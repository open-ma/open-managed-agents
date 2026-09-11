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
import { createHash } from "node:crypto";

const providerName = "superserve";

export interface SuperserveNetworkConfig {
  allowOut?: string[];
  denyOut?: string[];
}

export interface SuperserveCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface SuperserveCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface SuperserveCommandSessionPort {
  readonly stdin: {
    write(data: string | Uint8Array): void;
    close(): void;
  };
  kill(signal?: string): void;
  wait(): Promise<SuperserveCommandResult>;
  close(): Promise<void>;
}

export interface SuperserveCommandsPort {
  run(command: string, options?: SuperserveCommandOptions): Promise<SuperserveCommandResult>;
  spawn(command: string, options?: SuperserveCommandOptions): Promise<SuperserveCommandSessionPort>;
}

export interface SuperserveFilesPort {
  write(
    path: string,
    content: string | Uint8Array | ArrayBuffer | Blob,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;
  read(
    path: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number },
  ): Promise<Uint8Array>;
  readText(
    path: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string>;
}

export interface SuperserveSandboxInfo {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, string>;
}

export interface SuperserveSandboxSdkPort {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly metadata: Record<string, string>;
  readonly commands: SuperserveCommandsPort;
  readonly files: SuperserveFilesPort;
  getInfo(): Promise<SuperserveSandboxInfo>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  kill(): Promise<void>;
  update(options: {
    metadata?: Record<string, string>;
    network?: SuperserveNetworkConfig;
    autoDeleteSeconds?: number | null;
    timeoutSeconds?: number | null;
  }): Promise<void>;
  attachSecret(envKey: string, secretName: string): Promise<void>;
  detachSecret(envKey: string): Promise<void>;
}

export interface SuperserveCreateOptions {
  name: string;
  fromTemplate?: string | { name?: string; id: string };
  fromSnapshot?: string;
  timeoutSeconds?: number;
  metadata?: Record<string, string>;
  envVars?: Record<string, string>;
  secrets?: Record<string, string>;
  network?: SuperserveNetworkConfig;
  previewAccess?: "public" | "private";
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface SuperserveSdkPort {
  create(options: SuperserveCreateOptions): Promise<SuperserveSandboxSdkPort>;
  connect(
    sandboxId: string,
    options?: { apiKey?: string; baseUrl?: string; signal?: AbortSignal },
  ): Promise<SuperserveSandboxSdkPort>;
  list(options?: {
    metadata?: Record<string, string>;
    status?: string;
    limit?: number;
    offset?: number;
    apiKey?: string;
    baseUrl?: string;
    signal?: AbortSignal;
  }): Promise<SuperserveSandboxInfo[]>;
  killById(
    sandboxId: string,
    options?: { apiKey?: string; baseUrl?: string; signal?: AbortSignal },
  ): Promise<void>;
}

export interface SuperserveCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface SuperserveProviderOptions {
  client?: SuperserveSdkPort;
  credentials?: SuperserveCredentials;
  fromTemplate?: string;
  createOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
    ownershipMetadata: Record<string, string>;
  }): Promise<Omit<SuperserveCreateOptions, "name" | "metadata" | "signal">>
    | Omit<SuperserveCreateOptions, "name" | "metadata" | "signal">;
  network?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SuperserveNetworkConfig> | SuperserveNetworkConfig;
}

export interface SuperserveManagedRuntimeOptions extends SuperserveProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<SuperserveRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<SuperserveRuntime>["readiness"];
}

interface SuperserveModulePort {
  Sandbox: {
    create(options: SuperserveCreateOptions): Promise<SuperserveSandboxSdkPort>;
    connect(
      sandboxId: string,
      options?: { apiKey?: string; baseUrl?: string; signal?: AbortSignal },
    ): Promise<SuperserveSandboxSdkPort>;
    list(options?: Record<string, unknown>): Promise<SuperserveSandboxInfo[]>;
    killById(
      sandboxId: string,
      options?: { apiKey?: string; baseUrl?: string; signal?: AbortSignal },
    ): Promise<void>;
  };
}

function connectionOptions(options: SuperserveProviderOptions): {
  apiKey?: string;
  baseUrl?: string;
} {
  return options.credentials === undefined ? {} : {
    apiKey: options.credentials.apiKey,
    ...(options.credentials.baseUrl === undefined ? {} : { baseUrl: options.credentials.baseUrl }),
  };
}

async function loadSdk(options: SuperserveProviderOptions): Promise<SuperserveSdkPort> {
  if (options.client !== undefined) return options.client;
  let module: SuperserveModulePort;
  try {
    module = await import(/* @vite-ignore */ "@superserve/sdk" as string) as unknown as SuperserveModulePort;
  } catch (error) {
    throw new Error(`Superserve managed runtime requires '@superserve/sdk': ${String(error)}`);
  }
  const connection = connectionOptions(options);
  return {
    create: (input) => module.Sandbox.create({ ...connection, ...input }),
    connect: (id, input) => module.Sandbox.connect(id, { ...connection, ...input }),
    list: (input) => module.Sandbox.list({ ...connection, ...input }),
    killById: (id, input) => module.Sandbox.killById(id, { ...connection, ...input }),
  };
}

type SdkResolver = () => Promise<SuperserveSdkPort>;

function createSdkResolver(options: SuperserveProviderOptions): SdkResolver {
  let promise: Promise<SuperserveSdkPort> | undefined;
  return () => promise ??= loadSdk(options);
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableName(sessionId: string): string {
  return `oma-${hash(sessionId, 32)}`;
}

function ownershipMetadata(environmentId: string, sessionId: string): Record<string, string> {
  return {
    openma: "managed",
    oma_env: hash(environmentId, 24),
    oma_session: hash(sessionId, 24),
  };
}

function validateSandbox(
  sandbox: Pick<SuperserveSandboxSdkPort, "id" | "name" | "metadata">,
  expectedName: string,
  environmentId: string,
  sessionId: string,
): void {
  const required = ownershipMetadata(environmentId, sessionId);
  if (
    sandbox.name !== expectedName
    || Object.entries(required).some(([key, value]) => sandbox.metadata[key] !== value)
  ) {
    throw new Error(
      `Refusing to attach Superserve sandbox ${sandbox.id}: ownership metadata does not match the requested environment and Session`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "name" in error) {
    if (/NotFound/i.test(String(error.name))) return true;
  }
  return error instanceof Error && /not[ _-]?found|404/i.test(error.message);
}

function isConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "name" in error) {
    if (/Conflict/i.test(String(error.name))) return true;
  }
  return error instanceof Error && /already exists|conflict|409/i.test(error.message);
}

function isTerminal(status: string): boolean {
  return ["failed", "deleted"].includes(status.toLowerCase());
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processCommand(spec: SandboxDuplexProcessSpec): string {
  return [spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ");
}

async function ensureReady(sandbox: SuperserveSandboxSdkPort, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const result = await sandbox.commands.run("mkdir -p /workspace && /usr/bin/true", {
    cwd: "/",
    timeoutMs: 30_000,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Superserve sandbox readiness probe failed: ${result.stderr || result.stdout}`);
  }
  signal.throwIfAborted();
}

export class SuperserveRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #sandbox: SuperserveSandboxSdkPort;
  #destroyed = false;

  constructor(sandbox: SuperserveSandboxSdkPort) {
    this.#sandbox = sandbox;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sandbox.id };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    try {
      const status = (await this.#sandbox.getInfo()).status.toLowerCase();
      if (status === "paused") return "suspended";
      if (isTerminal(status)) return "stopped";
      if (["starting", "active", "pausing", "resuming"].includes(status)) return "running";
      return "unknown";
    } catch (error) {
      return isNotFound(error) ? "stopped" : "unknown";
    }
  }

  async renewLease(): Promise<void> {
    const status = await this.status();
    if (status === "stopped" || status === "unknown") {
      throw new Error("Superserve sandbox is no longer available");
    }
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Superserve adapter only promotes retained filesystem state");
    }
    const sync = await this.#sandbox.commands.run("/bin/sync", {
      cwd: "/",
      timeoutMs: 60_000,
    });
    if (sync.exitCode !== 0) throw new Error(`Superserve sync failed: ${sync.stderr}`);
    await this.#sandbox.pause();
    return {
      provider: providerName,
      checkpointId: this.#sandbox.id,
      sourceRuntimeId: this.#sandbox.id,
      kind: "filesystem",
      scope: "runtime",
      metadata: { persistence: "provider-retained-pause" },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#sandbox.id
    ) {
      throw new Error("Superserve runtime can only resume its own retained state");
    }
    await this.#sandbox.resume();
    await ensureReady(this.#sandbox, new AbortController().signal);
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "Superserve pause retention is not promoted to a portable OpenMA workspace checkpoint",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await this.#sandbox.commands.run(command, {
      cwd: "/workspace",
      timeoutMs,
    });
    const output = `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`
      .replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${String(result.exitCode)}]`;
  }

  readFile(path: string): Promise<string> {
    return this.#sandbox.files.readText(path);
  }

  readFileBytes(path: string): Promise<Uint8Array> {
    return this.#sandbox.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#sandbox.files.write(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#sandbox.files.write(path, bytes);
    return path;
  }

  updateNetworkPolicy(network: SuperserveNetworkConfig): Promise<void> {
    return this.#sandbox.update({ network, autoDeleteSeconds: null });
  }

  attachSecret(envKey: string, secretName: string): Promise<void> {
    return this.#sandbox.attachSecret(envKey, secretName);
  }

  detachSecret(envKey: string): Promise<void> {
    return this.#sandbox.detachSecret(envKey);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    const encoder = new TextEncoder();
    const command = await this.#sandbox.commands.spawn(processCommand(spec), {
      cwd: spec.cwd ?? "/workspace",
      ...(spec.env === undefined ? {} : {
        env: Object.fromEntries(
          Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      }),
      onStdout: (data) => stdoutController.enqueue(encoder.encode(data)),
      onStderr: (data) => stderrController.enqueue(encoder.encode(data)),
    });
    const closeStreams = () => {
      stdoutController.close();
      stderrController.close();
    };
    const errorStreams = (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      stdoutController.error(normalized);
      stderrController.error(normalized);
    };
    const exited = command.wait().then(
      (result) => {
        closeStreams();
        return { code: result.exitCode, signal: null };
      },
      (error: unknown) => {
        errorStreams(error);
        throw error;
      },
    );
    return {
      stdin: new WritableStream<Uint8Array>({
        write(chunk) { command.stdin.write(chunk); },
        close() { command.stdin.close(); },
        async abort() { await command.close(); },
      }),
      stdout,
      stderr,
      exited,
      async kill(signal = "SIGTERM") {
        command.kill(signal);
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#sandbox.kill();
    this.#destroyed = true;
  }
}

async function findOwnedSandbox(
  sdk: SuperserveSdkPort,
  environmentId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<SuperserveSandboxInfo | undefined> {
  const metadata = ownershipMetadata(environmentId, sessionId);
  const boxes = await sdk.list({ metadata, signal });
  const name = stableName(sessionId);
  return boxes.find((candidate) => candidate.name === name && !isTerminal(candidate.status));
}

async function acquireSandbox(
  options: SuperserveProviderOptions,
  resolveSdk: SdkResolver,
  context: SandboxFactoryContext,
  acquisition: ProviderManagedRuntimeAcquisitionContext,
): Promise<SuperserveSandboxSdkPort> {
  acquisition.signal.throwIfAborted();
  const sdk = await resolveSdk();
  const name = stableName(context.sessionId);
  const metadata = ownershipMetadata(acquisition.scope.environmentId, acquisition.scope.sessionId);
  const existing = await findOwnedSandbox(
    sdk,
    acquisition.scope.environmentId,
    acquisition.scope.sessionId,
    acquisition.signal,
  );
  let sandbox: SuperserveSandboxSdkPort;
  if (existing !== undefined) {
    validateSandbox(existing, name, acquisition.scope.environmentId, acquisition.scope.sessionId);
    sandbox = await sdk.connect(existing.id, { signal: acquisition.signal });
  } else {
    const extra = await options.createOptions?.({
      ...acquisition,
      name,
      ownershipMetadata: metadata,
    }) ?? {};
    const network = await options.network?.({ ...acquisition, name }) ?? {
      allowOut: ["*.superserve.ai"],
      denyOut: ["0.0.0.0/0"],
    };
    try {
      sandbox = await sdk.create({
        ...extra,
        name,
        ...(options.fromTemplate === undefined ? {} : { fromTemplate: options.fromTemplate }),
        metadata,
        network,
        // Provider retention is deliberate: OpenMA owns hard deletion.
        signal: acquisition.signal,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const raced = await findOwnedSandbox(
        sdk,
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
        acquisition.signal,
      );
      if (raced === undefined) throw error;
      sandbox = await sdk.connect(raced.id, { signal: acquisition.signal });
    }
  }
  const info = await sandbox.getInfo();
  validateSandbox(info, name, acquisition.scope.environmentId, acquisition.scope.sessionId);
  // Reassert both retention and egress policy before readiness. Existing boxes
  // may have been left by a stale generation with weaker settings.
  const network = await options.network?.({ ...acquisition, name }) ?? {
    allowOut: ["*.superserve.ai"],
    denyOut: ["0.0.0.0/0"],
  };
  await sandbox.update({ network, autoDeleteSeconds: null });
  await ensureReady(sandbox, acquisition.signal);
  return sandbox;
}

function createProviderWithSdk(
  options: SuperserveProviderOptions,
  resolveSdk: SdkResolver,
): ProviderManagedRuntimeProviderPort<SuperserveRuntime> {
  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("Superserve managed allocation requires acquisition context");
      }
      return new SuperserveRuntime(
        await acquireSandbox(options, resolveSdk, context, acquisition),
      );
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Superserve provider received an incompatible runtime handle");
      }
      if (acquisition === undefined) {
        throw new Error("Superserve managed resume requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      try {
        const sandbox = await sdk.connect(handle.runtimeId, { signal: acquisition.signal });
        const info = await sandbox.getInfo();
        validateSandbox(
          info,
          stableName(context.sessionId),
          acquisition.scope.environmentId,
          acquisition.scope.sessionId,
        );
        const network = await options.network?.({ ...acquisition, name: info.name }) ?? {
          allowOut: ["*.superserve.ai"],
          denyOut: ["0.0.0.0/0"],
        };
        await sandbox.update({ network, autoDeleteSeconds: null });
        await ensureReady(sandbox, acquisition.signal);
        return new SuperserveRuntime(sandbox);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return new SuperserveRuntime(
          await acquireSandbox(options, resolveSdk, context, acquisition),
        );
      }
    },

    async restore() {
      throw new Error("Superserve managed runtime does not advertise portable workspace restore");
    },
  };
}

export function createSuperserveProvider(
  options: SuperserveProviderOptions,
): ProviderManagedRuntimeProviderPort<SuperserveRuntime> {
  return createProviderWithSdk(options, createSdkResolver(options));
}

export function createSuperserveManagedRuntime(options: SuperserveManagedRuntimeOptions) {
  const resolveSdk = createSdkResolver(options);
  return createProviderManagedRuntime({
    providerName,
    provider: createProviderWithSdk(options, resolveSdk),
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
      const sdk = await resolveSdk();
      const boxes = await sdk.list({
        metadata: ownershipMetadata(scope.environmentId, scope.sessionId),
      });
      const info = boxes.find((candidate) => candidate.id === lease.runtimeId);
      if (info === undefined) return;
      validateSandbox(info, stableName(scope.sessionId), scope.environmentId, scope.sessionId);
      // killById is idempotent and, unlike connect(), does not wake a paused orphan.
      await sdk.killById(info.id);
    },
    drivers: ["ama_worker"],
  });
}

export function createSuperserveManagedRuntimeDriver(
  options: SuperserveManagedRuntimeOptions,
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
        throw new Error(`Superserve driver does not support ${input.placement} placement`);
      }
      const resources = createSuperserveManagedRuntime(options);
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
