import type { SandboxResourceCapabilities } from "./capabilities";
import type { CredentialEgressBinding } from "./credential-egress";
import type { RuntimeResourceFence } from "./fence";
import type { SessionOutputBinding } from "./outputs";
import type { ManagedRuntimePlan } from "./profile";
import type { RuntimeResourceScope } from "./scope";
import type { WorkspaceBinding } from "./workspace";

/** Serializable identity of provider-owned compute. */
export interface ManagedSandboxLease {
  provider: string;
  runtimeId: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export type SandboxHeartbeatResult =
  | { type: "alive" }
  | { type: "lost" };

export interface SandboxObservation {
  state: "running" | "suspended" | "stopped" | "unknown";
}

/** Isolated compute lifecycle only; durable data belongs to other Ports. */
export interface ManagedSandboxPort {
  capabilities(scope: RuntimeResourceScope): Promise<SandboxResourceCapabilities>;
  acquire(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    plan: ManagedRuntimePlan;
    workspace: WorkspaceBinding;
    outputs: SessionOutputBinding | null;
    /** Transient identity only. Provider-specific secret material remains
     * behind the composed CredentialEgressPort. */
    credentialEgress?: CredentialEgressBinding | null;
    signal: AbortSignal;
  }): Promise<ManagedSandboxLease>;
  heartbeat(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    lease: ManagedSandboxLease;
  }): Promise<SandboxHeartbeatResult>;
  suspend(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    lease: ManagedSandboxLease;
    signal: AbortSignal;
  }): Promise<ManagedSandboxLease>;
  terminate(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    lease: ManagedSandboxLease;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void>;
  /** Idempotent cleanup from a serialized lease; never receives a fence token. */
  reap(input: {
    scope: RuntimeResourceScope;
    lease: ManagedSandboxLease;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void>;
  inspect(lease: ManagedSandboxLease): Promise<SandboxObservation>;
}
