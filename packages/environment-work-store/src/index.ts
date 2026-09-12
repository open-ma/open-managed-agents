import type {
  EnvironmentWork,
  EnvironmentWorkQueueStats,
  EnvironmentWorkSecret,
} from "@open-managed-agents/domain/environment-work";

export type { EnvironmentWorkQueueStats } from "@open-managed-agents/domain/environment-work";

export interface EnvironmentWorkClaim {
  claimedAt: string;
  workerId: string | null;
  /** Monotonic per-Work ownership generation; unchanged by heartbeats. */
  generation: number;
}

export interface EnvironmentWorkRecord {
  work: EnvironmentWork;
  secret: EnvironmentWorkSecret;
  claim: EnvironmentWorkClaim | null;
  heartbeatTtlSeconds: number;
}

export interface StoredEnvironmentWork extends EnvironmentWorkRecord {
  revision: number;
}

export interface EnvironmentWorkLocation {
  workspaceId: string;
  environmentId: string;
  workId: string;
}

export interface FindActiveEnvironmentSessionWork {
  workspaceId: string;
  sessionId: string;
}

export interface InsertEnvironmentWorkRecord {
  workspaceId: string;
  record: EnvironmentWorkRecord;
}

export interface ReplaceEnvironmentWorkRecord extends EnvironmentWorkLocation {
  expectedRevision: number;
  next: EnvironmentWorkRecord;
}

export type ReplaceEnvironmentWorkRecordResult =
  | { type: "replaced"; record: StoredEnvironmentWork }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface EnvironmentWorkListPosition {
  createdAt: string;
  workId: string;
}

export interface ListEnvironmentWorkRecords {
  workspaceId: string;
  environmentId: string;
  limit: number;
  position?: EnvironmentWorkListPosition;
}

export interface ClaimAvailableEnvironmentWork {
  workspaceId: string;
  environmentId: string;
  claimedAt: string;
  reclaimBefore: string;
  workerId: string | null;
  /** Fresh lease TTL. Reclaim must not inherit the expired generation's TTL. */
  heartbeatTtlSeconds: number;
}

export type ClaimAvailableEnvironmentWorkResult =
  | { type: "claimed"; record: StoredEnvironmentWork }
  | { type: "empty" };

export interface GetEnvironmentWorkQueueStatsRecord {
  workspaceId: string;
  environmentId: string;
  workerActiveSince: string;
}

export interface EnvironmentWorkStore {
  insert(input: InsertEnvironmentWorkRecord): Promise<StoredEnvironmentWork>;
  find(input: EnvironmentWorkLocation): Promise<StoredEnvironmentWork | null>;
  findActiveSession(
    input: FindActiveEnvironmentSessionWork,
  ): Promise<StoredEnvironmentWork | null>;
  list(input: ListEnvironmentWorkRecords): Promise<StoredEnvironmentWork[]>;
  replace(
    input: ReplaceEnvironmentWorkRecord,
  ): Promise<ReplaceEnvironmentWorkRecordResult>;
  claimAvailable(
    input: ClaimAvailableEnvironmentWork,
  ): Promise<ClaimAvailableEnvironmentWorkResult>;
  queueStats(
    input: GetEnvironmentWorkQueueStatsRecord,
  ): Promise<EnvironmentWorkQueueStats>;
}

export interface CurrentEnvironmentWorkClaim {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  claimedAt: string;
  generation: number;
  token: string;
  method: string;
  path: string;
}

/**
 * Resolve a bearer against the current claimed Work, not merely its
 * cryptographic expiry. A replacement claim rotates the stored token and
 * immediately fences the previous executor from canonical Session writes.
 */
export async function isCurrentEnvironmentWorkClaim(
  dependencies: { store: EnvironmentWorkStore; now(): Date },
  claim: CurrentEnvironmentWorkClaim,
): Promise<boolean> {
  const current = await dependencies.store.find({
    workspaceId: claim.workspaceId,
    environmentId: claim.environmentId,
    workId: claim.workId,
  });
  if (
    current === null
    || current.work.data.type !== "session"
    || current.work.data.id !== claim.sessionId
    || current.claim === null
    || current.claim.generation !== claim.generation
    || current.secret.sessionsToken !== claim.token
  ) return false;

  const workControlRequest = claim.path.startsWith(
    `/v1/environments/${encodeURIComponent(claim.environmentId)}/work/${encodeURIComponent(claim.workId)}/`,
  );
  if (
    current.work.state !== "starting"
    && current.work.state !== "active"
    && !(current.work.state === "stopping" && workControlRequest)
  ) return false;

  // Heartbeat and stop are the Work protocol's authority checks. Let the
  // current claim reach them even after its TTL so the application can return
  // the canonical 412 (or complete cleanup). An expired executor must never
  // use the same grace path to append Session state.
  if (workControlRequest) return true;
  return Date.parse(current.claim.claimedAt)
    + current.heartbeatTtlSeconds * 1_000
    > dependencies.now().getTime();
}
