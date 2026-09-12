import type {
  OutputStrategy,
  SessionOutputCapabilities,
} from "./capabilities";
import type { RuntimeResourceFence } from "./fence";
import type { RuntimeResourceScope } from "./scope";
import type { ManagedSandboxLease } from "./sandbox";

export interface SessionOutputBinding {
  bindingId: string;
  mountPath: "/mnt/session/outputs";
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SessionOutputEntryCandidate {
  logicalPath: string;
  contentHash: string;
  size: number;
  mediaType?: string;
}

/** Immutable candidate. It is not user-visible until FencePort.publish. */
export interface SessionOutputManifestCandidate {
  id: string;
  contentHash: string;
  entries: number;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SessionOutputPort {
  capabilities(scope: RuntimeResourceScope): Promise<SessionOutputCapabilities>;
  prepare(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: OutputStrategy;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<SessionOutputBinding>;
  attach(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: OutputStrategy;
    binding: SessionOutputBinding;
    sandbox: ManagedSandboxLease;
    signal: AbortSignal;
  }): Promise<void>;
  collect(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: OutputStrategy;
    binding: SessionOutputBinding;
    signal: AbortSignal;
  }): Promise<readonly SessionOutputEntryCandidate[]>;
  finalize(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    strategy: OutputStrategy;
    binding: SessionOutputBinding;
    entries: readonly SessionOutputEntryCandidate[];
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<SessionOutputManifestCandidate>;
  release(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: SessionOutputBinding;
  }): Promise<void>;
  abort(input: {
    scope: RuntimeResourceScope;
    fence: RuntimeResourceFence;
    binding: SessionOutputBinding;
    reason: "failed" | "lease_lost";
  }): Promise<void>;
}
