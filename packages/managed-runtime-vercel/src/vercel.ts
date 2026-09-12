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
import {
  renewVercelSandboxLease,
  type VercelCreateOptions,
  type VercelCredentials,
  type VercelNetworkPolicy,
  type VercelSandboxSdkPort,
  type VercelSdkPort,
} from "@open-managed-agents/vercel-sandbox-contract";
import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

const providerName = "vercel";

export type {
  VercelCommandFinishedPort,
  VercelCommandPort,
  VercelCreateOptions,
  VercelCredentials,
  VercelGetOrCreateOptions,
  VercelNetworkMatcher,
  VercelNetworkPolicy,
  VercelNetworkRule,
  VercelRunCommandInput,
  VercelSandboxSdkPort,
  VercelSdkPort,
} from "@open-managed-agents/vercel-sandbox-contract";

export interface VercelProviderOptions {
  client?: VercelSdkPort;
  credentials?: VercelCredentials;
  createOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
    ownershipTags: Record<string, string>;
  }): Promise<VercelCreateOptions> | VercelCreateOptions;
  networkPolicy?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<VercelNetworkPolicy> | VercelNetworkPolicy;
}

export interface VercelManagedRuntimeOptions extends VercelProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<VercelRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
  readiness?: ProviderManagedRuntimeOptions<VercelRuntime>["readiness"];
}

interface VercelModulePort {
  Sandbox: {
    getOrCreate(options: Record<string, unknown>): Promise<VercelSandboxSdkPort>;
    get(options: Record<string, unknown>): Promise<VercelSandboxSdkPort>;
  };
}

async function loadSdk(options: VercelProviderOptions): Promise<VercelSdkPort> {
  if (options.client !== undefined) return options.client;
  let module: VercelModulePort;
  try {
    module = await import(/* @vite-ignore */ "@vercel/sandbox" as string) as unknown as VercelModulePort;
  } catch (error) {
    throw new Error(`Vercel managed runtime requires '@vercel/sandbox': ${String(error)}`);
  }
  const credentials = options.credentials ?? {};
  return {
    getOrCreate: (input) => module.Sandbox.getOrCreate({ ...credentials, ...input }),
    get: (input) => module.Sandbox.get({ ...credentials, ...input }),
  };
}

type SdkResolver = () => Promise<VercelSdkPort>;

