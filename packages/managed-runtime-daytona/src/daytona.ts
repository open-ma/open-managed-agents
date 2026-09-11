import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import { Buffer } from "node:buffer";
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
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";

import {
  createProviderManagedRuntime,
  type ProviderManagedRuntimeOptions,
} from "@open-managed-agents/managed-runtime-sandbox";

const providerName = "daytona";
const environmentLabel = "openma.environment_id";
const sessionLabel = "openma.session_id";
const modeLabel = "openma.mode";
const managedMode = "managed";

interface DaytonaExecuteResponse {
  exitCode?: number;
  result?: string;
  artifacts?: { stdout?: string; stderr?: string };
}

interface DaytonaCommand {
  id: string;
  command: string;
  exitCode?: number;
}

interface DaytonaProcessPort {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecuteResponse>;
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync: true; suppressInputEcho: true },
    timeout?: number,
  ): Promise<{ cmdId: string }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  getSessionCommand(sessionId: string, commandId: string): Promise<DaytonaCommand>;
  sendSessionCommandInput(
    sessionId: string,
    commandId: string,
    data: string,
  ): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

interface DaytonaFilesystemPort {
  uploadFile(bytes: Uint8Array, path: string, timeout?: number): Promise<void>;
  downloadFile(path: string, timeout?: number): Promise<Uint8Array>;
  createFolder(path: string, mode?: string): Promise<void>;
}

export interface DaytonaSandboxSdkPort {
  readonly id: string;
  readonly name: string;
  state?: string;
  labels?: Record<string, string>;
  readonly fs: DaytonaFilesystemPort;
  readonly process: DaytonaProcessPort;
  refreshData(): Promise<void>;
  refreshActivity(): Promise<void>;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  setLabels(labels: Record<string, string>): Promise<unknown>;
  createSnapshot?(name: string, timeout?: number): Promise<void>;
  _experimental_createSnapshot?(name: string, timeout?: number): Promise<void>;
}

export interface DaytonaClientPort {
  get(idOrName: string): Promise<DaytonaSandboxSdkPort>;
  create(input: Readonly<Record<string, unknown>>, options?: { timeout?: number }): Promise<DaytonaSandboxSdkPort>;
}

export interface DaytonaManagedRuntimeOptions {
  leaseTtlMs: number;
  client?: DaytonaClientPort;
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
  image?: string;
  autoStopInterval?: number;
  autoPauseInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
  outboundProxyUrl?: string;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<DaytonaRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<DaytonaRuntime>["readiness"];
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if ("status" in error && typeof error.status === "number") return error.status;
  if (
    "response" in error
    && typeof error.response === "object"
    && error.response !== null
    && "status" in error.response
    && typeof error.response.status === "number"
  ) return error.response.status;
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404
    || (error instanceof Error && error.name === "DaytonaNotFoundError");
}

function isConflict(error: unknown): boolean {
  return errorStatus(error) === 409
    || (error instanceof Error && error.name === "DaytonaConflictError");
}

async function loadDaytonaClient(
  options: Pick<DaytonaManagedRuntimeOptions, "apiKey" | "apiUrl" | "target">,
): Promise<DaytonaClientPort> {
  let module: { Daytona: new (input: Record<string, unknown>) => DaytonaClientPort };
  try {
    module = await import(/* @vite-ignore */ "@daytona/sdk" as string) as typeof module;
  } catch (currentError) {
    try {
      module = await import(/* @vite-ignore */ "@daytonaio/sdk" as string) as typeof module;
    } catch (legacyError) {
      throw new Error(
        "Daytona provider requires '@daytona/sdk' (the deprecated '@daytonaio/sdk' is accepted during migration)",
        { cause: { currentError, legacyError } },
      );
    }
  }
  return new module.Daytona({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.target === undefined ? {} : { target: options.target }),
  });
}

function safeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96);
  if (normalized.length === 0) throw new Error("Daytona sandbox name must not be empty");
  return normalized;
}

function sandboxName(sessionId: string): string {
  return safeName(`openma-${sessionId}`);
}

