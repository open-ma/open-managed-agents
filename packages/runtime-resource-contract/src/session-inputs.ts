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

export interface SessionMemoryDocument {
  id: string;
  path: string;
  contentSha256: string;
  content?: string;
}

export type SessionMemoryMutationResult =
  | { type: "applied"; memory?: SessionMemoryDocument }
  | { type: "conflict" }
  | { type: "not_found" };

/** Canonical Memory API projected behind a Work's short-lived Session token. */
export interface SessionMemoryAccessPort {
  list(input: {
    memoryStoreId: string;
    projection: "basic" | "full";
    signal: AbortSignal;
  }): Promise<readonly SessionMemoryDocument[]>;
  create(input: {
    memoryStoreId: string;
    path: string;
    content: string;
    signal: AbortSignal;
  }): Promise<SessionMemoryMutationResult>;
  update(input: {
    memoryStoreId: string;
    memoryId: string;
    path: string;
    content: string;
    expectedContentSha256: string;
    signal: AbortSignal;
  }): Promise<SessionMemoryMutationResult>;
  delete(input: {
    memoryStoreId: string;
    memoryId: string;
    expectedContentSha256: string;
    signal: AbortSignal;
  }): Promise<SessionMemoryMutationResult>;
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
  /** Present only when the Work token is authorized for attached Memory
   * Stores. The Environment Worker keeps the actual token outside runtime
   * state and exposes only these scoped operations. */
  memories?: SessionMemoryAccessPort;
}

export interface SessionInputLifecycleContext {
  scope: RuntimeResourceScope;
  fence: RuntimeResourceFence;
  session: RuntimeSessionSnapshot;
  sandbox: ManagedSandboxLease;
  /** Makes the writer boundary explicit. The official AMA worker owns its
   * Memory Store reconciliation; a supervised harness delegates it to a
   * specialized materializer instead. */
  resourceOwnership: {
    memoryStore: "worker" | "materializer";
  };
  /** Optional because operator-specific materializers may use their own
   * object-store source. The generic materializer requires it for files and
   * materializer-owned Memory Stores. */
  access?: SessionInputAccessPort;
  /** Revalidated immediately before every canonical mutation. */
  authorize(): Promise<boolean>;
  signal: AbortSignal;
}

/**
 * Stages official Session resources plus application-owned metadata into an
 * acquired runtime. The metadata schema remains application-owned, matching
 * the official self-hosted Environment Worker contract.
 */
export interface SessionInputMaterializerPort {
  materialize(input: SessionInputLifecycleContext & {
    workspace: WorkspaceBinding;
    activeWorkspaceCheckpoint: RuntimePublicationCandidate | null;
    idempotencyKey: string;
  }): Promise<void>;

  /** Reconciles mutable, materializer-owned Session inputs before a live or
   * final workspace checkpoint. Implementations must fence every canonical
   * mutation; worker-owned resources are an explicit no-op so there can never
   * be two writers for the same Memory Store attachment. */
  synchronize(input: SessionInputLifecycleContext & {
    idempotencyKey: string;
  }): Promise<void>;
}
