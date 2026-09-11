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
import { createHash, randomUUID } from "node:crypto";

const providerName = "blaxel";
const environmentLabel = "openma.environment_id";
const sessionLabel = "openma.session_id";
const modeLabel = "openma.mode";
const managedMode = "managed";

export interface BlaxelProcessRequest {
  command: string;
  env?: Record<string, string>;
  keepAlive?: boolean;
  name?: string;
  stdin?: boolean;
  timeout?: number;
  waitForCompletion?: boolean;
  workingDir?: string;
  onLog?: (log: string) => void;
  onStdout?: (stdout: string) => void;
  onStderr?: (stderr: string) => void;
}

export interface BlaxelProcessResponse {
  name: string;
  pid: string;
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  close?: () => void;
}

export interface BlaxelProcessPort {
  exec(request: BlaxelProcessRequest): Promise<BlaxelProcessResponse>;
  wait(identifier: string, options?: {
    maxWait?: number;
    interval?: number;
  }): Promise<BlaxelProcessResponse>;
  writeStdin(identifier: string, data: string | Uint8Array): Promise<void>;
  closeStdin(identifier: string): Promise<void>;
  kill(identifier: string): Promise<unknown>;
}

export interface BlaxelFilesystemPort {
  mkdir(path: string, permissions?: string): Promise<unknown>;
  write(path: string, content: string): Promise<unknown>;
  writeBinary(path: string, content: Uint8Array | string): Promise<unknown>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Blob>;
}

export interface BlaxelNetwork {
  allowedDomains?: string[];
  forbiddenDomains?: string[];
  firewall?: { rulesets?: string[] };
  proxy?: {
    allowedDomains?: string[];
    forbiddenDomains?: string[];
    bypass?: string[];
    routing?: Array<{
      destinations?: string[];
      headers?: Record<string, string>;
      body?: Record<string, string>;
      secrets?: Record<string, string>;
    }>;
  };
}

export interface BlaxelSandboxSdkPort {
  readonly metadata: {
    name?: string;
    labels?: Record<string, string>;
    externalId?: string;
  };
  readonly status: string | undefined;
  readonly fs: BlaxelFilesystemPort;
  readonly process: BlaxelProcessPort;
  wait(options?: { maxWait?: number; interval?: number }): Promise<BlaxelSandboxSdkPort>;
  archive(options?: {
    wait?: boolean;
    maxWait?: number;
    interval?: number;
  }): Promise<BlaxelSandboxSdkPort>;
  unarchive(options?: {
    wait?: boolean;
    maxWait?: number;
    interval?: number;
  }): Promise<BlaxelSandboxSdkPort>;
  delete(): Promise<unknown>;
}

export interface BlaxelCreateOptions {
  name: string;
  image: string;
  memory?: number;
  region?: string;
  ttl?: string;
  lifecycle?: {
    expirationPolicies?: Array<{
      action?: "delete";
      type?: "ttl-idle" | "ttl-max-age" | "date";
      value?: string;
    }>;
    terminatedRetention?: string;
  };
  envs?: Array<{ name: string; value: string }>;
  volumes?: Array<{
    name?: string;
    mountPath?: string;
    readOnly?: boolean;
    type?: "persistent" | "ephemeral";
    sizeMb?: number;
  }>;
  network?: BlaxelNetwork;
  snapshotEnabled?: boolean;
  labels: Record<string, string>;
  externalId: string;
}

export interface BlaxelSdkPort {
  createIfNotExists(input: BlaxelCreateOptions): Promise<BlaxelSandboxSdkPort>;
  get(name: string): Promise<BlaxelSandboxSdkPort>;
  delete(name: string): Promise<unknown>;
  updateNetwork(
    name: string,
    input: { network?: BlaxelNetwork },
  ): Promise<BlaxelSandboxSdkPort>;
}

type SafeAllocationOptions = Partial<Omit<
  BlaxelCreateOptions,
  "name" | "image" | "labels" | "externalId"
>>;

