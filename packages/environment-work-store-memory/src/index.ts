import type { EnvironmentWorkQueueStats } from "@open-managed-agents/domain/environment-work";
import type {
  ClaimAvailableEnvironmentWork,
  ClaimAvailableEnvironmentWorkResult,
  EnvironmentWorkLocation,
  EnvironmentWorkRecord,
  EnvironmentWorkStore,
  FindActiveEnvironmentSessionWork,
  GetEnvironmentWorkQueueStatsRecord,
  InsertEnvironmentWorkRecord,
  ListEnvironmentWorkRecords,
  ReplaceEnvironmentWorkRecord,
  ReplaceEnvironmentWorkRecordResult,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";

function key(workspaceId: string, environmentId: string, workId: string): string {
  return `${workspaceId}\u0000${environmentId}\u0000${workId}`;
}

function workerKey(workspaceId: string, environmentId: string, workerId: string): string {
  return `${workspaceId}\u0000${environmentId}\u0000${workerId}`;
}

function cloneRecord(record: EnvironmentWorkRecord): EnvironmentWorkRecord {
  return {
    work: {
      ...record.work,
      data: { ...record.work.data },
      metadata: { ...record.work.metadata },
    },
    secret: { ...record.secret },
    claim: record.claim === null ? null : { ...record.claim },
    heartbeatTtlSeconds: record.heartbeatTtlSeconds,
  };
}

function cloneStored(record: StoredEnvironmentWork): StoredEnvironmentWork {
  return { ...cloneRecord(record), revision: record.revision };
}

function descending(left: StoredEnvironmentWork, right: StoredEnvironmentWork): number {
  return right.work.createdAt.localeCompare(left.work.createdAt)
    || right.work.id.localeCompare(left.work.id);
}

function hasExpiredLease(record: StoredEnvironmentWork, claimedAt: string): boolean {
  if (record.work.state !== "starting" && record.work.state !== "active") {
    return false;
  }
  if (record.claim === null) return false;
  return Date.parse(record.claim.claimedAt) + record.heartbeatTtlSeconds * 1_000
    <= Date.parse(claimedAt);
}

function requeueExpiredLease(
  record: StoredEnvironmentWork,
  heartbeatTtlSeconds: number,
): EnvironmentWorkRecord {
  return {
    ...cloneRecord(record),
    heartbeatTtlSeconds,
    work: {
      ...record.work,
      acknowledgedAt: null,
      latestHeartbeatAt: null,
      startedAt: null,
      state: "queued",
    },
  };
}

export class MemoryEnvironmentWorkStore implements EnvironmentWorkStore {
  private readonly records = new Map<string, StoredEnvironmentWork>();
  private readonly workerPolls = new Map<string, string>();

  async insert(input: InsertEnvironmentWorkRecord): Promise<StoredEnvironmentWork> {
    const recordKey = key(
      input.workspaceId,
      input.record.work.environmentId,
      input.record.work.id,
    );
    if (this.records.has(recordKey)) {
      throw new Error(`Environment Work ${input.record.work.id} already exists`);
    }
    const stored = { ...cloneRecord(input.record), revision: 1 };
    this.records.set(recordKey, stored);
    return cloneStored(stored);
  }

  async find(input: EnvironmentWorkLocation): Promise<StoredEnvironmentWork | null> {
    const record = this.records.get(
      key(input.workspaceId, input.environmentId, input.workId),
    );
    return record === undefined ? null : cloneStored(record);
  }

  async findActiveSession(
    input: FindActiveEnvironmentSessionWork,
  ): Promise<StoredEnvironmentWork | null> {
    const record = [...this.records.entries()]
      .filter(([recordKey, candidate]) =>
        recordKey.startsWith(`${input.workspaceId}\u0000`)
        && candidate.work.state !== "stopped"
        && candidate.work.data.type === "session"
        && candidate.work.data.id === input.sessionId
      )
      .map(([, candidate]) => candidate)
      .sort(descending)[0];
    return record === undefined ? null : cloneStored(record);
  }

  async list(input: ListEnvironmentWorkRecords): Promise<StoredEnvironmentWork[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Environment Work list limit must be a positive integer");
    }
    return [...this.records.entries()]
      .filter(([recordKey, candidate]) =>
        recordKey.startsWith(`${input.workspaceId}\u0000${input.environmentId}\u0000`)
        && (input.position === undefined
          || candidate.work.createdAt < input.position.createdAt
          || (candidate.work.createdAt === input.position.createdAt
            && candidate.work.id < input.position.workId))
      )
      .map(([, candidate]) => candidate)
      .sort(descending)
      .slice(0, input.limit)
      .map(cloneStored);
  }

  async replace(
    input: ReplaceEnvironmentWorkRecord,
  ): Promise<ReplaceEnvironmentWorkRecordResult> {
    if (
      input.next.work.id !== input.workId
      || input.next.work.environmentId !== input.environmentId
    ) {
      throw new Error("Replacement Environment Work identity does not match its target");
    }
    const recordKey = key(input.workspaceId, input.environmentId, input.workId);
    const current = this.records.get(recordKey);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      ...cloneRecord(input.next),
      revision: current.revision + 1,
    };
    this.records.set(recordKey, record);
    return { type: "replaced", record: cloneStored(record) };
  }

  async claimAvailable(
    input: ClaimAvailableEnvironmentWork,
  ): Promise<ClaimAvailableEnvironmentWorkResult> {
    if (input.workerId !== null) {
      this.workerPolls.set(
        workerKey(input.workspaceId, input.environmentId, input.workerId),
        input.claimedAt,
      );
    }
    const candidate = [...this.records.entries()]
      .filter(([recordKey, record]) =>
        recordKey.startsWith(`${input.workspaceId}\u0000${input.environmentId}\u0000`)
        && ((record.work.state === "queued"
          && (record.claim === null
            || record.claim.claimedAt <= input.reclaimBefore))
          || hasExpiredLease(record, input.claimedAt))
      )
      .sort((left, right) =>
        left[1].work.createdAt.localeCompare(right[1].work.createdAt)
        || left[1].work.id.localeCompare(right[1].work.id)
      )[0];
    if (candidate === undefined) return { type: "empty" };
    const [recordKey, current] = candidate;
    const next = hasExpiredLease(current, input.claimedAt)
      ? requeueExpiredLease(current, input.heartbeatTtlSeconds)
      : cloneRecord(current);
    const record: StoredEnvironmentWork = {
      ...next,
      claim: {
        claimedAt: input.claimedAt,
        workerId: input.workerId,
        generation: (current.claim?.generation ?? 0) + 1,
      },
      revision: current.revision + 1,
    };
    this.records.set(recordKey, record);
    return { type: "claimed", record: cloneStored(record) };
  }

  async queueStats(
    input: GetEnvironmentWorkQueueStatsRecord,
  ): Promise<EnvironmentWorkQueueStats> {
    const queued = [...this.records.entries()]
      .filter(([recordKey, record]) =>
        recordKey.startsWith(`${input.workspaceId}\u0000${input.environmentId}\u0000`)
        && record.work.state === "queued"
      )
      .map(([, record]) => record);
    const workerPrefix = `${input.workspaceId}\u0000${input.environmentId}\u0000`;
    const workerPolls = [...this.workerPolls.entries()]
      .filter(([pollKey]) => pollKey.startsWith(workerPrefix))
      .map(([, polledAt]) => polledAt);
    return {
      depth: queued.filter((record) => record.claim === null).length,
      oldestQueuedAt: queued.length === 0
        ? null
        : queued.map((record) => record.work.createdAt).sort()[0]!,
      pending: queued.filter((record) => record.claim !== null).length,
      workersPolling: workerPolls.length === 0
        ? null
        : workerPolls.filter((polledAt) => polledAt >= input.workerActiveSince).length,
    };
  }
}