function createSdkResolver(options: VercelProviderOptions): SdkResolver {
  let promise: Promise<VercelSdkPort> | undefined;
  return () => promise ??= loadSdk(options);
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableName(sessionId: string): string {
  return `oma-${hash(sessionId, 32)}`;
}

function ownershipTags(environmentId: string, sessionId: string): Record<string, string> {
  return {
    openma: "managed",
    oma_env: hash(environmentId, 24),
    oma_session: hash(sessionId, 24),
  };
}

function validateSandbox(
  sandbox: VercelSandboxSdkPort,
  name: string,
  environmentId: string,
  sessionId: string,
): void {
  const required = ownershipTags(environmentId, sessionId);
  if (
    sandbox.name !== name
    || !sandbox.persistent
    || Object.entries(required).some(([key, value]) => sandbox.tags?.[key] !== value)
  ) {
    throw new Error(
      `Refusing to attach Vercel sandbox ${sandbox.name}: persistence or ownership tags do not match the requested environment and Session`,
    );
  }
}

function isStopped(status: string): boolean {
  return ["stopped", "failed", "aborted"].includes(status.toLowerCase());
}

async function ensureReady(sandbox: VercelSandboxSdkPort, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await sandbox.mkDir("/workspace", { signal });
  const probe = await sandbox.runCommand({
    cmd: "/usr/bin/true",
    cwd: "/",
    signal,
    timeoutMs: 30_000,
  });
  if (probe.exitCode !== 0) {
    throw new Error(`Vercel sandbox readiness probe exited with ${String(probe.exitCode)}`);
  }
  signal.throwIfAborted();
}

export class VercelRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #sandbox: VercelSandboxSdkPort;
  readonly #now: () => number;
  #destroyed = false;

  constructor(sandbox: VercelSandboxSdkPort, now: () => number = Date.now) {
    this.#sandbox = sandbox;
    this.#now = now;
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#sandbox.name };
  }

  runtimeCapabilities() {
    return { lease: true, suspend: ["filesystem" as const], checkpoint: [] };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    const status = this.#sandbox.status.toLowerCase();
    if (isStopped(status)) return status === "stopped" ? "suspended" : "stopped";
    if (["running", "pending", "snapshotting", "stopping"].includes(status)) return "running";
    return "unknown";
  }

  async renewLease(input: { ttlMs: number }): Promise<void> {
    if (this.#destroyed) {
      throw new Error("Vercel sandbox is no longer available");
    }
    await renewVercelSandboxLease({
      sandbox: this.#sandbox,
      ttlMs: input.ttlMs,
      now: this.#now,
    });
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("Vercel managed runtime only retains filesystem state");
    }
    const sync = await this.#sandbox.runCommand({
      cmd: "/bin/sync",
      cwd: "/",
      timeoutMs: 60_000,
    });
    if (sync.exitCode !== 0) throw new Error("Vercel sandbox sync failed");
    const stopped = await this.#sandbox.stop();
    const snapshotId = stopped.snapshot?.id ?? this.#sandbox.currentSnapshotId ?? this.#sandbox.name;
    return {
      provider: providerName,
      checkpointId: snapshotId,
      sourceRuntimeId: this.#sandbox.name,
      kind: "filesystem",
      scope: "runtime",
      metadata: { ownershipName: this.#sandbox.name, persistence: "provider-auto" },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== providerName
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#sandbox.name
    ) {
      throw new Error("Vercel runtime can only resume its own retained filesystem");
    }
    await ensureReady(this.#sandbox, new AbortController().signal);
  }

  async checkpoint(): Promise<SandboxCheckpointHandle> {
    throw new Error(
      "Vercel persistent snapshots are not promoted to portable OpenMA workspace checkpoints",
    );
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await this.#sandbox.runCommand({
      cmd: "/bin/sh",
      args: ["-lc", command],
      cwd: "/workspace",
      timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    const output = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${String(result.exitCode)}]`;
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.#sandbox.readFileToBuffer({ path });
    if (bytes === null) throw new Error(`Vercel sandbox file not found: ${path}`);
    return new TextDecoder().decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.#sandbox.readFileToBuffer({ path });
    if (bytes === null) throw new Error(`Vercel sandbox file not found: ${path}`);
    return new Uint8Array(bytes);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#sandbox.writeFiles([{ path, content }]);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#sandbox.writeFiles([{ path, content: bytes }]);
    return path;
  }

  async updateNetworkPolicy(
    policy: VercelNetworkPolicy,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.#sandbox.updateNetworkPolicy(policy, options);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const command = await this.#sandbox.runCommand({
      cmd: spec.command,
      ...(spec.args === undefined ? {} : { args: [...spec.args] }),
      cwd: spec.cwd ?? "/workspace",
      ...(spec.env === undefined ? {} : {
        env: Object.fromEntries(
          Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      }),
      detached: true,
      stdout,
      stderr,
    });
    const exited = command.wait().then(
      (result) => {
        stdout.end();
        stderr.end();
        return { code: result.exitCode, signal: null };
      },
      (error: unknown) => {
        stdout.destroy(error instanceof Error ? error : new Error(String(error)));
        stderr.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
      },
    );
    return {
      stdin: new WritableStream<Uint8Array>({
        write() {
          throw new Error("Vercel Sandbox command API does not expose streaming stdin");
        },
      }),
      stdout: Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(stderr) as unknown as ReadableStream<Uint8Array>,
      exited,
      async kill(signal = "SIGTERM") {
        await command.kill(signal);
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#sandbox.delete({ deleteOrphanSnapshots: true });
    this.#destroyed = true;
  }
}

function createProviderWithSdk(
  options: VercelProviderOptions,
  resolveSdk: SdkResolver,
): ProviderManagedRuntimeProviderPort<VercelRuntime> {
  return {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("Vercel managed allocation requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      const name = stableName(context.sessionId);
      const tags = ownershipTags(acquisition.scope.environmentId, acquisition.scope.sessionId);
      const [extra, policy] = await Promise.all([
        options.createOptions?.({ ...acquisition, name, ownershipTags: tags }) ?? {},
        options.networkPolicy?.({ ...acquisition, name }) ?? "deny-all",
      ]);
      const sandbox = await sdk.getOrCreate({
        ...extra,
        name,
        persistent: true,
        resume: true,
        tags,
        networkPolicy: policy,
        signal: acquisition.signal,
      });
      validateSandbox(
        sandbox,
        name,
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      // getOrCreate may return an existing sandbox. Reapply policy before any
      // untrusted process starts so a prior generation cannot retain access.
      await sandbox.updateNetworkPolicy(policy, { signal: acquisition.signal });
      await ensureReady(sandbox, acquisition.signal);
      return new VercelRuntime(sandbox);
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Vercel provider received an incompatible runtime handle");
      }
      if (acquisition === undefined) {
        throw new Error("Vercel managed resume requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await resolveSdk();
      const sandbox = await sdk.get({
        name: handle.runtimeId,
        resume: true,
        signal: acquisition.signal,
      });
      validateSandbox(
        sandbox,
        stableName(context.sessionId),
        acquisition.scope.environmentId,
        acquisition.scope.sessionId,
      );
      const policy = await options.networkPolicy?.({
        ...acquisition,
        name: handle.runtimeId,
      }) ?? "deny-all";
      await sandbox.updateNetworkPolicy(policy, { signal: acquisition.signal });
      await ensureReady(sandbox, acquisition.signal);
      return new VercelRuntime(sandbox);
    },

    async restore() {
      throw new Error("Vercel managed runtime does not advertise portable workspace restore");
    },
  };
}

export function createVercelProvider(
  options: VercelProviderOptions,
): ProviderManagedRuntimeProviderPort<VercelRuntime> {
  return createProviderWithSdk(options, createSdkResolver(options));
}

export function createVercelManagedRuntime(options: VercelManagedRuntimeOptions) {
  const resolveSdk = createSdkResolver(options);
  const provider = createProviderWithSdk(options, resolveSdk);
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
      const sdk = await resolveSdk();
      let sandbox: VercelSandboxSdkPort;
      try {
        sandbox = await sdk.get({ name: lease.runtimeId, resume: false });
      } catch (error) {
        if (error instanceof Error && /not[_ -]?found|404/i.test(error.message)) return;
        throw error;
      }
      validateSandbox(
        sandbox,
        stableName(scope.sessionId),
        scope.environmentId,
        scope.sessionId,
      );
      await sandbox.delete({ deleteOrphanSnapshots: true });
    },
    drivers: ["ama_worker"],
  });
}

export function createVercelManagedRuntimeDriver(
  options: VercelManagedRuntimeOptions,
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
          harness: { drivers: ["ama_worker"] },
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
        throw new Error(`Vercel driver does not support ${input.placement} placement`);
      }
      const resources = createVercelManagedRuntime(options);
      return {
        sandbox: resources.sandbox,
        workspace: resources.workspace,
        outputs: resources.outputs,
        harnessDriver: resources.harness,
        ...(resources.credentialEgress === undefined
          ? {}
          : { credentialEgress: resources.credentialEgress }),
        sessionInputs: options.sessionInputs ?? resources.sessionInputs,
      };
    },
  };
}
