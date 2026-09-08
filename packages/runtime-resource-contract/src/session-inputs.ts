import type { RuntimePublicationCandidate, RuntimeResourceFence } from "./fence";
import type { ManagedSandboxLease } from "./sandbox";
import type { RuntimeResourceScope } from "./scope";
import type { WorkspaceBinding } from "./workspace";

/** Opaque copy of an official Session resource, including its discriminator. */
export type RuntimeSessionResourceSnapshot = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

/** Provider-neutral projection of the claimed Managed Agents Session. */
export interface RuntimeSessionSnapshot {
  id: string;
  environmentId: string;
  /** Arbitrary application-owned metadata, preserved exactly by the control plane. */
  metadata: Readonly<Record<string, string>>;
  /** Official file/repository/memory resource records returned with the Session. */
  resources: readonly RuntimeSessionResourceSnapshot[];
}

/** Per-claim, short-lived access to Session-owned input bytes. Implementations
 * normally wrap the Session client authenticated by the Work's sessions_token;
 * the token itself never crosses this Port or enters persisted runtime state. */
export interface SessionInputAccessPort {
  downloadFile(input: {
    fileId: string;
    signal: AbortSignal;
  }): Promise<{
    content: Uint8Array;
    filename?: string;
    mimeType?: string;
  }>;
}

/**
 * Stages official Session resources plus application-owned metadata into an
 * acquired runtime. The metadata schema remains application-owned, matching
 * the official self-hosted Environment Worker contract.
 */
export interface SessionInputMaterializerPort {
  materialize(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    session: RuntimeSessionSnapshot;
    workspace: WorkspaceBinding;
    sandbox: ManagedSandboxLease;
    activeWorkspaceCheckpoint: RuntimePublicationCandidate | null;
    /** Makes the writer boundary explicit. The official AMA worker owns its
     * Memory Store reconciliation; a supervised harness delegates it to a
     * specialized materializer instead. */
    resourceOwnership: {
      memoryStore: "worker" | "materializer";
    };
    idempotencyKey: string;
    /** Optional because operator-specific materializers may use their own
     * object-store source. The generic materializer requires it for files. */
    access?: SessionInputAccessPort;
    signal: AbortSignal;
  }): Promise<void>;
}
