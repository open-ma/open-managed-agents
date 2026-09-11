import type { RuntimeResourceFence } from "./fence";
import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";

export type CredentialEgressRequirement = "required" | "best_effort" | "disabled";
export type CredentialEgressEnforcement = "enforced" | "advisory" | "unsupported";
export type CredentialEgressMode = "live" | "snapshot";
export type CredentialEgressProtocol = "http" | "https" | "tcp";

export interface CredentialEgressCapabilities {
  enforcement: CredentialEgressEnforcement;
  credentialMode: CredentialEgressMode;
  interceptedProtocols: readonly CredentialEgressProtocol[];
}

/**
 * Transient, non-secret identity for one prepared egress grant. Implementations
 * keep provider credentials and proxy capabilities behind this opaque id. The
 * binding must never be persisted in a sandbox lease or checkpoint.
 */
export interface CredentialEgressBinding {
  bindingId: string;
  enforcement: Exclude<CredentialEgressEnforcement, "unsupported">;
  credentialMode: CredentialEgressMode;
}

export type CredentialEgressRevokeReason = "completed" | "failed" | "lease_lost";

/** Runtime-host lifecycle for sandbox Vault access; not a Managed Agents API shape. */
export interface CredentialEgressPort {
  capabilities(scope: RuntimeResourceScope): Promise<CredentialEgressCapabilities>;
  prepare(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    requirement: Exclude<CredentialEgressRequirement, "disabled">;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<CredentialEgressBinding | null>;
  attach(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: CredentialEgressBinding;
    sandbox: ManagedSandboxLease;
    signal: AbortSignal;
  }): Promise<void>;
  /** Revoke authorization before stopping or retaining provider compute. */
  revoke(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: CredentialEgressBinding;
    reason: CredentialEgressRevokeReason;
  }): Promise<void>;
  /** Idempotent resource cleanup after revoke. */
  release(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: CredentialEgressBinding;
  }): Promise<void>;
}
