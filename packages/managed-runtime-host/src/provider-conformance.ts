import type {
  HarnessDriverType,
  RuntimeCheckpointKind,
  WorkspaceStrategy,
} from "@open-managed-agents/runtime-resource-contract";

/** Providers that have a first-class composition in this package. */
export type ManagedRuntimeProviderId =
  | "node-docker"
  | "cloudflare"
  | "cloudflare-bridge"
  | "e2b"
  | "daytona"
  | "litebox"
  | "boxrun"
  | "blaxel"
  | "sprites"
  | "vercel"
  | "modal"
  | "superserve";

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
    id: "cloudflare-bridge",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker"],
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
      available: [
        "http_bridge",
        "argv_sse_process",
        "workspace_file_io",
        "workspace_tar_checkpoint",
      ],
      unavailable: [
        "interactive_stdin_without_pty",
        "provider_lease",
        "process_memory_checkpoint",
      ],
    },
    reason: "Node reaches an operator-deployed official Cloudflare Sandbox Bridge; OpenMA retains Work and fencing authority.",
  },
  {
    id: "e2b",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
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
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
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
      available: [
        "provider_activity_lease",
        "stable_name_with_ownership_labels",
        "workspace_file_io",
        "retained_filesystem_stop_start",
        "portable_filesystem_snapshot",
        "duplex_session_process",
      ],
      unavailable: ["process_memory_checkpoint", "durable_output_mount"],
    },
    reason: "The managed-runtime driver follows Daytona's stable-name, ownership-label, stop/start, snapshot, activity-renewal, and conflict-recovery lifecycle.",
  },
  {
    id: "litebox",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "best_effort",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_get_or_create",
        "detached_retained_filesystem",
        "duplex_process",
        "workspace_file_io",
        "native_network_allowlist",
        "native_secret_substitution",
      ],
      unavailable: ["portable_workspace_checkpoint", "process_memory_checkpoint"],
    },
    reason: "The managed BoxLite driver uses the official low-level runtime API; host-local retained boxes are continuable but are not advertised as portable durable checkpoints.",
  },
  {
    id: "boxrun",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "best_effort",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "official_boxlite_rest_client",
        "stable_get_or_create",
        "detached_retained_filesystem",
        "duplex_process",
        "workspace_file_io",
      ],
      unavailable: ["portable_workspace_checkpoint", "process_memory_checkpoint"],
    },
    reason: "The managed BoxRun driver uses BoxLite's official REST client rather than the legacy hand-written HTTP adapter; retained storage remains provider-local unless an external checkpoint Port is added.",
  },
  {
    id: "blaxel",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "best_effort",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_name_external_id_and_ownership_labels",
        "archive_unarchive_retained_filesystem",
        "duplex_named_process",
        "workspace_file_io",
        "native_proxy_firewall_and_secret_injection",
        "optional_persistent_volume",
      ],
      unavailable: ["portable_workspace_checkpoint", "process_memory_checkpoint"],
    },
    reason: "The managed Blaxel driver follows the provider reference's pre-claim readiness, stable Session identity, archive/unarchive, named process, native network, and janitor lifecycle; OpenMA remains the Work/fence authority.",
  },
  {
    id: "sprites",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_name_and_ownership_labels",
        "persistent_ext4_filesystem",
        "automatic_pause_and_wake",
        "duplex_process",
        "workspace_file_io",
        "native_network_policy",
      ],
      unavailable: ["portable_workspace_checkpoint", "process_memory_checkpoint"],
    },
    reason: "The managed Sprites driver uses stable Session identity, provider-persistent ext4 storage, auto-pause/wake, native streams, network policy, and owner-validated deletion; OpenMA remains the Work/fence authority and does not advertise provider-local state as a portable checkpoint.",
  },
  {
    id: "vercel",
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
      strategies: ["retained_runtime"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_name_and_ownership_tags",
        "persistent_filesystem_with_automatic_snapshot_restore",
        "detached_process_logs",
        "workspace_file_io",
        "deny_by_default_network_policy",
        "path_scoped_header_transform_and_forward_proxy",
      ],
      unavailable: ["streaming_process_stdin", "portable_workspace_checkpoint", "process_memory_checkpoint"],
    },
    reason: "The managed Vercel driver uses the official persistent named-sandbox lifecycle, reapplies deny-by-default firewall policy before readiness, supports provider-side credential transforms and forwarding, and owner-validates hard deletion. Provider snapshots remain retained-runtime state rather than portable OpenMA checkpoints.",
  },
  {
    id: "modal",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_name_and_ownership_tags",
        "session_scoped_volume_v2_subpath",
        "volume_sync_before_detach",
        "duplex_process",
        "workspace_file_io",
        "native_domain_and_cidr_allowlist",
        "compute_recreate_over_durable_volume",
      ],
      unavailable: ["portable_workspace_checkpoint", "stable_process_memory_checkpoint"],
    },
    reason: "The managed Modal driver mounts a pre-created Volume v2 Session subpath at /workspace, syncs before detach, and recreates expired compute over that durable state. It uses Modal's official JS SDK and network allowlists but does not claim provider memory preview as a stable OpenMA checkpoint.",
  },
  {
    id: "superserve",
    managedRuntime: true,
    status: "managed-runtime",
    driverLanes: ["ama_worker", "openma_supervised"],
    lifecycle: {
      lease: "host-fenced",
      suspendResume: "supported",
      hardTerminate: "supported",
      orphanReap: "host-managed",
    },
    workspace: {
      strategies: ["retained_runtime"],
      durability: "durable",
    },
    outputs: {
      strategies: ["final_collect"],
      durability: "durable",
    },
    runtimeCheckpoints: [],
    sandboxPortFacts: {
      available: [
        "stable_name_and_ownership_metadata",
        "pause_resume_preserves_processes_and_files",
        "transparent_token_rotation_and_auto_resume",
        "duplex_process",
        "workspace_file_io",
        "deny_by_default_network_policy",
        "provider_side_secret_proxy_and_audit",
      ],
      unavailable: ["portable_workspace_checkpoint", "stable_process_memory_checkpoint"],
    },
    reason: "The managed Superserve driver uses the official SDK's retained pause/resume lifecycle, token-rotating reconnect, full-duplex commands, provider-side secret substitution, strict egress policy, and owner-validated idempotent deletion. OpenMA remains the Work/fence authority; provider retention is not advertised as a portable checkpoint.",
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
  return getManagedRuntimeProviderConformance(id) as
    ManagedRuntimeProviderConformance & { managedRuntime: true };
}
