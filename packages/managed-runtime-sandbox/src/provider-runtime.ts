import type {
  HarnessDriverType,
  HarnessSupervisorChannel,
  HarnessSupervisorCommand,
  HarnessSupervisorEvent,
  HarnessSupervisorTransportPort,
  ManagedSandboxLease,
  ManagedSandboxPort,
  RuntimeResourceScope,
  RuntimeResourceFence,
  SandboxHarnessDriverPort,
  SandboxResourceCapabilities,
  SessionOutputBinding,
  SessionOutputEntryCandidate,
  SessionOutputManifestCandidate,
  SessionOutputPort,
  WorkspaceBinding,
  WorkspaceCheckpointCandidate,
  WorkspacePersistencePort,
  WorkspaceStrategy,
  RuntimeCheckpointKind,
  RuntimeCheckpointPort,
  RuntimeCheckpointRef,
} from "@open-managed-agents/runtime-resource-contract";
import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import {
  supportsDuplexProcess,
  type SandboxCheckpointHandle,
  type SandboxCheckpointKind,
  type SandboxFactoryContext,
  type SandboxFactoryEnv,
  type SandboxPort,
  type SandboxProviderPort,
  type SandboxRuntimeHandle,
  type SandboxRuntimePort,
} from "@open-managed-agents/sandbox";

const checkpointMetadataKey = "openma.runtime.checkpoint.v1";

type ProviderRuntime = SandboxPort & SandboxRuntimePort;

export interface ProviderManagedRuntimeOptions<Runtime extends ProviderRuntime> {
  providerName: string;
  provider: SandboxProviderPort<Runtime>;
  context(scope: {
    workspaceId: string;
    environmentId: string;
    sessionId: string;
    workId: string;
  }): SandboxFactoryContext;
  environment(scope: {
    workspaceId: string;
    environmentId: string;
    sessionId: string;
    workId: string;
  }): SandboxFactoryEnv;
  leaseTtlMs: number;
  sandboxCapabilities: SandboxResourceCapabilities;
  workspace: {
    strategies: readonly Extract<
      WorkspaceStrategy,
      "retained_runtime" | "checkpoint_restore"
    >[];
    retainedSuspendKind?: SandboxCheckpointKind;
    portableCheckpointKind?: SandboxCheckpointKind;
  };
  outputs?: {
    /** Durable candidate store. The active pointer remains FencePort-owned. */
    store: BlobStore;
    /** Namespace inside the store; defaults to `managed-runtime-outputs`. */
    keyPrefix?: string | ((scope: RuntimeResourceScope) => string);
    durability?: "durable" | "best_effort";
    maxFiles?: number;
    maxBytes?: number;
    /** Optional provider-native attachment for `/mnt/session/outputs`.
     * Keeping this callback here lets a provider expose durable mount
     * semantics without adding persistence methods to the compute Port. */
    durableMount?: {
      durability?: "durable" | "best_effort";
      attach(input: {
        runtime: Runtime;
        scope: RuntimeResourceScope;
        binding: SessionOutputBinding;
        signal: AbortSignal;
      }): Promise<void>;
    };
  };
  /** Provider-specific reconnect-and-destroy path for persisted orphans. */
  reapRuntime?: (input: {
    scope: RuntimeResourceScope;
    lease: ManagedSandboxLease;
    context: SandboxFactoryContext;
    environment: SandboxFactoryEnv;
  }) => Promise<void>;
  /** Statically declared: capability negotiation must not probe a live box. */
  drivers: readonly Extract<HarnessDriverType, "ama_worker">[];
  /**
   * Optional provider-native process checkpoint adapter. The provider must
   * explicitly prove that its snapshot captures resumable process state; the
   * generic SandboxRuntimePort checkpoint is intentionally not promoted.
   */
  runtimeCheckpoint?: {
    kind: RuntimeCheckpointKind;
    create(input: {
      runtime: Runtime;
      scope: RuntimeResourceScope;
      fence: RuntimeResourceFence;
      workspaceRevision: number;
      harnessVersion: string;
      runtimeIdentity: string;
    }): Promise<SandboxCheckpointHandle>;
    restore(input: {
      checkpoint: RuntimeCheckpointRef;
      scope: RuntimeResourceScope;
      fence: RuntimeResourceFence;
      context: SandboxFactoryContext;
      environment: SandboxFactoryEnv;
    }): Promise<Runtime>;
  };
}

