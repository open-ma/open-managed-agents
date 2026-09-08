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

const providerName = "modal";

export interface ModalFilesystemPort {
  makeDirectory(path: string, options?: { createParents?: boolean }): Promise<void>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(data: string, path: string): Promise<void>;
  writeBytes(data: Uint8Array | ArrayBuffer, path: string): Promise<void>;
}

export interface ModalProcessPort {
  readonly stdin: WritableStream<string>;
  readonly stdout: ReadableStream<string>;
  readonly stderr: ReadableStream<string>;
  wait(): Promise<number>;
}

export interface ModalNetworkPolicy {
  outboundDomainAllowlist: string[];
  outboundCidrAllowlist: string[];
}

export interface ModalSandboxSdkPort {
  readonly sandboxId: string;
  readonly filesystem: ModalFilesystemPort;
  exec(
    command: string[],
    options?: {
      mode?: "text";
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore";
      workdir?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      pty?: boolean;
    },
  ): Promise<ModalProcessPort>;
  poll(): Promise<number | null>;
  getTags(): Promise<Record<string, string>>;
  setTags(tags: Record<string, string>): Promise<void>;
  updateNetworkPolicy(policy: ModalNetworkPolicy): Promise<void>;
  detach(): void;
  terminate(): Promise<void>;
}

export interface ModalSandboxCreateOptions {
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  gpu?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  encryptedPorts?: number[];
  h2Ports?: number[];
  unencryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
  inboundCidrAllowlist?: string[];
  cloud?: string;
  regions?: string[];
  includeOidcIdentityToken?: boolean;
  experimentalEnableSnapshot?: boolean;
}

export interface ModalCreateInput {
  appName: string;
  image: string;
  name: string;
  tags: Record<string, string>;
  workspace: {
    volumeName: string;
    mountPath: "/workspace";
    subPath: string;
  };
  options: ModalSandboxCreateOptions & { workdir: "/workspace" };
}

export interface ModalSdkPort {
  findByName(input: { appName: string; name: string }): Promise<ModalSandboxSdkPort | null>;
  create(input: ModalCreateInput): Promise<ModalSandboxSdkPort>;
  fromId(sandboxId: string): Promise<ModalSandboxSdkPort>;
}

export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
  environment?: string;
  endpoint?: string;
}

export interface ModalProviderOptions {
  client?: ModalSdkPort;
  credentials?: ModalCredentials;
  appName: string;
  image: string;
  /** Must name a pre-created Volume v2. The adapter never implicitly creates
   * a legacy Volume because that would weaken the configured durability. */
  workspaceVolumeName: string;
  createOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
    ownershipTags: Record<string, string>;
    workspaceSubPath: string;
  }): Promise<ModalSandboxCreateOptions> | ModalSandboxCreateOptions;
}

export interface ModalManagedRuntimeOptions extends ModalProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<ModalRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<ModalRuntime>["readiness"];
}

interface OfficialVolumePort {
  withMountOptions(options: { subPath: string }): unknown;
}

interface OfficialModalClientPort {
  apps: { fromName(name: string, options: { createIfMissing: boolean }): Promise<unknown> };
  images: { fromRegistry(image: string): unknown };
  volumes: {
    fromName(name: string, options: { createIfMissing: boolean }): Promise<OfficialVolumePort>;
  };
  sandboxes: {
    create(app: unknown, image: unknown, options: Record<string, unknown>): Promise<ModalSandboxSdkPort>;
    fromName(appName: string, name: string): Promise<ModalSandboxSdkPort>;
    fromId(sandboxId: string): Promise<ModalSandboxSdkPort>;
  };
}

interface ModalModulePort {
  ModalClient: new (options?: ModalCredentials) => OfficialModalClientPort;
}

function isNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? String(error.name) : "";
    if (/NotFound/i.test(name)) return true;
  }
  return error instanceof Error && /not[ _-]?found|404/i.test(error.message);
}

function isConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? String(error.name) : "";
    if (/AlreadyExists|Conflict/i.test(name)) return true;
  }
  return error instanceof Error && /already exists|conflict/i.test(error.message);
}

