import {
  sandboxProvider,
  type E2BSandboxExecutor,
} from "@open-managed-agents/sandbox-adapter-e2b";
import type {
  SandboxFactoryContext,
  SandboxFactoryEnv,
} from "@open-managed-agents/sandbox";
import type {
  ManagedRuntimeProviderDriverPort,
  RuntimeResourceScope,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import { S3BlobStore } from "@open-managed-agents/blob-store/adapters/s3";

import {
  createPreinstalledRuntimeEnvironment,
  createProviderManagedRuntime,
  requireRuntimeEnvironmentArtifact,
  type ProviderManagedRuntimeProviderPort,
  type ProviderManagedRuntimeOptions,
  type ProviderRuntimeEnvironmentResolver,
} from "@open-managed-agents/managed-runtime-sandbox";

export interface E2BManagedRuntimeOptions {
  environment:
    | SandboxFactoryEnv
    | ((scope: RuntimeResourceScope) => SandboxFactoryEnv);
  leaseTtlMs: number;
  context?: (scope: RuntimeResourceScope) => SandboxFactoryContext;
  /** Test/custom-compatible-service seam; defaults to the official E2B adapter. */
  provider?: ProviderManagedRuntimeProviderPort<E2BSandboxExecutor>;
  runtimeEnvironment?: ProviderRuntimeEnvironmentResolver<E2BSandboxExecutor>;
  /** Explicit output target, useful with per-scope environment functions. */
  outputStore?: BlobStore | null;
  /**
   * Explicit provider/BYOC network wire point. The preset supplies none by
   * default because the installed E2B SDK does not prove hosted egress-policy
   * semantics; operators must provide and certify their actual deployment.
   */
  credentialEgress?: ProviderManagedRuntimeOptions<E2BSandboxExecutor>["credentialEgress"];
  /** Operator-owned staging for official Session file/repository/memory inputs. */
  sessionInputs?: SessionInputMaterializerPort;
}

function filesStoreFromEnvironment(environment: SandboxFactoryEnv): BlobStore | null {
  const endpoint = environment.FILES_S3_ENDPOINT;
  const bucket = environment.FILES_S3_BUCKET;
  const accessKeyId = environment.FILES_S3_ACCESS_KEY;
  const secretAccessKey = environment.FILES_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return new S3BlobStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: environment.FILES_S3_REGION ?? "us-east-1",
    forcePathStyle: environment.FILES_S3_FORCE_PATH_STYLE !== "false",
    prefix: environment.FILES_S3_PREFIX,
  });
}

/**
 * Preconfigured E2B composition. The same adapter works with E2B-compatible
 * endpoints because connection details remain in SandboxFactoryEnv.
 */
export function createE2BManagedRuntime(options: E2BManagedRuntimeOptions) {
  const configuredEnvironment = options.environment;
  const environment: (scope: RuntimeResourceScope) => SandboxFactoryEnv =
    typeof configuredEnvironment === "function"
      ? configuredEnvironment
      : () => configuredEnvironment;
  const outputStore = options.outputStore === null
    ? null
    : options.outputStore
      ?? (typeof configuredEnvironment === "function"
        ? null
        : filesStoreFromEnvironment(configuredEnvironment));
  const runtimeEnvironment = options.runtimeEnvironment
    ?? ((input: { environment: SandboxFactoryEnv }) => {
      const reference = input.environment.SANDBOX_IMAGE?.trim();
      if (!reference) {
        throw new Error(
          "E2B managed runtime requires an Environment template; SDK base fallback is disabled",
        );
      }
      return createPreinstalledRuntimeEnvironment<E2BSandboxExecutor>({
        type: "base",
        identity: reference,
        artifact: { type: "template", reference },
      });
    });
  const selectedProvider = options.provider ?? sandboxProvider;
  const withEnvironment = (
    env: SandboxFactoryEnv,
    acquisition: Parameters<ProviderManagedRuntimeProviderPort<E2BSandboxExecutor>["create"]>[2],
  ) => {
    if (acquisition === undefined) {
      throw new Error("E2B managed allocation requires acquisition context");
    }
    const artifact = requireRuntimeEnvironmentArtifact(
      acquisition.environment,
      "e2b",
      ["template"],
    );
    return { ...env, SANDBOX_IMAGE: artifact.reference };
  };
  const provider: ProviderManagedRuntimeProviderPort<E2BSandboxExecutor> = {
    create: (context, env, acquisition) =>
      selectedProvider.create(context, withEnvironment(env, acquisition), acquisition),
    resume: (handle, context, env, acquisition) =>
      selectedProvider.resume(handle, context, withEnvironment(env, acquisition), acquisition),
    restore: (checkpoint, context, env, acquisition) =>
      selectedProvider.restore(checkpoint, context, withEnvironment(env, acquisition), acquisition),
  };
  return createProviderManagedRuntime({
    providerName: "e2b",
    provider,
    context:
      options.context
      ?? ((scope) => ({
        sessionId: scope.sessionId,
        workdir: "/workspace",
      })),
    environment,
    runtimeEnvironment,
    leaseTtlMs: options.leaseTtlMs,
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      // E2B memory snapshots are used below as workspace restore points.
      // Do not also advertise process checkpointing until RuntimeCheckpointPort
      // is wired into the host's restore transaction.
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      retainedSuspendKind: "memory",
      portableCheckpointKind: "memory",
    },
    ...(outputStore === null
      ? {}
      : {
          outputs: {
            store: outputStore,
            keyPrefix: "managed-runtime-output-candidates",
            durability: "durable" as const,
          },
        }),
    ...(options.credentialEgress === undefined
      ? {}
      : { credentialEgress: options.credentialEgress }),
    drivers: ["ama_worker"],
  });
}

/** Swappable provider-driver projection of the E2B preset. The E2B SDK client
 * and runtime handles stay behind the resource Ports returned by create(). */
export function createE2BManagedRuntimeDriver(
  options: E2BManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const configuredEnvironment = options.environment;
  const hasOutputStore = options.outputStore !== null && (
    options.outputStore !== undefined
    || (typeof configuredEnvironment !== "function"
      && filesStoreFromEnvironment(configuredEnvironment) !== null)
  );
  return {
    descriptor() {
      return {
        provider: "e2b",
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
        throw new Error(`E2B does not support ${input.placement} placement`);
      }
      const runtime = createE2BManagedRuntime(options);
      return {
        sandbox: runtime.sandbox,
        workspace: runtime.workspace,
        outputs: runtime.outputs,
        harnessDriver: runtime.harness,
        supervisorTransport: runtime.supervisorTransport,
        ...(runtime.credentialEgress === undefined
          ? {}
          : { credentialEgress: runtime.credentialEgress }),
        sessionInputs: options.sessionInputs ?? runtime.sessionInputs,
      };
    },
  };
}