export interface ProviderManagedRuntimeComposition {
  sandbox: ManagedSandboxPort;
  workspace: WorkspacePersistencePort;
  outputs: SessionOutputPort;
  harness: SandboxHarnessDriverPort;
  supervisorTransport: HarnessSupervisorTransportPort;
  runtimeCheckpoint?: RuntimeCheckpointPort;
}

function stableCheckpointJson(checkpoint: SandboxCheckpointHandle): string {
  const metadata = checkpoint.metadata === undefined
    ? undefined
    : Object.fromEntries(Object.entries(checkpoint.metadata).sort(([a], [b]) =>
        a.localeCompare(b)
      ));
  return JSON.stringify({
    provider: checkpoint.provider,
    checkpointId: checkpoint.checkpointId,
    sourceRuntimeId: checkpoint.sourceRuntimeId,
    kind: checkpoint.kind,
    scope: checkpoint.scope,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function outputPrefix(
  options: NonNullable<ProviderManagedRuntimeOptions<ProviderRuntime>["outputs"]>,
  scope: RuntimeResourceScope,
): string {
  const raw = typeof options.keyPrefix === "function"
    ? options.keyPrefix(scope)
    : options.keyPrefix ?? "managed-runtime-outputs";
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0 || normalized.split("/").includes("..")) {
    throw new Error("Provider output keyPrefix must be a safe non-empty blob prefix");
  }
  return normalized;
}

async function readStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function captureProcess(
  runtime: ProviderRuntime,
  process: { command: string; args?: string[] },
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!supportsDuplexProcess(runtime)) {
    throw new Error("Provider output collection requires a duplex process Port");
  }
  const child = await runtime.spawnDuplexProcess(process);
  const onAbort = () => {
    void child.kill("SIGTERM").catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, _stderr, exit] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      child.exited,
    ]);
    signal.throwIfAborted();
    if (exit.code !== 0) {
      throw new Error(
        `Provider output helper ${process.command} exited with code ${String(exit.code)}`,
      );
    }
    return stdout;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function outputLogicalPath(absolutePath: string): string {
  const root = "/mnt/session/outputs/";
  if (!absolutePath.startsWith(root)) {
    throw new Error(`Provider output escaped its mount: ${absolutePath}`);
  }
  const logicalPath = absolutePath.slice(root.length);
  if (
    logicalPath.length === 0
    || logicalPath.startsWith("/")
    || logicalPath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Provider output has an unsafe logical path: ${absolutePath}`);
  }
  return logicalPath;
}

function parseCheckpoint(value: unknown, providerName: string): SandboxCheckpointHandle {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Runtime workspace candidate is missing its checkpoint metadata");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Runtime workspace checkpoint metadata is invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Runtime workspace checkpoint metadata must be an object");
  }
  const candidate = parsed as Partial<SandboxCheckpointHandle>;
  if (
    candidate.provider !== providerName
    || typeof candidate.checkpointId !== "string"
    || candidate.checkpointId.length === 0
    || typeof candidate.sourceRuntimeId !== "string"
    || candidate.sourceRuntimeId.length === 0
    || (candidate.kind !== "filesystem" && candidate.kind !== "memory")
    || (candidate.scope !== "runtime" && candidate.scope !== "portable")
  ) {
    throw new Error("Runtime workspace checkpoint metadata has an incompatible shape");
  }
  return candidate as SandboxCheckpointHandle;
}

function runtimeHandleFor(checkpoint: SandboxCheckpointHandle): SandboxRuntimeHandle {
  return {
    provider: checkpoint.provider,
    runtimeId: checkpoint.sourceRuntimeId,
  };
}

async function drain(readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  try {
    while (!(await reader.read()).done) {
      // Direct AMA workers own their own API protocol. Runtime transport only
      // drains logs to prevent backpressure; observability can wrap this Port.
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSupervisorEvent(line: string): HarnessSupervisorEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Harness supervisor emitted invalid JSON");
  }
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("Harness supervisor event must be an object with a type");
  }
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "ready":
      if (event.protocol !== "openma-harness-supervisor-v1") {
        throw new Error("Harness supervisor emitted an unsupported ready protocol");
      }
      return { type: "ready", protocol: event.protocol };
    case "heartbeat":
      if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0) {
        throw new Error("Harness supervisor heartbeat sequence must be non-negative");
      }
      return { type: "heartbeat", sequence: Number(event.sequence) };
    case "completed":
      if (!Number.isSafeInteger(event.exitCode)) {
        throw new Error("Harness supervisor completion exitCode must be an integer");
      }
      return { type: "completed", exitCode: Number(event.exitCode) };
    case "drained":
      return { type: "drained" };
    case "error":
      if (typeof event.message !== "string" || event.message.length === 0) {
        throw new Error("Harness supervisor error message must be non-empty");
      }
      return { type: "error", message: event.message };
    default:
      throw new Error(`Unknown harness supervisor event: ${String(event.type)}`);
  }
}

async function* supervisorEvents(
  readable: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<HarnessSupervisorEvent> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield parseSupervisorEvent(line);
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.length > 0) yield parseSupervisorEvent(trailing);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function createProviderManagedRuntime<Runtime extends ProviderRuntime>(
  options: ProviderManagedRuntimeOptions<Runtime>,
): ProviderManagedRuntimeComposition {
  const runtimes = new Map<string, Runtime>();
  const bindingRestore = new Map<string, SandboxCheckpointHandle>();
  const bindingRuntime = new Map<string, string>();
  const outputRuntime = new Map<string, string>();
  const suspended = new Map<string, SandboxCheckpointHandle>();
  const terminated = new Set<string>();

  function assertProviderRuntime(runtime: Runtime): ManagedSandboxLease {
    const handle = runtime.runtimeHandle();
    if (handle.provider !== options.providerName || handle.runtimeId.length === 0) {
      throw new Error(
        `Sandbox provider returned an incompatible runtime for ${options.providerName}`,
      );
    }
    runtimes.set(handle.runtimeId, runtime);
    return { provider: handle.provider, runtimeId: handle.runtimeId };
  }

  function requireRuntime(lease: ManagedSandboxLease): Runtime {
    if (lease.provider !== options.providerName) {
      throw new Error(`Incompatible sandbox lease provider: ${lease.provider}`);
    }
    const runtime = runtimes.get(lease.runtimeId);
    if (runtime === undefined) {
      throw new Error(`Sandbox runtime is not attached: ${lease.runtimeId}`);
    }
    return runtime;
  }

  const sandbox: ManagedSandboxPort = {
    async capabilities() {
      return options.sandboxCapabilities;
    },

    async acquire(input) {
      input.signal.throwIfAborted();
      const context = options.context(input.scope);
      const environment = options.environment(input.scope);
      const checkpoint = bindingRestore.get(input.workspace.bindingId);
      const runtime = checkpoint === undefined
        ? await options.provider.create(context, environment)
        : checkpoint.scope === "runtime"
          ? await options.provider.resume(
              runtimeHandleFor(checkpoint),
              context,
              environment,
            )
          : await options.provider.restore(checkpoint, context, environment);
      input.signal.throwIfAborted();
      const lease = assertProviderRuntime(runtime);
      bindingRuntime.set(input.workspace.bindingId, lease.runtimeId);
      if (input.outputs !== null) {
        outputRuntime.set(input.outputs.bindingId, lease.runtimeId);
      }
      await runtime.renewLease({ ttlMs: options.leaseTtlMs });
      input.signal.throwIfAborted();
      return lease;
    },

    async heartbeat(input) {
      let runtime: Runtime;
      try {
        runtime = requireRuntime(input.lease);
        const state = await runtime.status();
        if (state === "stopped") return { type: "lost" };
        await runtime.renewLease({ ttlMs: options.leaseTtlMs });
        return { type: "alive" };
      } catch {
        return { type: "lost" };
      }
    },

    async suspend(input) {
      input.signal.throwIfAborted();
      const kind = options.workspace.retainedSuspendKind;
      if (kind === undefined) {
        throw new Error("Provider composition has no retained-runtime suspend kind");
      }
      const checkpoint = await requireRuntime(input.lease).suspend({ kind });
      input.signal.throwIfAborted();
      suspended.set(input.lease.runtimeId, checkpoint);
      return {
        ...input.lease,
        metadata: { [checkpointMetadataKey]: stableCheckpointJson(checkpoint) },
      };
    },

    async terminate(input) {
      if (terminated.has(input.lease.runtimeId)) return;
      const runtime = requireRuntime(input.lease);
      if (runtime.destroy !== undefined) {
        await runtime.destroy();
      } else if (options.sandboxCapabilities.hardTerminate === "supported") {
        throw new Error("Provider advertises hard termination but exposes no destroy method");
      }
      runtimes.delete(input.lease.runtimeId);
      suspended.delete(input.lease.runtimeId);
      terminated.add(input.lease.runtimeId);
    },

    async reap(input) {
      if (terminated.has(input.lease.runtimeId)) return;
      if (input.lease.provider !== options.providerName) {
        throw new Error(`Incompatible sandbox lease provider: ${input.lease.provider}`);
      }
      const context = options.context(input.scope);
      const environment = options.environment(input.scope);
      if (options.reapRuntime !== undefined) {
        await options.reapRuntime({
          scope: input.scope,
          lease: input.lease,
          context,
          environment,
        });
      } else {
        const attached = runtimes.get(input.lease.runtimeId);
        const runtime = attached
          ?? await options.provider.resume(input.lease, context, environment);
        if (runtime.destroy === undefined) {
          throw new Error("Provider orphan reaping requires a destroy method");
        }
        await runtime.destroy();
      }
      runtimes.delete(input.lease.runtimeId);
      suspended.delete(input.lease.runtimeId);
      terminated.add(input.lease.runtimeId);
    },

    async inspect(lease) {
      try {
        const state = await requireRuntime(lease).status();
        return { state };
      } catch {
        return { state: "unknown" };
      }
    },
  };

  const outputs: SessionOutputPort = {
    async capabilities() {
      if (options.outputs === undefined) return { strategies: [] };
      return {
        strategies: [
          ...(options.outputs.durableMount === undefined
            ? []
            : [{
                strategy: "durable_mount" as const,
                durability:
                  options.outputs.durableMount.durability ?? "durable" as const,
              }]),
          {
            strategy: "final_collect" as const,
            durability: options.outputs.durability ?? "durable",
          },
        ],
      };
    },

    async prepare(input) {
      input.signal.throwIfAborted();
      if (options.outputs === undefined) {
        throw new Error("Provider composition has no Session output store");
      }
      if (
        input.strategy !== "final_collect"
        && !(input.strategy === "durable_mount"
          && options.outputs.durableMount !== undefined)
      ) {
        throw new Error(`Provider outputs do not support ${input.strategy}`);
      }
      const identity = JSON.stringify([
        input.scope.workspaceId,
        input.scope.environmentId,
        input.scope.sessionId,
        input.scope.workId,
        input.fence.generation,
        input.idempotencyKey,
      ]);
      return {
        bindingId: `provider-out-${await sha256(identity)}`,
        mountPath: "/mnt/session/outputs",
      } satisfies SessionOutputBinding;
    },

    async attach(input) {
      input.signal.throwIfAborted();
      if (options.outputs === undefined) {
        throw new Error("Provider composition has no Session output store");
      }
      const runtime = requireRuntime(input.sandbox);
      outputRuntime.set(input.binding.bindingId, input.sandbox.runtimeId);
      if (input.strategy === "durable_mount") {
        if (options.outputs.durableMount === undefined) {
          throw new Error("Provider composition has no durable Session output mount");
        }
        await options.outputs.durableMount.attach({
          runtime,
          scope: input.scope,
          binding: input.binding,
          signal: input.signal,
        });
        input.signal.throwIfAborted();
        return;
      }
      await captureProcess(
        runtime,
        { command: "mkdir", args: ["-p", "/mnt/session/outputs"] },
        input.signal,
      );
    },

    async collect(input): Promise<readonly SessionOutputEntryCandidate[]> {
      input.signal.throwIfAborted();
      const runtimeId = outputRuntime.get(input.binding.bindingId);
      if (runtimeId === undefined) {
        throw new Error("Provider output binding is not attached to a runtime");
      }
      const runtime = requireRuntime({ provider: options.providerName, runtimeId });
      if (runtime.readFileBytes === undefined) {
        throw new Error("Provider output collection requires binary file reads");
      }
      const listing = await captureProcess(
        runtime,
        { command: "find", args: ["/mnt/session/outputs", "-type", "f", "-print0"] },
        input.signal,
      );
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(listing);
      } catch {
        throw new Error("Provider output path is not valid UTF-8");
      }
      const paths = decoded.split("\0").filter((path) => path.length > 0);
      const maxFiles = options.outputs?.maxFiles ?? 10_000;
      const maxBytes = options.outputs?.maxBytes ?? 10 * 1024 * 1024 * 1024;
      if (paths.length > maxFiles) {
        throw new Error(`Provider output file limit exceeded (${maxFiles})`);
      }
      const entries: SessionOutputEntryCandidate[] = [];
      let totalBytes = 0;
      for (const absolutePath of paths) {
        input.signal.throwIfAborted();
        const logicalPath = outputLogicalPath(absolutePath);
        const bytes = await runtime.readFileBytes(absolutePath);
        totalBytes += bytes.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error(`Provider output byte limit exceeded (${maxBytes})`);
        }
        entries.push({
          logicalPath,
          contentHash: `sha256:${await sha256(bytes)}`,
          size: bytes.byteLength,
        });
      }
      entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
      return entries;
    },

    async finalize(input): Promise<SessionOutputManifestCandidate> {
      input.signal.throwIfAborted();
      if (options.outputs === undefined) {
        throw new Error("Provider composition has no Session output store");
      }
      const runtimeId = outputRuntime.get(input.binding.bindingId);
      if (runtimeId === undefined) {
        throw new Error("Provider output binding is not attached to a runtime");
      }
      const runtime = requireRuntime({ provider: options.providerName, runtimeId });
      if (runtime.readFileBytes === undefined) {
        throw new Error("Provider output finalization requires binary file reads");
      }
      const prefix = outputPrefix(options.outputs, input.scope);
      const entries = [...input.entries].sort((left, right) =>
        left.logicalPath.localeCompare(right.logicalPath)
      );
      for (const entry of entries) {
        input.signal.throwIfAborted();
        const logicalPath = outputLogicalPath(`/mnt/session/outputs/${entry.logicalPath}`);
        const bytes = await runtime.readFileBytes(`/mnt/session/outputs/${logicalPath}`);
        const contentHash = `sha256:${await sha256(bytes)}`;
        if (contentHash !== entry.contentHash || bytes.byteLength !== entry.size) {
          throw new Error(`Session output changed during collection: ${logicalPath}`);
        }
        const blobKey = `${prefix}/blobs/${contentHash.slice("sha256:".length)}`;
        const stored = await options.outputs.store.put(blobKey, bytes, {
          precondition: { type: "ifNoneMatch", value: "*" },
        });
        if (stored === null) {
          const existing = await options.outputs.store.get(blobKey);
          const existingHash = existing === null
            ? null
            : `sha256:${await sha256(await existing.bytes())}`;
          if (
            existing === null
            || existing.size !== bytes.byteLength
            || existingHash !== contentHash
          ) {
            throw new Error(`Existing Session output blob is invalid: ${logicalPath}`);
          }
        }
      }
      const manifest = {
        version: 1,
        sessionId: input.scope.sessionId,
        workId: input.scope.workId,
        generation: input.fence.generation,
        entries,
      } as const;
      const manifestJson = `${JSON.stringify(manifest)}\n`;
      const hash = await sha256(manifestJson);
      const manifestKey = `${prefix}/manifests/${hash}.json`;
      const stored = await options.outputs.store.put(manifestKey, manifestJson, {
        precondition: { type: "ifNoneMatch", value: "*" },
      });
      if (stored === null) {
        const existing = await options.outputs.store.get(manifestKey);
        if (existing === null || await existing.text() !== manifestJson) {
          throw new Error("Existing Session output manifest is invalid");
        }
      }
      input.signal.throwIfAborted();
      return {
        id: `out_${hash}`,
        contentHash: `sha256:${hash}`,
        entries: entries.length,
        metadata: { manifestKey },
      };
    },

    async release(input) {
      outputRuntime.delete(input.binding.bindingId);
    },

    async abort(input) {
      outputRuntime.delete(input.binding.bindingId);
    },
  };

  const workspace: WorkspacePersistencePort = {
    async capabilities() {
      return { strategies: options.workspace.strategies };
    },

    async materialize(input) {
      input.signal.throwIfAborted();
      if (!options.workspace.strategies.includes(
        input.strategy as "retained_runtime" | "checkpoint_restore",
      )) {
        throw new Error(`Provider workspace does not support ${input.strategy}`);
      }
      const bindingId = `provider-ws-${input.scope.workId}-${input.fence.generation}`;
      if (input.activeCheckpoint !== null) {
        const checkpoint = parseCheckpoint(
          input.activeCheckpoint.metadata?.[checkpointMetadataKey],
          options.providerName,
        );
        const checkpointJson = stableCheckpointJson(checkpoint);
        const contentHash = `sha256:${await sha256(checkpointJson)}`;
        if (contentHash !== input.activeCheckpoint.contentHash) {
          throw new Error("Runtime workspace checkpoint content hash mismatch");
        }
        if (
          (input.strategy === "retained_runtime" && checkpoint.scope !== "runtime")
          || (input.strategy === "checkpoint_restore" && checkpoint.scope !== "portable")
        ) {
          throw new Error(
            `Runtime workspace checkpoint scope ${checkpoint.scope} is incompatible with ${input.strategy}`,
          );
        }
        bindingRestore.set(bindingId, checkpoint);
      }
      input.signal.throwIfAborted();
      return {
        bindingId,
        mountPath: "/workspace",
      } satisfies WorkspaceBinding;
    },

    async attach() {
      // Restore/resume happens atomically with provider acquisition. There is
      // no host path to mount after the remote runtime exists.
    },

    async checkpoint(input): Promise<WorkspaceCheckpointCandidate> {
      input.signal.throwIfAborted();
      let checkpoint: SandboxCheckpointHandle;
      if (input.strategy === "retained_runtime") {
        checkpoint = suspended.get(input.sandbox.runtimeId)
          ?? parseCheckpoint(
            input.sandbox.metadata?.[checkpointMetadataKey],
            options.providerName,
          );
      } else if (input.strategy === "checkpoint_restore") {
        const kind = options.workspace.portableCheckpointKind;
        if (kind === undefined) {
          throw new Error("Provider composition has no portable checkpoint kind");
        }
        checkpoint = await requireRuntime(input.sandbox).checkpoint({
          kind,
          name: input.idempotencyKey,
        });
      } else {
        throw new Error(`Provider workspace does not support ${input.strategy}`);
      }
      const checkpointJson = stableCheckpointJson(checkpoint);
      const hash = await sha256(checkpointJson);
      input.signal.throwIfAborted();
      return {
        id: `wrc_${hash}`,
        contentHash: `sha256:${hash}`,
        revision: input.fence.generation,
        metadata: { [checkpointMetadataKey]: checkpointJson },
      };
    },

    async release(input) {
      bindingRestore.delete(input.binding.bindingId);
      const runtimeId = bindingRuntime.get(input.binding.bindingId);
      bindingRuntime.delete(input.binding.bindingId);
      if (runtimeId !== undefined) {
        runtimes.delete(runtimeId);
        suspended.delete(runtimeId);
      }
    },
  };

  const harness: SandboxHarnessDriverPort = {
    async driverCapabilities() {
      return { drivers: options.drivers };
    },

    async run(input) {
      if (input.driver.type !== "ama_worker") {
        throw new Error(`Provider direct driver cannot run ${input.driver.type}`);
      }
      input.signal.throwIfAborted();
      const runtime = requireRuntime(input.sandbox);
      if (!supportsDuplexProcess(runtime)) {
        throw new Error(
          "Provider advertised ama_worker but its runtime has no duplex process Port",
        );
      }
      const process = await runtime.spawnDuplexProcess({
        command: input.driver.process.command,
        ...(input.driver.process.args === undefined
          ? {}
          : { args: [...input.driver.process.args] }),
        ...(input.driver.process.env === undefined
          ? {}
          : { env: { ...input.driver.process.env } }),
        ...(input.driver.process.cwd === undefined
          ? {}
          : { cwd: input.driver.process.cwd }),
      });
      const onAbort = () => {
        void process.kill("SIGTERM").catch(() => {});
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const stdout = drain(process.stdout);
        const stderr = drain(process.stderr);
        const exit = await process.exited;
        await Promise.all([stdout, stderr]);
        if (input.signal.aborted) return { type: "aborted" };
        if (exit.code !== 0) {
          throw new Error(
            `AMA worker exited with code ${String(exit.code)}${
              exit.signal === null ? "" : ` (${exit.signal})`
            }`,
          );
        }
        return { type: "completed" };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },
  };

  const supervisorTransport: HarnessSupervisorTransportPort = {
    async open(input): Promise<HarnessSupervisorChannel> {
      input.signal.throwIfAborted();
      const runtime = requireRuntime(input.sandbox);
      if (!supportsDuplexProcess(runtime)) {
        throw new Error("Sandbox runtime has no duplex process Port for a supervisor");
      }
      const process = await runtime.spawnDuplexProcess({
        command: input.process.command,
        ...(input.process.args === undefined ? {} : { args: [...input.process.args] }),
        ...(input.process.env === undefined ? {} : { env: { ...input.process.env } }),
        ...(input.process.cwd === undefined ? {} : { cwd: input.process.cwd }),
      });
      input.signal.throwIfAborted();
      const writer = process.stdin.getWriter();
      const encoder = new TextEncoder();
      let eventsClaimed = false;
      let closed = false;
      void drain(process.stderr).catch(() => {});
      const onAbort = () => {
        void process.kill("SIGTERM").catch(() => {});
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      return {
        async send(command: HarnessSupervisorCommand) {
          if (closed) throw new Error("Harness supervisor channel is closed");
          input.signal.throwIfAborted();
          await writer.write(encoder.encode(`${JSON.stringify(command)}\n`));
        },
        events(signal) {
          if (eventsClaimed) {
            throw new Error("Harness supervisor event stream can only be consumed once");
          }
          eventsClaimed = true;
          return supervisorEvents(process.stdout, signal);
        },
        async close() {
          if (closed) return;
          closed = true;
          input.signal.removeEventListener("abort", onAbort);
          await writer.close().catch(() => {});
          writer.releaseLock();
          await process.kill("SIGTERM").catch(() => {});
        },
      };
    },
  };

  const runtimeCheckpoint: RuntimeCheckpointPort | undefined =
    options.runtimeCheckpoint === undefined
      ? undefined
      : {
          async create(input) {
            const providerRuntime = requireRuntime(input.sandbox);
            const checkpoint = await options.runtimeCheckpoint!.create({
              runtime: providerRuntime,
              scope: input.scope,
              fence: input.fence,
              workspaceRevision: input.workspaceRevision,
              harnessVersion: input.harnessVersion,
              runtimeIdentity: input.runtimeIdentity,
            });
            if (
              checkpoint.provider !== options.providerName
              || checkpoint.checkpointId.length === 0
              || checkpoint.sourceRuntimeId.length === 0
            ) {
              throw new Error(
                `Provider returned an incompatible runtime checkpoint for ${options.providerName}`,
              );
            }
            const runtime = providerRuntime.runtimeHandle();
            if (runtime.runtimeId !== checkpoint.sourceRuntimeId) {
              throw new Error("Provider runtime checkpoint source runtime mismatch");
            }
            return {
              provider: options.providerName,
              checkpointId: checkpoint.checkpointId,
              kind: options.runtimeCheckpoint!.kind,
              sourceRuntimeId: checkpoint.sourceRuntimeId,
              sessionId: input.scope.sessionId,
              workGeneration: input.fence.generation,
              workspaceRevision: input.workspaceRevision,
              harnessVersion: input.harnessVersion,
              runtimeIdentity: input.runtimeIdentity,
            } satisfies RuntimeCheckpointRef;
          },
          async restore(input) {
            if (
              input.checkpoint.provider !== options.providerName
              || input.checkpoint.kind !== options.runtimeCheckpoint!.kind
            ) {
              throw new Error("Incompatible provider runtime checkpoint");
            }
            const runtime = await options.runtimeCheckpoint!.restore({
              checkpoint: input.checkpoint,
              scope: input.scope,
              fence: input.fence,
              context: options.context(input.scope),
              environment: options.environment(input.scope),
            });
            const lease = assertProviderRuntime(runtime);
            await runtime.renewLease({ ttlMs: options.leaseTtlMs });
            return lease;
          },
        };

  return {
    sandbox,
    workspace,
    outputs,
    harness,
    supervisorTransport,
    ...(runtimeCheckpoint === undefined ? {} : { runtimeCheckpoint }),
  };
}