export interface BlaxelProviderOptions {
  client?: BlaxelSdkPort;
  image: string;
  memory?: number;
  region?: string;
  ttl?: string;
  lifecycle?: BlaxelCreateOptions["lifecycle"];
  allocationOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SafeAllocationOptions> | SafeAllocationOptions;
}

export interface BlaxelManagedRuntimeOptions extends BlaxelProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<BlaxelRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<BlaxelRuntime>["readiness"];
}

interface BlaxelModulePort {
  SandboxInstance: {
    createIfNotExists(input: BlaxelCreateOptions): Promise<BlaxelSandboxSdkPort>;
    get(name: string): Promise<BlaxelSandboxSdkPort>;
    delete(name: string): Promise<unknown>;
    updateNetwork(
      name: string,
      input: { network?: BlaxelNetwork },
    ): Promise<BlaxelSandboxSdkPort>;
  };
}

async function loadBlaxelSdk(options: BlaxelProviderOptions): Promise<BlaxelSdkPort> {
  if (options.client !== undefined) return options.client;
  let module: BlaxelModulePort;
  try {
    module = await import(/* @vite-ignore */ "@blaxel/core" as string) as unknown as BlaxelModulePort;
  } catch (error) {
    throw new Error(
      `Blaxel managed runtime requires '@blaxel/core': ${String(error)}`,
    );
  }
  return module.SandboxInstance;
}

type BlaxelSdkResolver = () => Promise<BlaxelSdkPort>;

function createSdkResolver(options: BlaxelProviderOptions): BlaxelSdkResolver {
  let promise: Promise<BlaxelSdkPort> | undefined;
  return () => promise ??= loadBlaxelSdk(options);
}

