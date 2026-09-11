import type {
  AcquireRuntimeFenceInput,
  AcquireRuntimeFenceResult,
  PublishRuntimeResourcesResult,
  RuntimePublicationCandidate,
  RuntimeResourceFence,
  RuntimeResourceFencePort,
  RuntimeResourcePublication,
  RuntimeResourceScope,
  RuntimeOrphanPort,
  RuntimeOrphanRecord,
} from "@open-managed-agents/runtime-resource-contract";
import { runtimeOrphanId } from "@open-managed-agents/runtime-resource-contract";

export interface MemoryRuntimeResourceFenceOptions {
  now?: () => Date;
  nextToken?: (generation: number) => string;
}

interface FenceRecord {
  generation: number;
  active: RuntimeResourceFence | null;
  publication: RuntimeResourcePublication | null;
  nextRevision: number;
}

function scopeKey(scope: RuntimeResourceScope): string {
  return [
    scope.workspaceId,
    scope.environmentId,
    scope.sessionId,
    scope.workId,
  ].join("\u0000");
}

function sameFence(left: RuntimeResourceFence, right: RuntimeResourceFence): boolean {
  return (
    left.generation === right.generation &&
    left.ownerId === right.ownerId &&
    left.token === right.token &&
    scopeKey(left) === scopeKey(right)
  );
}

function sameCandidate(
  left: RuntimePublicationCandidate | null,
  right: RuntimePublicationCandidate | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.contentHash === right.contentHash;
}

function sameRuntimeCheckpoint(
  left: RuntimeResourcePublication["runtimeCheckpoint"],
  right: RuntimeResourcePublication["runtimeCheckpoint"],
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Deterministic fake for lifecycle/fault tests. It mirrors the required
 * single-record transaction: active fence validation and publication pointer
 * advancement happen synchronously in one method.
 */
export class MemoryRuntimeResourceFencePort implements RuntimeResourceFencePort {
  readonly #records = new Map<string, FenceRecord>();
  readonly #now: () => Date;
  readonly #nextToken: (generation: number) => string;

  constructor(options: MemoryRuntimeResourceFenceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#nextToken =
      options.nextToken ??
      ((generation) => `${generation}:${crypto.randomUUID()}`);
  }

  async acquire(
    input: AcquireRuntimeFenceInput,
  ): Promise<AcquireRuntimeFenceResult> {
    const key = scopeKey(input.scope);
    const record = this.#records.get(key) ?? {
      generation: 0,
      active: null,
      publication: null,
      nextRevision: 1,
    };
    const now = this.#now().getTime();
    if (record.active !== null && Date.parse(record.active.expiresAt) > now) {
      if (record.active.ownerId === input.ownerId) {
        return {
          type: "acquired",
          fence: { ...record.active },
          publication: record.publication === null ? null : structuredClone(record.publication),
        };
      }
      return { type: "conflict", expiresAt: record.active.expiresAt };
    }

    const generation = record.generation + 1;
    const fence: RuntimeResourceFence = {
      ...input.scope,
      ownerId: input.ownerId,
      generation,
      token: this.#nextToken(generation),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
    };
    this.#records.set(key, { ...record, generation, active: fence });
    return {
      type: "acquired",
      fence: { ...fence },
      publication: record.publication === null ? null : structuredClone(record.publication),
    };
  }

  async renew(input: {
    fence: RuntimeResourceFence;
    ttlMs: number;
  }) {
    const record = this.#records.get(scopeKey(input.fence));
    if (!this.#isCurrent(record, input.fence)) return { type: "lost" } as const;
    const renewed: RuntimeResourceFence = {
      ...input.fence,
      expiresAt: new Date(this.#now().getTime() + input.ttlMs).toISOString(),
    };
    record!.active = renewed;
    return { type: "renewed", fence: { ...renewed } } as const;
  }

  async isCurrent(fence: RuntimeResourceFence): Promise<boolean> {
    return this.#isCurrent(this.#records.get(scopeKey(fence)), fence);
  }

  async publish(input: {
    fence: RuntimeResourceFence;
    workspaceCandidate: RuntimePublicationCandidate;
    outputCandidate: RuntimePublicationCandidate | null;
    runtimeCheckpoint?: RuntimeResourcePublication["runtimeCheckpoint"];
  }): Promise<PublishRuntimeResourcesResult> {
    const record = this.#records.get(scopeKey(input.fence));
    if (!this.#isCurrent(record, input.fence)) return { type: "lost" };
    const previous = record!.publication;
    if (
      previous !== null &&
      previous.generation === input.fence.generation &&
      sameCandidate(previous.workspaceCandidate, input.workspaceCandidate) &&
      sameCandidate(previous.outputCandidate, input.outputCandidate) &&
      sameRuntimeCheckpoint(previous.runtimeCheckpoint, input.runtimeCheckpoint)
    ) {
      return { type: "published", revision: previous.revision };
    }
    const revision = record!.nextRevision;
    record!.nextRevision += 1;
    record!.publication = {
      generation: input.fence.generation,
      revision,
      workspaceCandidate: { ...input.workspaceCandidate },
      outputCandidate:
        input.outputCandidate === null ? null : { ...input.outputCandidate },
      ...(input.runtimeCheckpoint === undefined
        ? {}
        : { runtimeCheckpoint: input.runtimeCheckpoint }),
    };
    return { type: "published", revision };
  }

  async release(input: { fence: RuntimeResourceFence }): Promise<void> {
    const record = this.#records.get(scopeKey(input.fence));
    if (record !== undefined && record.active !== null && sameFence(record.active, input.fence)) {
      record.active = null;
    }
  }

  inspect(scope: RuntimeResourceScope): Readonly<FenceRecord> | null {
    const record = this.#records.get(scopeKey(scope));
    return record === undefined ? null : structuredClone(record);
  }

  #isCurrent(
    record: FenceRecord | undefined,
    fence: RuntimeResourceFence,
  ): boolean {
    return (
      record?.active !== null &&
      record?.active !== undefined &&
      sameFence(record.active, fence) &&
      Date.parse(record.active.expiresAt) > this.#now().getTime()
    );
  }
}

function orphanErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MemoryRuntimeOrphanPort implements RuntimeOrphanPort {
  readonly #records = new Map<string, RuntimeOrphanRecord>();

  async enqueue(input: Parameters<RuntimeOrphanPort["enqueue"]>[0]): Promise<void> {
    const id = runtimeOrphanId(input);
    const existing = this.#records.get(id);
    this.#records.set(id, {
      id,
      scope: { ...input.scope },
      generation: input.generation,
      ownerId: input.ownerId,
      sandbox: {
        ...input.sandbox,
        ...(input.sandbox.metadata === undefined
          ? {}
          : { metadata: { ...input.sandbox.metadata } }),
      },
      reason: input.reason,
      attempts: existing?.attempts ?? 0,
      lastError: orphanErrorMessage(input.error),
    });
  }

  async list(input: { limit: number }): Promise<readonly RuntimeOrphanRecord[]> {
    return [...this.#records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }

  async failed(input: { id: string; error: unknown }): Promise<void> {
    const record = this.#records.get(input.id);
    if (record === undefined) return;
    this.#records.set(input.id, {
      ...record,
      attempts: record.attempts + 1,
      lastError: orphanErrorMessage(input.error),
    });
  }

  async resolve(input: { id: string }): Promise<void> {
    this.#records.delete(input.id);
  }
}