async function loadSdk(options: ModalProviderOptions): Promise<ModalSdkPort> {
  if (options.client !== undefined) return options.client;
  let module: ModalModulePort;
  try {
    module = await import(/* @vite-ignore */ "modal" as string) as unknown as ModalModulePort;
  } catch (error) {
    throw new Error(`Modal managed runtime requires 'modal': ${String(error)}`);
  }
  const client = new module.ModalClient(options.credentials);
  return {
    async findByName(input) {
      try {
        return await client.sandboxes.fromName(input.appName, input.name);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async create(input) {
      const [app, volume] = await Promise.all([
        client.apps.fromName(input.appName, { createIfMissing: true }),
        client.volumes.fromName(input.workspace.volumeName, { createIfMissing: false }),
      ]);
      const image = client.images.fromRegistry(input.image);
      return client.sandboxes.create(app, image, {
        ...input.options,
        name: input.name,
        tags: input.tags,
        workdir: input.workspace.mountPath,
        volumes: {
          [input.workspace.mountPath]: volume.withMountOptions({
            subPath: input.workspace.subPath,
          }),
        },
      });
    },
    fromId: (sandboxId) => client.sandboxes.fromId(sandboxId),
  };
}

type SdkResolver = () => Promise<ModalSdkPort>;

function createSdkResolver(options: ModalProviderOptions): SdkResolver {
  let promise: Promise<ModalSdkPort> | undefined;
  return () => promise ??= loadSdk(options);
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableName(sessionId: string): string {
  return `oma-${hash(sessionId, 32)}`;
}

function workspaceSubPath(environmentId: string, sessionId: string): string {
  return `sessions/${hash(`${environmentId}:${sessionId}`, 48)}`;
}

function ownershipTags(environmentId: string, sessionId: string): Record<string, string> {
  return {
    openma: "managed",
    oma_env: hash(environmentId, 24),
    oma_session: hash(sessionId, 24),
  };
}

async function validateSandbox(
  sandbox: ModalSandboxSdkPort,
  environmentId: string,
  sessionId: string,
): Promise<void> {
  const tags = await sandbox.getTags();
  const required = ownershipTags(environmentId, sessionId);
  if (Object.entries(required).some(([key, value]) => tags[key] !== value)) {
    throw new Error(
      `Refusing to attach Modal sandbox ${sandbox.sandboxId}: ownership tags do not match the requested environment and Session`,
    );
  }
}

async function drainText(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result;
      result += next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function runChecked(
  sandbox: ModalSandboxSdkPort,
  command: string[],
  options?: { workdir?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = await sandbox.exec(command, {
    mode: "text",
    stdout: "pipe",
    stderr: "pipe",
    ...options,
  });
  const [code, stdout, stderr] = await Promise.all([
    process.wait(),
    drainText(process.stdout),
    drainText(process.stderr),
  ]);
  return { code, stdout, stderr };
}

async function ensureReady(sandbox: ModalSandboxSdkPort, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await sandbox.filesystem.makeDirectory("/workspace", { createParents: true });
  const probe = await runChecked(sandbox, ["/usr/bin/true"], {
    workdir: "/",
    timeoutMs: 30_000,
  });
  if (probe.code !== 0) {
    throw new Error(`Modal sandbox readiness probe failed: ${probe.stderr || probe.stdout}`);
  }
  signal.throwIfAborted();
}

async function fenceNetworkBeforeReadiness(
  sandbox: ModalSandboxSdkPort,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await sandbox.updateNetworkPolicy({
    outboundDomainAllowlist: [],
    outboundCidrAllowlist: [],
  });
  signal.throwIfAborted();
}

function toByteStream(stream: ReadableStream<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return stream.pipeThrough(new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(chunk));
    },
  }));
}

export class ModalRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #sandbox: ModalSandboxSdkPort;
  #detached = false;
  #destroyed = false;

  constructor(sandbox: ModalSandboxSdkPort) {
    this.#sandbox = sandbox;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sandbox.sandboxId };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    if (this.#detached) return "suspended";
    try {
      return await this.#sandbox.poll() === null ? "running" : "stopped";
    } catch (error) {
      return isNotFound(error) ? "stopped" : "unknown";
    }
  }

  async renewLease(): Promise<void> {
    if (await this.status() !== "running") throw new Error("Modal sandbox is no longer running");
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Modal managed runtime only persists the mounted workspace Volume");
    }
    const sync = await runChecked(this.#sandbox, ["/bin/sync", "/workspace"], {
      workdir: "/",
      timeoutMs: 60_000,
    });
    if (sync.code !== 0) throw new Error(`Modal Volume sync failed: ${sync.stderr}`);
    this.#sandbox.detach();
    this.#detached = true;
    return {
      provider: providerName,
      checkpointId: this.#sandbox.sandboxId,
      sourceRuntimeId: this.#sandbox.sandboxId,
      kind: "filesystem",
      scope: "runtime",
      metadata: { workspace: "modal-volume-v2" },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#sandbox.sandboxId
    ) {
      throw new Error("Modal runtime can only resume its own retained workspace");
    }
    this.#detached = false;
    await ensureReady(this.#sandbox, new AbortController().signal);
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "Modal Volume persistence is not promoted to a portable OpenMA workspace checkpoint",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await runChecked(this.#sandbox, ["/bin/sh", "-lc", command], {
      workdir: "/workspace",
      timeoutMs,
    });
    const output = `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`.replace(/\s+$/g, "");
    return result.code === 0 ? output : `${output}\n[exit ${String(result.code)}]`;
  }

  readFile(path: string): Promise<string> {
    return this.#sandbox.filesystem.readText(path);
  }

  readFileBytes(path: string): Promise<Uint8Array> {
    return this.#sandbox.filesystem.readBytes(path);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#sandbox.filesystem.writeText(content, path);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#sandbox.filesystem.writeBytes(bytes, path);
    return path;
  }

  async updateNetworkPolicy(policy: ModalNetworkPolicy): Promise<void> {
    await this.#sandbox.updateNetworkPolicy(policy);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const process = await this.#sandbox.exec(
      [spec.command, ...(spec.args ?? [])],
      {
        mode: "text",
        stdout: "pipe",
        stderr: "pipe",
        workdir: spec.cwd ?? "/workspace",
        ...(spec.env === undefined ? {} : {
          env: Object.fromEntries(
            Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        }),
      },
    );
    const decoder = new TextDecoder();
    const writer = process.stdin.getWriter();
    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await writer.write(decoder.decode(chunk, { stream: true }));
        },
        async close() {
          const tail = decoder.decode();
          if (tail !== "") await writer.write(tail);
          await writer.close();
        },
        async abort(reason) {
          await writer.abort(reason);
        },
      }),
      stdout: toByteStream(process.stdout),
      stderr: toByteStream(process.stderr),
      exited: process.wait().then((code) => ({ code, signal: null })),
      kill: async () => {
        await this.#sandbox.terminate();
        this.#destroyed = true;
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#sandbox.terminate();
    this.#destroyed = true;
  }
}