function stableName(sessionId: string): string {
  return `oma-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

function stableExternalId(environmentId: string, sessionId: string): string {
  return `openma:${createHash("sha256")
    .update(`${environmentId}:${sessionId}`)
    .digest("hex")}`;
}

function expectedLabels(environmentId: string, sessionId: string) {
  return {
    [environmentLabel]: environmentId,
    [sessionLabel]: sessionId,
    [modeLabel]: managedMode,
  };
}

function validateSandbox(
  sandbox: BlaxelSandboxSdkPort,
  expectedName: string,
  environmentId: string,
  sessionId: string,
): void {
  const labels = sandbox.metadata.labels ?? {};
  if (
    sandbox.metadata.name !== expectedName
    || labels[environmentLabel] !== environmentId
    || labels[sessionLabel] !== sessionId
    || labels[modeLabel] !== managedMode
  ) {
    throw new Error(
      `Refusing to attach Blaxel sandbox ${String(sandbox.metadata.name)}: ownership labels do not match the requested environment and Session`,
    );
  }
}

function processSucceeded(response: BlaxelProcessResponse): boolean {
  return response.exitCode === 0
    && !["failed", "killed", "stopped"].includes(response.status.toLowerCase());
}

async function ensureReady(sandbox: BlaxelSandboxSdkPort): Promise<void> {
  await sandbox.wait({ maxWait: 120_000, interval: 1_000 });
  await sandbox.fs.mkdir("/workspace");
  const probe = await sandbox.process.exec({
    command: "true",
    waitForCompletion: true,
    timeout: 30,
    workingDir: "/",
  });
  if (!processSucceeded(probe)) {
    throw new Error(
      `Blaxel sandbox readiness probe failed: ${probe.stderr || probe.stdout}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function processCommand(spec: SandboxDuplexProcessSpec): string {
  return `exec ${[spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ")}`;
}

function processName(spec: SandboxDuplexProcessSpec): string {
  const stableWorkId = spec.env?.ANTHROPIC_WORK_ID ?? spec.env?.OPENMA_WORK_ID;
  const identity = stableWorkId ?? randomUUID();
  return `oma-run-${createHash("sha256")
    .update(`${identity}:${spec.command}:${JSON.stringify(spec.args ?? [])}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export class BlaxelRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #sdk: BlaxelSdkPort;
  readonly #sandbox: BlaxelSandboxSdkPort;
  readonly #name: string;
  #destroyed = false;

  constructor(input: {
    sdk: BlaxelSdkPort;
    sandbox: BlaxelSandboxSdkPort;
    name: string;
  }) {
    this.#sdk = input.sdk;
    this.#sandbox = input.sandbox;
    this.#name = input.name;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#name };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    const status = (this.#sandbox.status ?? "").toUpperCase();
    if (status === "ARCHIVED") return "suspended";
    if (["TERMINATED", "FAILED", "DELETING"].includes(status)) return "stopped";
    if (["DEPLOYED", "DEACTIVATED"].includes(status)) return "running";
    return "unknown";
  }

  async renewLease(): Promise<void> {
    if (await this.status() === "stopped") {
      throw new Error("Blaxel sandbox is no longer available");
    }
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Blaxel archive supports filesystem suspension only");
    }
    await this.#sandbox.archive({ wait: true, maxWait: 30 * 60_000, interval: 2_000 });
    return {
      provider: providerName,
      checkpointId: this.#name,
      sourceRuntimeId: this.#name,
      kind: "filesystem",
      scope: "runtime",
      metadata: { ownershipName: this.#name },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#name
    ) {
      throw new Error("Blaxel runtime can only resume its own retained archive");
    }
    await this.#sandbox.unarchive({ wait: true, maxWait: 30 * 60_000, interval: 2_000 });
    await ensureReady(this.#sandbox);
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "Blaxel snapshots are provider-local and are not advertised as portable workspace checkpoints",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const response = await this.#sandbox.process.exec({
      command,
      waitForCompletion: true,
      timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
      workingDir: "/workspace",
    });
    const output = `${response.stdout}${response.stderr === "" ? "" : `\n${response.stderr}`}`
      .replace(/\s+$/g, "");
    return processSucceeded(response) ? output : `${output}\n[exit ${response.exitCode}]`;
  }

  async readFile(path: string): Promise<string> {
    return this.#sandbox.fs.read(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const blob = await this.#sandbox.fs.readBinary(path);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#sandbox.fs.write(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#sandbox.fs.writeBinary(path, bytes);
    return path;
  }

  async updateNetwork(network: BlaxelNetwork): Promise<void> {
    await this.#sdk.updateNetwork(this.#name, { network });
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const stdout = new TransformStream<Uint8Array, Uint8Array>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();
    const stdoutWriter = stdout.writable.getWriter();
    const stderrWriter = stderr.writable.getWriter();
    const encoder = new TextEncoder();
    const closeStreams = async () => {
      await Promise.allSettled([
        stdoutWriter.close(),
        stderrWriter.close(),
      ]);
    };
    const name = processName(spec);
    let response: BlaxelProcessResponse;
    try {
      response = await this.#sandbox.process.exec({
        name,
        command: processCommand(spec),
        ...(spec.env === undefined ? {} : {
          env: Object.fromEntries(
            Object.entries(spec.env).filter((entry): entry is [string, string] =>
              entry[1] !== undefined
            ),
          ),
        }),
        stdin: true,
        keepAlive: true,
        timeout: 0,
        waitForCompletion: false,
        workingDir: spec.cwd ?? "/workspace",
        onStdout: (chunk) => { void stdoutWriter.write(encoder.encode(chunk)); },
        onStderr: (chunk) => { void stderrWriter.write(encoder.encode(chunk)); },
      });
    } catch (error) {
      await Promise.allSettled([
        stdoutWriter.abort(error),
        stderrWriter.abort(error),
      ]);
      throw error;
    }
    const identifier = response.name || response.pid;
    const exited = this.#sandbox.process.wait(identifier, {
      maxWait: 24 * 60 * 60_000,
      interval: 500,
    }).then(async (result) => {
      response.close?.();
      await closeStreams();
      return { code: result.exitCode, signal: null };
    }, async (error) => {
      response.close?.();
      await Promise.allSettled([
        stdoutWriter.abort(error),
        stderrWriter.abort(error),
      ]);
      throw error;
    });
    return {
      stdin: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          await this.#sandbox.process.writeStdin(identifier, chunk);
        },
        close: async () => {
          await this.#sandbox.process.closeStdin(identifier);
        },
        abort: async () => {
          await this.#sandbox.process.kill(identifier);
        },
      }),
      stdout: stdout.readable,
      stderr: stderr.readable,
      exited,
      kill: async () => {
        await this.#sandbox.process.kill(identifier);
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#sdk.delete(this.#name);
    this.#destroyed = true;
  }
}

