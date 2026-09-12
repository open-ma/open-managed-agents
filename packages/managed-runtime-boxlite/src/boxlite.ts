import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import {
  createPreinstalledRuntimeEnvironment,
  createProviderManagedRuntime,
  requireRuntimeEnvironmentArtifact,
  type ProviderManagedRuntimeAcquisitionContext,
  type ProviderManagedRuntimeOptions,
  type ProviderManagedRuntimeProviderPort,
  type ProviderRuntimeEnvironment,
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export type BoxLiteManagedProviderId = "litebox" | "boxrun";

export interface BoxLiteInputPort {
  write(data: Uint8Array): Promise<void>;
  writeString?(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface BoxLiteOutputPort {
  next(): Promise<string | null>;
}

export interface BoxLiteExecutionPort {
  id(): Promise<string>;
  stdin(): Promise<BoxLiteInputPort>;
  stdout(): Promise<BoxLiteOutputPort>;
  stderr(): Promise<BoxLiteOutputPort>;
  wait(): Promise<{ exitCode: number; errorMessage?: string }>;
  kill(): Promise<void>;
  signal?(signal: number): Promise<void>;
}

export interface BoxLiteBoxSdkPort {
  readonly id: string;
  readonly name: string | null;
  info(): {
    id: string;
    name?: string;
    state: { status: string; running: boolean; pid?: number };
  };
  exec(
    command: string,
    args?: string[] | null,
    env?: Array<[string, string]> | null,
    tty?: boolean | null,
    user?: string | null,
    timeoutSecs?: number | null,
    workingDir?: string | null,
  ): Promise<BoxLiteExecutionPort>;
  start(): Promise<void>;
  stop(): Promise<void>;
  copyIn(hostPath: string, containerDest: string, options?: unknown): Promise<void>;
  copyOut(containerSrc: string, hostDest: string, options?: unknown): Promise<void>;
}

export interface BoxLiteClientPort {
  getOrCreate(
    options: BoxLiteCreateOptions,
    name?: string | null,
  ): Promise<{ created: boolean; box: BoxLiteBoxSdkPort }>;
  get(idOrName: string): Promise<BoxLiteBoxSdkPort | null>;
  remove(idOrName: string, force?: boolean | null): Promise<void>;
}

export interface BoxLiteCreateOptions {
  image?: string;
  cpus?: number;
  memoryMib?: number;
  diskSizeGb?: number;
  workingDir?: string;
  env?: Array<{ key: string; value: string }>;
  volumes?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
  network?: { mode: "enabled" | "disabled"; allowNet?: string[] };
  autoRemove?: boolean;
  detach?: boolean;
  security?: Readonly<Record<string, boolean | number | undefined>>;
  secrets?: Array<{
    name: string;
    value: string;
    hosts?: string[];
    placeholder?: string;
  }>;
}

type SafeAllocationOptions = Omit<
  BoxLiteCreateOptions,
  "image" | "autoRemove" | "detach" | "workingDir"
>;

export interface BoxLiteProviderOptions {
  providerId: BoxLiteManagedProviderId;
  image: string;
  client?: BoxLiteClientPort;
  connection?:
    | { type: "embedded"; homeDir?: string }
    | {
        type: "rest";
        url: string;
        clientId?: string;
        clientSecret?: string;
        prefix?: string;
      };
  cpus?: number;
  memoryMib?: number;
  diskSizeGb?: number;
  allocationOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SafeAllocationOptions> | SafeAllocationOptions;
}

export interface BoxLiteManagedRuntimeOptions extends BoxLiteProviderOptions {
  leaseTtlMs: number;
  runtimeEnvironment?: ProviderRuntimeEnvironment<BoxLiteManagedRuntime>;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<BoxLiteManagedRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
}

interface BoxLiteConstructorPort {
  new(options?: { homeDir?: string }): BoxLiteClientPort;
  withDefaultConfig(): BoxLiteClientPort;
  rest(options: {
    url: string;
    clientId?: string;
    clientSecret?: string;
    prefix?: string;
  }): BoxLiteClientPort;
}

function stableName(providerId: BoxLiteManagedProviderId, sessionId: string): string {
  return `oma-${createHash("sha256")
    .update(`${providerId}:${sessionId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

async function loadBoxLiteClient(
  options: BoxLiteProviderOptions,
): Promise<BoxLiteClientPort> {
  if (options.client !== undefined) return options.client;
  let module: { JsBoxlite: BoxLiteConstructorPort };
  try {
    module = await import(
      /* @vite-ignore */ "@boxlite-ai/boxlite" as string
    ) as unknown as { JsBoxlite: BoxLiteConstructorPort };
  } catch (error) {
    throw new Error(
      `BoxLite managed runtime requires '@boxlite-ai/boxlite': ${String(error)}`,
    );
  }
  const connection = options.connection ?? { type: "embedded" as const };
  if (connection.type === "rest") {
    return module.JsBoxlite.rest({
      url: connection.url,
      ...(connection.clientId === undefined ? {} : { clientId: connection.clientId }),
      ...(connection.clientSecret === undefined
        ? {}
        : { clientSecret: connection.clientSecret }),
      ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    });
  }
  return connection.homeDir === undefined
    ? module.JsBoxlite.withDefaultConfig()
    : new module.JsBoxlite({ homeDir: connection.homeDir });
}

type BoxLiteClientResolver = () => Promise<BoxLiteClientPort>;

function createClientResolver(
  options: BoxLiteProviderOptions,
): BoxLiteClientResolver {
  let clientPromise: Promise<BoxLiteClientPort> | undefined;
  return () => clientPromise ??= loadBoxLiteClient(options);
}

async function collectOutput(stream: BoxLiteOutputPort): Promise<string> {
  let result = "";
  for (;;) {
    const next = await stream.next();
    if (next === null) return result;
    result += next;
  }
}

function readableOutput(
  source: Promise<BoxLiteOutputPort>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const output = await source;
        for (;;) {
          const next = await output.next();
          if (next === null) break;
          controller.enqueue(encoder.encode(next));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function envPairs(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Array<[string, string]> {
  return Object.entries(env ?? {}).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as [string, string]],
  );
}

async function executeAndCollect(
  box: BoxLiteBoxSdkPort,
  command: string,
  args: string[],
  env: Array<[string, string]>,
  timeoutSeconds: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const execution = await box.exec(
    command,
    args,
    env,
    false,
    null,
    timeoutSeconds,
    cwd,
  );
  const [stdout, stderr, result] = await Promise.all([
    execution.stdout().then(collectOutput),
    execution.stderr().then(collectOutput),
    execution.wait(),
  ]);
  return { stdout, stderr, exitCode: result.exitCode };
}

export class BoxLiteManagedRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #providerId: BoxLiteManagedProviderId;
  readonly #client: BoxLiteClientPort;
  readonly #box: BoxLiteBoxSdkPort;
  readonly #expectedName: string;
  #destroyed = false;

  constructor(input: {
    providerId: BoxLiteManagedProviderId;
    client: BoxLiteClientPort;
    box: BoxLiteBoxSdkPort;
    expectedName: string;
  }) {
    this.#providerId = input.providerId;
    this.#client = input.client;
    this.#box = input.box;
    this.#expectedName = input.expectedName;
  }

  runtimeHandle() {
    return { provider: this.#providerId, runtimeId: this.#box.id };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    const info = this.#box.info();
    if (info.state.running) return "running";
    return /stop|exit/i.test(info.state.status) ? "suspended" : "unknown";
  }

  async renewLease(): Promise<void> {
    if (await this.status() === "stopped") {
      throw new Error("BoxLite runtime has been removed");
    }
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("BoxLite retained runtime supports filesystem suspension only");
    }
    await this.#box.stop();
    return {
      provider: this.#providerId,
      checkpointId: this.#box.id,
      sourceRuntimeId: this.#box.id,
      kind: "filesystem",
      scope: "runtime",
      metadata: { ownershipName: this.#expectedName },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== this.#providerId
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#box.id
    ) {
      throw new Error("BoxLite runtime can only resume its own retained checkpoint");
    }
    await this.#box.start();
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "BoxLite native snapshots are host-local and are not advertised as portable workspace checkpoints",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await executeAndCollect(
      this.#box,
      "/bin/sh",
      ["-lc", command],
      [],
      Math.max(1, Math.ceil(timeoutMs / 1_000)),
      "/workspace",
    );
    const output = `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`
      .replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${result.exitCode}]`;
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), "openma-boxlite-read-"));
    const target = join(directory, "content");
    try {
      await this.#box.copyOut(path, target);
      return new Uint8Array(await readFile(target));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "openma-boxlite-write-"));
    const source = join(directory, "content");
    try {
      await writeFile(source, bytes);
      const parent = dirname(path);
      const mkdirResult = await executeAndCollect(
        this.#box,
        "mkdir",
        ["-p", parent],
        [],
        30,
        "/workspace",
      );
      if (mkdirResult.exitCode !== 0) {
        throw new Error(`BoxLite failed to create ${parent}: ${mkdirResult.stderr}`);
      }
      await this.#box.copyIn(source, path);
      return path;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const execution = await this.#box.exec(
      spec.command,
      spec.args === undefined ? [] : [...spec.args],
      envPairs(spec.env),
      false,
      null,
      0,
      spec.cwd ?? "/workspace",
    );
    const input = execution.stdin();
    const exited = execution.wait().then((result) => ({
      code: result.exitCode,
      signal: null,
    }));
    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await (await input).write(Buffer.from(chunk));
        },
        async close() {
          await (await input).close();
        },
        async abort() {
          await execution.kill();
        },
      }),
      stdout: readableOutput(execution.stdout()),
      stderr: readableOutput(execution.stderr()),
      exited,
      async kill(signal = "SIGTERM") {
        if (signal === "SIGTERM" && execution.signal !== undefined) {
          await execution.signal(15);
          return;
        }
        await execution.kill();
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#client.remove(this.#box.id, true);
    this.#destroyed = true;
  }
}

function validateBox(
  box: BoxLiteBoxSdkPort,
  expectedName: string,
): void {
  if (box.id === "" || box.name !== expectedName) {
    throw new Error(
      `BoxLite runtime ownership name mismatch: expected ${expectedName}, received ${String(box.name)}`,
    );
  }
}

async function ensureRunning(box: BoxLiteBoxSdkPort): Promise<void> {
  if (!box.info().state.running) await box.start();
}

async function ensureWorkspace(box: BoxLiteBoxSdkPort): Promise<void> {
  const result = await executeAndCollect(
    box,
    "mkdir",
    ["-p", "/workspace"],
    [],
    30,
    "/",
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `BoxLite failed to prepare /workspace: ${result.stderr || result.stdout}`,
    );
  }
}

function createBoxLiteProviderWithClient(
  options: BoxLiteProviderOptions,
  client: BoxLiteClientResolver,
): ProviderManagedRuntimeProviderPort<BoxLiteManagedRuntime> {
  const runtime = (
    sdk: BoxLiteClientPort,
    box: BoxLiteBoxSdkPort,
    expectedName: string,
  ) => new BoxLiteManagedRuntime({
    providerId: options.providerId,
    client: sdk,
    box,
    expectedName,
  });

  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("BoxLite managed allocation requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await client();
      const name = stableName(options.providerId, context.sessionId);
      const extra = await options.allocationOptions?.({ ...acquisition, name }) ?? {};
      acquisition.signal.throwIfAborted();
      const result = await sdk.getOrCreate({
        image: requireRuntimeEnvironmentArtifact(
          acquisition.environment,
          options.providerId,
          ["image"],
        ).reference,
        ...(options.cpus === undefined ? {} : { cpus: options.cpus }),
        ...(options.memoryMib === undefined ? {} : { memoryMib: options.memoryMib }),
        ...(options.diskSizeGb === undefined ? {} : { diskSizeGb: options.diskSizeGb }),
        ...extra,
        workingDir: "/workspace",
        autoRemove: false,
        detach: true,
      }, name);
      try {
        validateBox(result.box, name);
        await ensureRunning(result.box);
        await ensureWorkspace(result.box);
      } catch (error) {
        if (result.created) await Promise.allSettled([sdk.remove(result.box.id, true)]);
        throw error;
      }
      return runtime(sdk, result.box, name);
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== options.providerId || handle.runtimeId === "") {
        throw new Error("BoxLite provider received an incompatible runtime handle");
      }
      acquisition?.signal.throwIfAborted();
      const sdk = await client();
      const box = await sdk.get(handle.runtimeId);
      if (box === null) throw new Error(`BoxLite runtime not found: ${handle.runtimeId}`);
      const name = stableName(options.providerId, context.sessionId);
      validateBox(box, name);
      await ensureRunning(box);
      await ensureWorkspace(box);
      acquisition?.signal.throwIfAborted();
      return runtime(sdk, box, name);
    },

    async restore() {
      throw new Error(
        "BoxLite managed runtime does not advertise portable workspace restore",
      );
    },
  };
}

export function createBoxLiteProvider(
  options: BoxLiteProviderOptions,
): ProviderManagedRuntimeProviderPort<BoxLiteManagedRuntime> {
  return createBoxLiteProviderWithClient(options, createClientResolver(options));
}

export function createBoxLiteManagedRuntime(options: BoxLiteManagedRuntimeOptions) {
  const client = createClientResolver(options);
  const provider = createBoxLiteProviderWithClient(options, client);
  return createProviderManagedRuntime({
    providerName: options.providerId,
    provider,
    context: (scope: RuntimeResourceScope): SandboxFactoryContext => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: (): SandboxFactoryEnv => ({}),
    runtimeEnvironment: options.runtimeEnvironment
      ?? createPreinstalledRuntimeEnvironment({
        type: "base",
        identity: options.image,
        artifact: { type: "image", reference: options.image },
      }),
    leaseTtlMs: options.leaseTtlMs,
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
    reapRuntime: async ({ lease, context }) => {
      const sdk = await client();
      const box = await sdk.get(lease.runtimeId);
      if (box === null) return;
      validateBox(box, stableName(options.providerId, context.sessionId));
      await sdk.remove(lease.runtimeId, true);
    },
    drivers: ["ama_worker"],
  });
}

export function createBoxLiteManagedRuntimeDriver(
  options: BoxLiteManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const hasOutputs = options.outputStore !== undefined && options.outputStore !== null;
  return {
    descriptor() {
      return {
        provider: options.providerId,
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
        throw new Error(`BoxLite driver does not support ${input.placement} placement`);
      }
      const resources = createBoxLiteManagedRuntime(options);
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
