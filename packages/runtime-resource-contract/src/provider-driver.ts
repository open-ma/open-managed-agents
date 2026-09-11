import type { ManagedRuntimeResourceCapabilities } from "./capabilities";
import type {
  CredentialEgressCapabilities,
  CredentialEgressPort,
} from "./credential-egress";
import type {
  HarnessSupervisorTransportPort,
  SandboxHarnessDriverPort,
} from "./executor";
import type { ManagedRuntimePlan, ManagedRuntimeProfile } from "./profile";
import type { ManagedSandboxPort } from "./sandbox";
import type { RuntimeCheckpointPort } from "./checkpoint";
import type { SessionOutputPort } from "./outputs";
import type { SessionInputMaterializerPort } from "./session-inputs";
import type { WorkspacePersistencePort } from "./workspace";

/** Physical placement of a provider driver. Placement never changes the
 * Managed Agents Work protocol or the Runtime Host resource contracts. */
export type ManagedRuntimeProviderPlacement =
  | "in_process"
  | "driver_service"
  | "provider_native";

/** Provider-neutral facts used for admission before any provider allocation. */
export interface ManagedRuntimeProviderDriverDescriptor {
  provider: string;
  version: string;
  placements: readonly ManagedRuntimeProviderPlacement[];
  capabilities: ManagedRuntimeResourceCapabilities;
  credentialEgress: CredentialEgressCapabilities;
}

/** The only objects a provider driver may expose to the Runtime Host. Provider
 * SDK clients and handles remain private to the adapter implementation. */
export interface ManagedRuntimeProviderResources {
  sandbox: ManagedSandboxPort;
  workspace: WorkspacePersistencePort;
  outputs: SessionOutputPort;
  harnessDriver: SandboxHarnessDriverPort;
  supervisorTransport?: HarnessSupervisorTransportPort;
  runtimeCheckpoint?: RuntimeCheckpointPort;
  credentialEgress?: CredentialEgressPort;
  sessionInputs?: SessionInputMaterializerPort;
}

export interface ManagedRuntimeProviderCreateInput {
  environmentId: string;
  placement: ManagedRuntimeProviderPlacement;
  profile: ManagedRuntimeProfile;
  plan: ManagedRuntimePlan;
  /** Application/provider configuration only. Secret material remains behind
   * provider-owned credential sources and egress Ports. */
  providerConfig: Readonly<Record<string, unknown>>;
}

/** Factory Port for a swappable managed sandbox implementation. */
export interface ManagedRuntimeProviderDriverPort {
  descriptor(): ManagedRuntimeProviderDriverDescriptor;
  create(
    input: ManagedRuntimeProviderCreateInput,
  ): Promise<ManagedRuntimeProviderResources>;
}