function createBlaxelProviderWithSdk(
  options: BlaxelProviderOptions,
  resolveSdk: BlaxelSdkResolver,
): ProviderManagedRuntimeProviderPort<BlaxelRuntime> {
  const runtime = (
    sdk: BlaxelSdkPort,
    sandbox: BlaxelSandboxSdkPort,
    name: string,
  ) => new BlaxelRuntime({ sdk, sandbox, name });

  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("Blaxel managed allocation requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      const name = stableName(context.sessionId);
      const labels = expectedLabels(
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      const extra = await options.allocationOptions?.({ ...acquisition, name }) ?? {};
      acquisition.signal.throwIfAborted();
      const sandbox = await sdk.createIfNotExists({
        memory: options.memory ?? 4_096,
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        ...extra,
        name,
        image: options.image,
        labels,
        externalId: stableExternalId(
          acquisition.scope.environmentId,
          acquisition.scope.sessionId,
        ),
      });
      validateSandbox(
        sandbox,
        name,
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      await ensureReady(sandbox);
      acquisition.signal.throwIfAborted();
      return runtime(sdk, sandbox, name);
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Blaxel provider received an incompatible runtime handle");
      }
      if (acquisition === undefined) {
        throw new Error("Blaxel managed resume requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      const sandbox = await sdk.get(handle.runtimeId);
      const name = stableName(context.sessionId);
      validateSandbox(
        sandbox,
        name,
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      if ((sandbox.status ?? "").toUpperCase() === "ARCHIVED") {
        await sandbox.unarchive({ wait: true, maxWait: 30 * 60_000, interval: 2_000 });
      }
      await ensureReady(sandbox);
      acquisition.signal.throwIfAborted();
      return runtime(sdk, sandbox, name);
    },

    async restore() {
      throw new Error(
        "Blaxel managed runtime does not advertise portable workspace restore",
      );
    },
  };
}

export function createBlaxelProvider(
  options: BlaxelProviderOptions,
): ProviderManagedRuntimeProviderPort<BlaxelRuntime> {
  return createBlaxelProviderWithSdk(options, createSdkResolver(options));
}

export function createBlaxelManagedRuntime(options: BlaxelManagedRuntimeOptions) {
  const resolveSdk = createSdkResolver(options);
  const provider = createBlaxelProviderWithSdk(options, resolveSdk);
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
    reapRuntime: async ({ lease, scope }) => {
      const sdk = await resolveSdk();
      let sandbox: BlaxelSandboxSdkPort;
      try {
        sandbox = await sdk.get(lease.runtimeId);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      validateSandbox(
        sandbox,
        stableName(scope.sessionId),
        scope.environmentId,
        scope.sessionId,
      );
      await sdk.delete(lease.runtimeId);
    },
    drivers: ["ama_worker"],
  });
}

export function createBlaxelManagedRuntimeDriver(
  options: BlaxelManagedRuntimeOptions,
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
        throw new Error(`Blaxel driver does not support ${input.placement} placement`);
      }
      const resources = createBlaxelManagedRuntime(options);
      return {
        sandbox: resources.sandbox,
        workspace: resources.workspace,
        outputs: resources.outputs,
        harnessDriver: resources.harness,
        supervisorTransport: resources.supervisorTransport,
        ...(resources.credentialEgress === undefined
          ? {}
          : { credentialEgress: resources.credentialEgress }),
        ...(options.sessionInputs === undefined
          ? {}
          : { sessionInputs: options.sessionInputs }),
      };
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("status" in error && error.status === 404) return true;
  if ("statusCode" in error && error.statusCode === 404) return true;
  return error instanceof Error && /not[ -]?found/i.test(error.message);
}
