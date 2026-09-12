import type {
  AcknowledgeEnvironmentWorkCommand,
  AcknowledgeEnvironmentWorkResult,
  EnvironmentWorkApplicationPort,
  EnvironmentWorkResult,
  GetEnvironmentWorkQueueStatsQuery,
  GetEnvironmentWorkQueueStatsResult,
  HeartbeatEnvironmentWorkCommand,
  HeartbeatEnvironmentWorkResult,
  ListEnvironmentWorkQuery,
  ListEnvironmentWorkResult,
  PollEnvironmentWorkQuery,
  PollEnvironmentWorkResult,
  RetrieveEnvironmentWorkQuery,
  StopEnvironmentWorkCommand,
  StopEnvironmentWorkResult,
  UpdateEnvironmentWorkCommand,
  UpdateEnvironmentWorkResult,
} from "../ports/environment-work";
import type { EnvironmentWorkAvailabilityWaiterPort } from "./availability-waiter";
import type { EnvironmentWorkEnvironmentSourcePort } from "./environment-source";
import type { EnvironmentWorkSessionCredentialIssuerPort } from "./credential-issuer";
import type {
  EnvironmentWorkStore,
  EnvironmentWorkRecord,
  ReplaceEnvironmentWorkRecordResult,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_RECLAIM_MILLISECONDS = 5_000;
const DEFAULT_HEARTBEAT_TTL_SECONDS = 90;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeWorkCursor(record: StoredEnvironmentWork): string {
  return [
    "environment-work",
    encodeCursorPart(record.work.environmentId),
    encodeCursorPart(record.work.createdAt),
    encodeCursorPart(record.work.id),
  ].join(".");
}

function decodeWorkCursor(
  value: string,
  environmentId: string,
): { createdAt: string; workId: string } | null {
  const [scope, encodedEnvironmentId, createdAt, workId, extra] = value.split(".");
  if (
    scope !== "environment-work" ||
    encodedEnvironmentId === undefined ||
    createdAt === undefined ||
    workId === undefined ||
    extra !== undefined
  ) return null;
  const decodedEnvironmentId = decodeCursorPart(encodedEnvironmentId);
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedWorkId = decodeCursorPart(workId);
  if (
    decodedEnvironmentId !== environmentId ||
    decodedCreatedAt === null ||
    decodedWorkId === null ||
    decodedWorkId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, workId: decodedWorkId };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function validateMetadata(metadata: Record<string, string>): string | null {
  const entries = Object.entries(metadata);
  if (entries.length > 16) return "Work metadata may contain at most 16 keys";
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 64) {
      return "Work metadata keys must contain 1 to 64 characters";
    }
    if (value.length > 512) {
      return "Work metadata values may contain at most 512 characters";
    }
  }
  return null;
}

function recordWithoutRevision(record: StoredEnvironmentWork): EnvironmentWorkRecord {
  return {
    work: record.work,
    secret: record.secret,
    claim: record.claim,
    heartbeatTtlSeconds: record.heartbeatTtlSeconds,
  };
}

function view(record: StoredEnvironmentWork, exposeSecret: boolean) {
  return {
    ...record.work,
    secret: exposeSecret ? structuredClone(record.secret) : null,
  };
}

export interface EnvironmentWorkApplicationServiceDependencies {
  workspaceId: string;
  environments: EnvironmentWorkEnvironmentSourcePort;
  store: EnvironmentWorkStore;
  availability: EnvironmentWorkAvailabilityWaiterPort;
  credentials: EnvironmentWorkSessionCredentialIssuerPort;
  clock: { now(): Date };
}