async function acquireSandbox(
  options: ModalProviderOptions,
  resolveSdk: SdkResolver,
  context: SandboxFactoryContext,
  acquisition: ProviderManagedRuntimeAcquisitionContext,
): Promise<ModalSandboxSdkPort> {
  acquisition.signal.throwIfAborted();
  const sdk = await resolveSdk();
  const name = stableName(context.sessionId);
  const tags = ownershipTags(acquisition.scope.environmentId, acquisition.scope.sessionId);
  let sandbox = await sdk.findByName({ appName: options.appName, name });
  if (sandbox === null) {
    const extra = await options.createOptions?.({
      ...acquisition,
      name,
      ownershipTags: tags,
      workspaceSubPath: workspaceSubPath(
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      ),
    }) ?? {};
    try {
      sandbox = await sdk.create({
        appName: options.appName,
        image: options.image,
        name,
        tags,
        workspace: {
          volumeName: options.workspaceVolumeName,
          mountPath: "/workspace",
          subPath: workspaceSubPath(
            acquisition.scope.environmentId,
            acquisition.scope.sessionId,
          ),
        },
        options: {
          ...extra,
          workdir: "/workspace",
          ...(extra.outboundDomainAllowlist === undefined
              && extra.outboundCidrAllowlist === undefined
            ? { blockNetwork: true }
            : { blockNetwork: false }),
        },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      sandbox = await sdk.findByName({ appName: options.appName, name });
      if (sandbox === null) throw error;
    }
  }
  await validateSandbox(
    sandbox,
    acquisition.scope.environmentId,
    acquisition.scope.sessionId,
  );
  // A named sandbox may belong to a previous generation. Close egress before
  // any readiness command or harness process can run; the fenced credential
  // binding reopens only its declared destinations afterwards.
  await fenceNetworkBeforeReadiness(sandbox, acquisition.signal);
  await ensureReady(sandbox, acquisition.signal);
  return sandbox;
}

function createProviderWithSdk(
  options: ModalProviderOptions,
  resolveSdk: SdkResolver,
): ProviderManagedRuntimeProviderPort<ModalRuntime> {
  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("Modal managed allocation requires acquisition context");
      }
      return new ModalRuntime(await acquireSandbox(options, resolveSdk, context, acquisition));
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Modal provider received an incompatible runtime handle");
      }
      if (acquisition === undefined) {
        throw new Error("Modal managed resume requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      try {
        const sandbox = await sdk.fromId(handle.runtimeId);
        await validateSandbox(
          sandbox,
          acquisition.scope.environmentId,
          acquisition.scope.sessionId,
        );
        await fenceNetworkBeforeReadiness(sandbox, acquisition.signal);
        await ensureReady(sandbox, acquisition.signal);
        return new ModalRuntime(sandbox);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        // A Modal Sandbox may have reached idle/max lifetime. The Volume is the
        // durable resource; recreate compute against the same Session subpath.
        return new ModalRuntime(
          await acquireSandbox(options, resolveSdk, context, acquisition),
        );
      }
    },

    async restore() {
      throw new Error("Modal managed runtime does not advertise portable workspace restore");
    },
  };
}

export function createModalProvider(
  options: ModalProviderOptions,
): ProviderManagedRuntimeProviderPort<ModalRuntime> {
  return createProviderWithSdk(options, createSdkResolver(options));
}

export function createModalManagedRuntime(options: ModalManagedRuntimeOptions) {
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
      let sandbox: ModalSandboxSdkPort;
      try {
        sandbox = await sdk.fromId(lease.runtimeId);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      await validateSandbox(sandbox, scope.environmentId, scope.sessionId);
      await sandbox.terminate();
    },
    drivers: ["ama_worker"],
  });
}

export function createModalManagedRuntimeDriver(
  options: ModalManagedRuntimeOptions,
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
        throw new Error(`Modal driver does not support ${input.placement} placement`);
      }
      const resources = createModalManagedRuntime(options);
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
