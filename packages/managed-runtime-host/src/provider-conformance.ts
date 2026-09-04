import type {
  HarnessDriverType,
  RuntimeCheckpointKind,
  WorkspaceStrategy,
} from "@open-managed-agents/runtime-resource-contract";

/** Providers that have a first-class composition in this package. */
export type ManagedRuntimeProviderId =
  | "node-docker"
  | "cloudflare"
  | "e2b"
  | "daytona"
  | "litebox"
  | "boxrun";

export type ManagedRuntimeProviderStatus =
  | "managed-runtime"
  | "sandbox-port-only";

export interface ManagedRuntimeProviderConformance {
  readonly id: ManagedRuntimeProviderId;
  /** True only when create*ManagedRuntime composes all host Ports. */
  readonly managedRuntime: boolean;
  readonly status: ManagedRuntimeProviderStatus;
  readonly driverLanes: readonly HarnessDriverType[];
  readonly lifecycle: {
    readonly lease: "host-fenced" | "provider-only" | "unavailable";
    readonly suspendResume: "supported" | "unsupported" | "provider-specific";
    readonly hardTerminate: "supported" | "provider-specific" | "unavailable";
    readonly orphanReap: "host-managed" | "provider-specific" | "unavailable";
  };
  readonly workspace: {
    readonly strategies: readonly WorkspaceStrategy[];
    readonly durability: "durable" | "best_effort" | "unavailable";
  };
  readonly outputs: {
    readonly strategies: readonly ("durable_mount" | "final_collect")[];
    readonly durability: "durable" | "best_effort" | "unavailable";
  };
  /** Process-memory checkpointing is deliberately not implied by a provider
   * snapshot. Keep this list empty until RuntimeCheckpointPort is wired. */
  readonly runtimeCheckpoints: readonly RuntimeCheckpointKind[];
  /** Raw adapter facts for consumers that intentionally use SandboxPort only. */
  readonly sandboxPortFacts: {
    readonly available: readonly string[];
    readonly unavailable: readonly string[];
  };
  readonly reason?: string;
}

const profiles = [
  {
    id: "node-docker",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "unsupported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["checkpoint_restore"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: ["duplex_process", "workspace_file_io"],
      unavailable: ["provider_suspend_resume"],
    },
  },
  {
    id: "cloudflare",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "unsupported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["checkpoint_restore"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: ["duplex_process", "workspace_backup", "session_output_mount"],
      unavailable: ["runtime_scoped_resume", "process_memory_checkpoint"],
    },
  },
  {
    id: "e2b",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: ["duplex_process", "provider_suspend_resume", "provider_memory_snapshot"],
      unavailable: ["process_memory_checkpoint"],
    },
  },
  {
    id: "daytona",
    managedRuntime: false,
    status: "sandbox-port-only",
    driverLanes: [],
    lifecycle: {
      lease: "provider-only",
      suspendResume: "provider-specific",
      hardTerminate: "provider-specific",
      orphanReap: "unavailable",
    },
    workspace: { strategies: [], durability: "unavailable" },
    outputs: { strategies: [], durability: "unavailable" },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "workspace_file_io",
        "memory_mount_when_MEMORY_S3_*_configured",
        "session_output_mount_when_FILES_S3_*_configured",
      ],
      unavailable: ["host_fenced_lease", "managed_workspace_checkpoint", "managed_output_manifest"],
    },
    reason: "Daytona has a SandboxPort adapter, but no ManagedRuntimeHost composition yet.",
  },
  {
    id: "litebox",
    managedRuntime: false,
    status: "sandbox-port-only",
    driverLanes: [],
    lifecycle: {
      lease: "provider-only",
      suspendResume: "provider-specific",
      hardTerminate: "provider-specific",
      orphanReap: "unavailable",
    },
    workspace: { strategies: [], durability: "unavailable" },
    outputs: { strategies: [], durability: "unavailable" },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: ["workspace_file_io", "host_bind_mounts"],
      unavailable: ["host_fenced_lease", "managed_workspace_checkpoint", "managed_output_manifest"],
    },
    reason: "LiteBox has a SandboxPort adapter, but no ManagedRuntimeHost composition yet.",
  },
  {
    id: "boxrun",
    managedRuntime: false,
    status: "sandbox-port-only",
    driverLanes: [],
    lifecycle: {
      lease: "provider-only",
      suspendResume: "provider-specific",
      hardTerminate: "provider-specific",
      orphanReap: "unavailable",
    },
    workspace: { strategies: [], durability: "unavailable" },
    outputs: { strategies: [], durability: "unavailable" },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: ["workspace_file_io", "best_effort_file_archive"],
      unavailable: ["memory_mount", "session_output_mount", "host_fenced_lease", "managed_output_manifest"],
    },
    reason: "BoxRun has a SandboxPort adapter, but no ManagedRuntimeHost composition yet.",
  },
] as const satisfies readonly ManagedRuntimeProviderConformance[];

export const MANAGED_RUNTIME_PROVIDER_CONFORMANCE = profiles;

export function getManagedRuntimeProviderConformance(
  id: ManagedRuntimeProviderId,
): ManagedRuntimeProviderConformance {
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown managed runtime provider: ${String(id)}`);
  return profile;
}

/**
 * Admission guard for callers that want ManagedRuntimeHost semantics. A raw
 * SandboxPort adapter can be useful on its own, but it must never be silently
 * upgraded into a host composition without fenced persistence and cleanup.
 */
export function requireManagedRuntimeProvider(
  id: ManagedRuntimeProviderId,
): ManagedRuntimeProviderConformance & { managedRuntime: true } {
  const profile = getManagedRuntimeProviderConformance(id);
  if (!profile.managedRuntime) {
    throw new Error(
      `${id} is sandbox-port-only; provide a ManagedRuntimeHost composition with fenced lease, workspace/output persistence, and orphan reaping`,
    );
  }
  return profile as ManagedRuntimeProviderConformance & { managedRuntime: true };
}