export class EnvironmentWorkApplicationService
  implements EnvironmentWorkApplicationPort
{
  constructor(
    private readonly dependencies: EnvironmentWorkApplicationServiceDependencies,
  ) {}

  async retrieveEnvironmentWork(
    query: RetrieveEnvironmentWorkQuery,
  ): Promise<EnvironmentWorkResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
      workId: query.workId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", work: view(record, false) };
  }

  async updateEnvironmentWork(
    command: UpdateEnvironmentWorkCommand,
  ): Promise<UpdateEnvironmentWorkResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
    });
    if (current === null) return { type: "not_found" };
    const metadata = patchMetadata(current.work.metadata, command.metadata);
    const invalid = validateMetadata(metadata);
    if (invalid !== null) return { type: "invalid_request", message: invalid };
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
      expectedRevision: current.revision,
      next: {
        ...recordWithoutRevision(current),
        work: { ...current.work, metadata },
      },
    });
    return this.updatedResult(replaced);
  }

  async listEnvironmentWork(
    query: ListEnvironmentWorkQuery,
  ): Promise<ListEnvironmentWorkResult> {
    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
    });
    if (environment === null || environment.archivedAt !== null) {
      return { type: "not_found" };
    }
    const position =
      query.cursor === undefined
        ? undefined
        : decodeWorkCursor(query.cursor, query.environmentId);
    if (query.cursor !== undefined && position === null) {
      return { type: "invalid_request", message: "Invalid work page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
      limit: pageSize + 1,
      ...(position !== undefined && position !== null && { position }),
    });
    const page = records.slice(0, pageSize);
    return {
      type: "page",
      page: {
        workItems: page.map((record) => view(record, false)),
        nextCursor:
          records.length > pageSize && page.length > 0
            ? encodeWorkCursor(page[page.length - 1]!)
            : null,
      },
    };
  }

  async acknowledgeEnvironmentWork(
    command: AcknowledgeEnvironmentWorkCommand,
  ): Promise<AcknowledgeEnvironmentWorkResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
    });
    if (current === null) return { type: "not_found" };
    if (current.work.state !== "queued" || current.claim === null) {
      return {
        type: "conflict",
        message: `Work ${command.workId} is not a claimed queued item`,
      };
    }
    const acknowledgedAt = this.dependencies.clock.now().toISOString();
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
      expectedRevision: current.revision,
      next: {
        ...recordWithoutRevision(current),
        claim: {
          ...current.claim,
          claimedAt: acknowledgedAt,
        },
        work: {
          ...current.work,
          acknowledgedAt,
          state: "starting",
        },
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Work changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "acknowledged", work: view(replaced.record, false) };
  }

  async heartbeatEnvironmentWork(
    command: HeartbeatEnvironmentWorkCommand,
  ): Promise<HeartbeatEnvironmentWorkResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
    });
    if (current === null) return { type: "not_found" };
    const now = this.dependencies.clock.now();
    const leaseHasExpired =
      (current.work.state === "starting" || current.work.state === "active") &&
      current.claim !== null &&
      Date.parse(current.claim.claimedAt) + current.heartbeatTtlSeconds * 1_000 <=
        now.getTime();
    if (leaseHasExpired) {
      return {
        type: "precondition_failed",
        message: `Work ${command.workId} heartbeat lease has expired`,
      };
    }
    const expected = command.expectedLastHeartbeat;
    const expectationMatches =
      expected == null ||
      (expected === "NO_HEARTBEAT"
        ? current.work.latestHeartbeatAt === null
        : current.work.latestHeartbeatAt === expected);
    if (!expectationMatches) {
      return {
        type: "precondition_failed",
        message: `Work ${command.workId} heartbeat precondition did not match`,
      };
    }
    if (current.work.state === "queued") {
      return {
        type: "precondition_failed",
        message: `Work ${command.workId} must be acknowledged before heartbeating`,
      };
    }
    const timestamp = now.toISOString();
    const ttlSeconds = command.desiredTtlSeconds ?? current.heartbeatTtlSeconds;
    const leaseExtended =
      current.work.state === "starting" || current.work.state === "active";
    const nextState =
      current.work.state === "starting" ? "active" : current.work.state;
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
      expectedRevision: current.revision,
      next: {
        ...recordWithoutRevision(current),
        ...(leaseExtended && {
          claim: {
            claimedAt: timestamp,
            workerId: current.claim?.workerId ?? null,
            generation: current.claim?.generation ?? 0,
          },
        }),
        heartbeatTtlSeconds: ttlSeconds,
        work: {
          ...current.work,
          latestHeartbeatAt: timestamp,
          ...(current.work.state === "starting" &&
            current.work.startedAt === null && { startedAt: timestamp }),
          state: nextState,
        },
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "precondition_failed",
        message: `Work changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return {
      type: "recorded",
      heartbeat: {
        lastHeartbeat: replaced.record.work.latestHeartbeatAt!,
        leaseExtended,
        state: replaced.record.work.state,
        ttlSeconds: replaced.record.heartbeatTtlSeconds,
      },
    };
  }

  async pollEnvironmentWork(
    query: PollEnvironmentWorkQuery,
  ): Promise<PollEnvironmentWorkResult> {
    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
    });
    if (environment === null || environment.archivedAt !== null) {
      return { type: "not_found" };
    }
    const now = this.dependencies.clock.now();
    const claimedAt = now.toISOString();
    const reclaimMilliseconds = Math.max(
      query.reclaimOlderThanMilliseconds ?? DEFAULT_RECLAIM_MILLISECONDS,
      0,
    );
    const claim = () =>
      this.dependencies.store.claimAvailable({
        workspaceId: this.dependencies.workspaceId,
        environmentId: query.environmentId,
        claimedAt,
        reclaimBefore: new Date(now.getTime() - reclaimMilliseconds).toISOString(),
        workerId: query.workerId ?? null,
        heartbeatTtlSeconds: DEFAULT_HEARTBEAT_TTL_SECONDS,
      });
    let result = await claim();
    const blockMilliseconds = query.blockMilliseconds ?? 0;
    if (result.type === "empty" && blockMilliseconds > 0) {
      await this.dependencies.availability.wait({
        workspaceId: this.dependencies.workspaceId,
        environmentId: query.environmentId,
        maximumWaitMilliseconds: blockMilliseconds,
      });
      result = await claim();
    }
    if (result.type === "empty") return { type: "empty" };
    if (result.record.claim === null) {
      throw new Error("Claimed Environment Work is missing its ownership claim");
    }
    const bound = await this.dependencies.credentials.bindToClaim({
      secret: result.record.secret,
      claimedAt: result.record.claim.claimedAt,
      generation: result.record.claim.generation,
    });
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
      workId: result.record.work.id,
      expectedRevision: result.record.revision,
      next: {
        ...recordWithoutRevision(result.record),
        secret: bound.secret,
      },
    });
    if (replaced.type !== "replaced") {
      throw new Error(
        `Environment Work claim credential binding lost revision ${result.record.revision}`,
      );
    }
    return { type: "work", work: view(replaced.record, true) };
  }

  async getEnvironmentWorkQueueStats(
    query: GetEnvironmentWorkQueueStatsQuery,
  ): Promise<GetEnvironmentWorkQueueStatsResult> {
    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
    });
    if (environment === null || environment.archivedAt !== null) {
      return { type: "not_found" };
    }
    const now = this.dependencies.clock.now();
    const stats = await this.dependencies.store.queueStats({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
      workerActiveSince: new Date(now.getTime() - 30_000).toISOString(),
    });
    return { type: "found", stats };
  }

  async stopEnvironmentWork(
    command: StopEnvironmentWorkCommand,
  ): Promise<StopEnvironmentWorkResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
    });
    if (current === null) return { type: "not_found" };
    if (current.work.state === "stopped") {
      return {
        type: "conflict",
        message: `Work ${command.workId} is already stopped`,
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const stopped = command.force === true || current.work.state === "queued";
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      workId: command.workId,
      expectedRevision: current.revision,
      next: {
        ...recordWithoutRevision(current),
        ...(stopped && { claim: null }),
        work: {
          ...current.work,
          state: stopped ? "stopped" : "stopping",
          stopRequestedAt: current.work.stopRequestedAt ?? timestamp,
          ...(stopped && { stoppedAt: timestamp }),
        },
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Work changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "stopped", work: view(replaced.record, false) };
  }

  private updatedResult(
    result: ReplaceEnvironmentWorkRecordResult,
  ): UpdateEnvironmentWorkResult {
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Work changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return { type: "updated", work: view(result.record, false) };
  }
}