function checkpointSandboxName(sessionId: string, checkpointId: string): string {
  return safeName(`openma-${sessionId}-${checkpointId}`);
}

function expectedLabels(environmentId: string, sessionId: string) {
  return {
    [environmentLabel]: environmentId,
    [sessionLabel]: sessionId,
    [modeLabel]: managedMode,
  };
}

async function validateManagedSandbox(
  sandbox: DaytonaSandboxSdkPort,
  environmentId: string,
  sessionId: string,
): Promise<void> {
  await sandbox.refreshData();
  const labels = sandbox.labels ?? {};
  if (
    labels[environmentLabel] !== environmentId
    || labels[sessionLabel] !== sessionId
    || labels[modeLabel] !== managedMode
  ) {
    throw new Error(
      `Refusing to attach Daytona sandbox ${sandbox.id}: ownership labels do not match the requested environment and Session`,
    );
  }
}

async function ensureStarted(sandbox: DaytonaSandboxSdkPort): Promise<void> {
  await sandbox.refreshData();
  if (["stopped", "archived", "paused"].includes(sandbox.state ?? "")) {
    await sandbox.start(300);
  }
}

function creationParameters(
  options: DaytonaManagedRuntimeOptions,
  name: string,
  labels: Record<string, string>,
  checkpoint?: SandboxCheckpointHandle,
): Readonly<Record<string, unknown>> {
  return {
    name,
    ...(checkpoint !== undefined
      ? { snapshot: checkpoint.checkpointId }
      : options.snapshot !== undefined
        ? { snapshot: options.snapshot }
        : { image: options.image ?? "node:22-slim" }),
    labels,
    ...(options.autoStopInterval === undefined
      ? {}
      : { autoStopInterval: options.autoStopInterval }),
    ...(options.autoPauseInterval === undefined
      ? {}
      : { autoPauseInterval: options.autoPauseInterval }),
    ...(options.autoArchiveInterval === undefined
      ? {}
      : { autoArchiveInterval: options.autoArchiveInterval }),
    ...(options.autoDeleteInterval === undefined
      ? {}
      : { autoDeleteInterval: options.autoDeleteInterval }),
    ...(options.networkBlockAll === undefined
      ? {}
      : { networkBlockAll: options.networkBlockAll }),
    ...(options.networkAllowList === undefined
      ? {}
      : { networkAllowList: options.networkAllowList }),
    ...(options.domainAllowList === undefined
      ? {}
      : { domainAllowList: options.domainAllowList }),
    ...(options.outboundProxyUrl === undefined
      ? {}
      : { outboundProxyUrl: options.outboundProxyUrl }),
  };
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLine(spec: SandboxDuplexProcessSpec): string {
  const executable = [spec.command, ...(spec.args ?? [])].map(shellToken).join(" ");
  const environment = Object.entries(spec.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${shellToken(value)}`)
    .join(" ");
  const invocation = environment === "" ? executable : `env ${environment} ${executable}`;
  return spec.cwd === undefined
    ? invocation
    : `cd ${shellToken(spec.cwd)} && ${invocation}`;
}

export class DaytonaRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #sandbox: DaytonaSandboxSdkPort;
  readonly #environmentId: string;
  readonly #sessionId: string;
  #destroyed = false;

  constructor(input: {
    sandbox: DaytonaSandboxSdkPort;
    environmentId: string;
    sessionId: string;
  }) {
    this.#sandbox = input.sandbox;
    this.#environmentId = input.environmentId;
    this.#sessionId = input.sessionId;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sandbox.id };
  }

  runtimeCapabilities() {
    return { lease: true, suspend: ["filesystem" as const], checkpoint: ["filesystem" as const] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    await this.#sandbox.refreshData();
    switch (this.#sandbox.state) {
      case "started":
        return "running";
      case "stopped":
      case "archived":
      case "paused":
        return "suspended";
      case "destroyed":
      case "destroying":
        return "stopped";
      default:
        return "unknown";
    }
  }

  async renewLease(): Promise<void> {
    await this.#sandbox.refreshActivity();
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Daytona retained runtime only exposes a filesystem checkpoint");
    }
    await this.#sandbox.stop(300);
    return {
      provider: providerName,
      checkpointId: this.#sandbox.id,
      sourceRuntimeId: this.#sandbox.id,
      kind: "filesystem",
      scope: "runtime",
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#sandbox.id
    ) throw new Error("Incompatible Daytona retained-runtime checkpoint");
    await ensureStarted(this.#sandbox);
  }

  async checkpoint(input: {
    kind: "filesystem" | "memory";
    name?: string;
  }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Daytona portable checkpoints currently capture the filesystem only");
    }
    const name = safeName(
      input.name ?? `openma-${this.#sessionId}-${Date.now().toString(36)}`,
    );
    if (this.#sandbox.createSnapshot !== undefined) {
      await this.#sandbox.createSnapshot(name, 300);
    } else if (this.#sandbox._experimental_createSnapshot !== undefined) {
      await this.#sandbox._experimental_createSnapshot(name, 300);
    } else {
      throw new Error("Installed Daytona SDK does not expose sandbox snapshots");
    }
    return {
      provider: providerName,
      checkpointId: name,
      sourceRuntimeId: this.#sandbox.id,
      kind: "filesystem",
      scope: "portable",
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const result = await this.#sandbox.process.executeCommand(
      command,
      undefined,
      undefined,
      timeout === undefined ? undefined : Math.max(1, Math.ceil(timeout / 1_000)),
    );
    const stdout = result.artifacts?.stdout ?? result.result ?? "";
    const stderr = result.artifacts?.stderr ?? "";
    return `${stdout}${stderr === "" ? "" : `\n${stderr}`}${
      result.exitCode === undefined || result.exitCode === 0
        ? ""
        : `\n[exit ${result.exitCode}]`
    }`.replace(/\s+$/g, "");
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#sandbox.fs.downloadFile(path));
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Promise.allSettled([
        this.#sandbox.fs.createFolder(path.slice(0, slash), "0755"),
      ]);
    }
    await this.#sandbox.fs.uploadFile(Buffer.from(bytes), path);
    return path;
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const process = this.#sandbox.process;
    const sessionId = safeName(`openma-${crypto.randomUUID()}`);
    await process.createSession(sessionId);
    const started = await process.executeSessionCommand(sessionId, {
      command: commandLine(spec),
      runAsync: true,
      suppressInputEcho: true,
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    let killed: "SIGTERM" | "SIGKILL" | null = null;
    const logs = process.getSessionCommandLogs(
      sessionId,
      started.cmdId,
      (chunk) => {
        stdoutController.enqueue(encoder.encode(chunk));
      },
      (chunk) => {
        stderrController.enqueue(encoder.encode(chunk));
      },
    );
    const exited = (async () => {
      try {
        await logs;
        for (;;) {
          const command = await process.getSessionCommand(sessionId, started.cmdId);
          if (command.exitCode !== undefined) {
            return { code: command.exitCode, signal: null };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        if (killed !== null) return { code: null, signal: killed };
        throw error;
      } finally {
        await Promise.allSettled([process.deleteSession(sessionId)]);
        stdoutController.close();
        stderrController.close();
      }
    })();
    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await process.sendSessionCommandInput(
            sessionId,
            started.cmdId,
            decoder.decode(chunk, { stream: true }),
          );
        },
        async close() {
          const trailing = decoder.decode();
          if (trailing !== "") {
            await process.sendSessionCommandInput(sessionId, started.cmdId, trailing);
          }
        },
      }),
      stdout,
      stderr,
      async kill(signal = "SIGTERM") {
        if (killed !== null) return;
        killed = signal;
        await process.deleteSession(sessionId);
      },
      exited,
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#sandbox.delete(300, true);
    this.#destroyed = true;
  }

  async validateOwnership(): Promise<void> {
    await validateManagedSandbox(this.#sandbox, this.#environmentId, this.#sessionId);
  }
}

async function managedSandbox(
  client: DaytonaClientPort,
  options: DaytonaManagedRuntimeOptions,
  environmentId: string,
  sessionId: string,
): Promise<DaytonaRuntime> {
  const name = sandboxName(sessionId);
  let sandbox: DaytonaSandboxSdkPort;
  try {
    sandbox = await client.get(name);
    await validateManagedSandbox(sandbox, environmentId, sessionId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      sandbox = await client.create(
        creationParameters(options, name, expectedLabels(environmentId, sessionId)),
        { timeout: 300 },
      );
    } catch (createError) {
      if (!isConflict(createError)) throw createError;
      sandbox = await client.get(name);
      await validateManagedSandbox(sandbox, environmentId, sessionId);
    }
  }
  await ensureStarted(sandbox);
  return new DaytonaRuntime({ sandbox, environmentId, sessionId });
}

export function createDaytonaProvider(
  client: DaytonaClientPort,
  options: DaytonaManagedRuntimeOptions,
  environmentId: string,
): SandboxProviderPort<DaytonaRuntime> {
  return {
    create: async (context) =>
      managedSandbox(client, options, environmentId, context.sessionId),
    resume: async (handle, context) => {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Daytona provider received an incompatible runtime handle");
      }
      const sandbox = await client.get(handle.runtimeId);
      await validateManagedSandbox(sandbox, environmentId, context.sessionId);
      await ensureStarted(sandbox);
      return new DaytonaRuntime({
        sandbox,
        environmentId,
        sessionId: context.sessionId,
      });
    },
    restore: async (checkpoint, context) => {
      if (
        checkpoint.provider !== providerName
        || checkpoint.kind !== "filesystem"
        || checkpoint.scope !== "portable"
      ) throw new Error("Daytona provider received an incompatible workspace checkpoint");
      const name = checkpointSandboxName(context.sessionId, checkpoint.checkpointId);
      const labels = expectedLabels(environmentId, context.sessionId);
      let sandbox: DaytonaSandboxSdkPort;
      try {
        sandbox = await client.create(
          creationParameters(options, name, labels, checkpoint),
          { timeout: 300 },
        );
      } catch (error) {
        if (!isConflict(error)) throw error;
        sandbox = await client.get(name);
        await validateManagedSandbox(sandbox, environmentId, context.sessionId);
      }
      await ensureStarted(sandbox);
      return new DaytonaRuntime({
        sandbox,
        environmentId,
        sessionId: context.sessionId,
      });
    },
  };
}

export async function createDaytonaManagedRuntime(
  options: DaytonaManagedRuntimeOptions & { environmentId: string },
) {
  const client = options.client ?? await loadDaytonaClient(options);
  return createProviderManagedRuntime({
    providerName,
    provider: createDaytonaProvider(client, options, options.environmentId),
    context: (scope: RuntimeResourceScope) => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: () => ({}),
    leaseTtlMs: options.leaseTtlMs,
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      retainedSuspendKind: "filesystem",
      portableCheckpointKind: "filesystem",
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
      const sandbox = await client.get(lease.runtimeId);
      await validateManagedSandbox(sandbox, options.environmentId, context.sessionId);
      await sandbox.delete(300, true);
    },
    drivers: ["ama_worker"],
  });
}

/** Daytona implementation of the provider-neutral Managed Runtime driver. */
export function createDaytonaManagedRuntimeDriver(
  options: DaytonaManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const hasOutputStore = options.outputStore !== undefined && options.outputStore !== null;
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
          workspace: {
            strategies: ["retained_runtime", "checkpoint_restore"],
          },
          outputs: {
            strategies: hasOutputStore
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
        throw new Error(`Daytona does not support ${input.placement} placement`);
      }
      const runtime = await createDaytonaManagedRuntime({
        ...options,
        environmentId: input.environmentId,
      });
      return {
        sandbox: runtime.sandbox,
        workspace: runtime.workspace,
        outputs: runtime.outputs,
        harnessDriver: runtime.harness,
        supervisorTransport: runtime.supervisorTransport,
        ...(runtime.credentialEgress === undefined
          ? {}
          : { credentialEgress: runtime.credentialEgress }),
        ...(options.sessionInputs === undefined
          ? {}
          : { sessionInputs: options.sessionInputs }),
      };
    },
  };
}
