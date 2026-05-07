# Memory write reflection: queue → port

**Status**: design proposal
**Authors**: this branch, May 2026
**Replaces**: ad-hoc `queues.consumers` strip in lane / staging wrangler configs

## What we're trying to do

When an agent writes to `/mnt/memory/<store_id>/<path>` (FUSE mount on
remote sandbox, or symlink on LocalSubprocess), OMA needs to **reflect
that write into D1** so the `memories` index + `memory_versions` audit
table catch up. This is "memory write observability" — we don't gate
the write on it, we just need to learn about it eventually so the
control plane has a consistent view.

REST API writes to `/v1/memory_stores/.../memories` already update D1
inline at the route handler. The observability path is for **the writes
that bypass REST** (FUSE / symlink / direct R2 PUT).

## What we have today

Two implementations, one for each platform, doing the same job:

```
CF prod:
  agent FUSE write
    → R2 PUT (managed-agents-memory)
    → R2 Event Notification (set up out-of-band: wrangler r2 bucket notification create)
    → CF Queue managed-agents-memory-events
    → consumer in apps/main/src/queue/memory-events.ts
    → D1 (memories index UPSERT, memory_versions INSERT)

CFless (Node + Docker):
  agent symlink write
    → LocalFs ./data/memory-blobs/<store>/<path>
    → chokidar watcher in apps/main-node/src/lib/memory-blob-watcher.ts
    → SQL (same memories + memory_versions)
```

The two consumers share **almost identical reflection logic**: parse
key → read object metadata → dedupe by `(store_id, path, etag)` →
upsert + insert audit. But there's no shared abstraction; the logic
lives twice.

## Pain points

1. **CF Queue single-consumer rule.** A queue can have exactly ONE
   consumer worker. This collides with multi-environment:
   - `managed-agents-memory-events` is consumed by prod's main worker
   - Lane `main` worker can't co-consume the same queue (CF rejects
     deploy with code 11004)
   - Staging recently dropped its consumer too (commit `bc7fac0`) for
     the same reason once lane started sharing the staging pool

   Result: only prod actually reflects FUSE writes to D1. Lane +
   staging silently drop the audit on FUSE writes — REST writes still
   work, but the agent writing via FUSE produces no `memory_versions`
   row in those envs. Tests + dev miss the audit path entirely.

2. **Per-env infrastructure multiplication.** Each env wants its own
   bucket + queue + R2 notification + DLQ. Currently 1 queue is being
   force-shared by 2 envs. The "right" answer per env would be 3
   queues × 3 buckets × 3 R2-notification setups + 3 DLQs — none of
   that scales operationally.

3. **No CFless story for the FUSE-bypassing-REST case.** Today the
   chokidar watcher only handles `LocalFsBlobStore` writes (file
   appears in `./data/memory-blobs/`). Remote sandbox (Daytona / E2B /
   BoxRun) FUSE-mounted via s3fs writes to S3, nobody's listening on
   the S3 side, D1 never reflects. Already broken silently.

4. **Multi-tenant pressure.** All tenants' writes share one queue;
   one tenant doing 10K writes/sec starves the others' reflection
   latency. No per-tenant backpressure.

5. **Failure mode is opaque.** If the consumer fails for an hour
   (DLQ fills), reads still work (R2 has the bytes) but D1 is stale.
   Current code has no "did D1 fall behind?" signal — operators
   only know via missing audit rows.

## Design goals

| | What it means concretely |
|---|---|
| Same conceptual contract on every platform | One `MemoryWriteObserver` port, multiple adapters. Adding a 4th deploy mode (e.g. fly.io with NFS) = new adapter, business code unchanged. |
| Multi-env stops being painful | Each env picks its own observer wiring; lane / staging / prod can coexist without single-consumer fights |
| Self-host doesn't need CF Queue | The whole pipeline must be implementable with zero CF dependencies |
| Failure mode is loud | When reflection lags, the system says so (metric / health endpoint), and there's a backstop reconciler |
| Remote sandbox FUSE writes get reflected too | Today silently dropped on Daytona / E2B / BoxRun + S3 memory mount — must work |

## Proposed design

### 1. Define the port

`packages/memory-store/src/ports/observer.ts` (NEW):

```ts
/** A single observed memory write. Source-agnostic. */
export interface MemoryWriteEvent {
  storeId: string;
  /** Memory path within the store, e.g. "thoughts/2026-05-07.md". */
  path: string;
  /** Object content hash (R2 etag, or chokidar hash of the file). */
  etag: string;
  sizeBytes: number;
  action: "put" | "delete";
  /** Optional tenant for routing — falls back to store's owning tenant. */
  tenantId?: string;
}

/** Backend-agnostic reflection sink. Each adapter (CF Queue / chokidar /
 *  inline RPC / periodic R2 list) reads its source and calls reflect()
 *  to update the D1/SQL projection. */
export interface MemoryWriteObserver {
  reflect(event: MemoryWriteEvent): Promise<void>;
  /** Bulk variant for when an adapter has many at once (queue batch,
   *  initial chokidar scan). Implementations may dedupe / batch SQL. */
  reflectMany?(events: MemoryWriteEvent[]): Promise<void>;
}
```

The reflection logic that's currently duplicated in
`apps/main/src/queue/memory-events.ts` and
`apps/main-node/src/lib/memory-blob-watcher.ts` moves into a single
implementation behind this port.

### 2. Move reflection logic into the package

`packages/memory-store/src/observer-impl.ts` (NEW):

```ts
export class SqlMemoryObserver implements MemoryWriteObserver {
  constructor(
    private sql: SqlClient,
    private blobs: BlobStore,
    private opts?: { dedupeWindowMs?: number },
  ) {}

  async reflect(event: MemoryWriteEvent): Promise<void> {
    // The 100-line dedupe + UPSERT + INSERT audit logic that's
    // currently inlined in apps/main/src/queue/memory-events.ts +
    // mirrored in apps/main-node/src/lib/memory-blob-watcher.ts —
    // lifted out, single source of truth.
  }
}
```

### 3. Adapters per source

Each is a thin shim that reads its source, builds `MemoryWriteEvent`s,
calls `observer.reflect()`. Adapters live next to where they make
sense:

| Adapter | Source | Where | When to use |
|---|---|---|---|
| `R2QueueAdapter` | CF Queue ← R2 events | `apps/main/src/queue/memory-events.ts` (refactored) | CF prod (only) |
| `LocalFsChokidarAdapter` | chokidar on `./data/memory-blobs/` | `apps/main-node/src/lib/memory-blob-watcher.ts` (refactored) | CFless w/ LocalFsBlobStore |
| `S3PollAdapter` | periodic `ListObjectsV2` on remote S3 | NEW `packages/memory-store/src/adapters/s3-poll.ts` | CFless + remote sandbox (Daytona/E2B/BoxRun w/ MEMORY_S3_*) |
| `InlineNotifyAdapter` | sandbox calls main's `notifyWrite` RPC after FUSE write | NEW; needs sandbox-side hook | Eliminates queue dep entirely if added |
| `R2ListReconciler` | periodic R2 list, diff against D1 | NEW cron in `apps/main` | Backstop on CF for missed queue events; lane uses this *instead* of consuming the queue |

### 4. Per-env wiring matrix

| Env | Primary reflection | Backstop |
|---|---|---|
| **CF prod** | R2QueueAdapter (consumer of `managed-agents-memory-events`) | R2ListReconciler hourly cron (catches DLQ-failed events) |
| **CF staging** | R2QueueAdapter on `managed-agents-memory-events-staging` | R2ListReconciler |
| **CF lane** | none (no queue consumer — leave the staging queue to staging worker) | R2ListReconciler hourly cron, scoped to lane's R2 prefix |
| **CFless self-host (LocalFs sandbox)** | LocalFsChokidarAdapter | none needed (chokidar is reliable on local FS) |
| **CFless self-host (S3 memory mount)** | S3PollAdapter (poll every 30s) | — |
| **Future**: any platform via sandbox-side hook | InlineNotifyAdapter | Existing cron |

The lane wiring becomes principled: lane skips the realtime queue
because it's contended; the periodic reconciler picks up changes for
testing purposes within an hour. Acceptable for a per-PR test env.

### 5. Health signal

Adapters report "lag" — last successful reflection timestamp.
`/health` exposes:

```json
{
  "memory_reflection": {
    "primary_adapter": "r2-queue",
    "last_event_at": "2026-05-07T08:30:12Z",
    "lag_seconds": 4
  }
}
```

Operators can alert on `lag_seconds > 600`. Today this is invisible;
the queue silently piling up looks identical to "no writes happening."

## Implementation phases

**Phase 1 — Port + extraction (no behavior change)**

- Add `MemoryWriteObserver` port + `SqlMemoryObserver` implementation
  in `packages/memory-store/`
- Refactor existing `memory-events.ts` (CF) to be a thin
  `R2QueueAdapter` calling the observer
- Refactor existing `memory-blob-watcher.ts` (CFless) to be a
  `LocalFsChokidarAdapter` calling the observer
- All current tests continue to pass; one place to maintain reflection
  logic from now on

**Phase 2 — Backstop reconciler (CF prod first)**

- Add `R2ListReconciler` as a cron handler in `apps/main`
- Hourly walk through R2 prefix, diff against D1, fill gaps
- Lane workflow now wires reconciler instead of queue consumer
  (replaces current "strip queues.consumers" patch with a real path)

**Phase 3 — S3PollAdapter (unblocks remote-sandbox CFless)**

- For CFless deploys with `MEMORY_S3_*` set, poll the bucket
- Currently remote-sandbox FUSE writes are silently dropped from D1
- Phase 3 fixes that without inventing a queue infrastructure

**Phase 4 — InlineNotifyAdapter (eventually deprecate the queue)**

- Add a sandbox-side post-write RPC to main
- Once stable, can deprecate R2 Event Notification dependency
- Reduces CF infra: no queue, no R2 notification setup, just service
  binding (which we already have for vault credential injection)

## What this is NOT

- Not changing the SQL projection schema (memories + memory_versions
  stay as-is)
- Not changing the agent-facing API (`/v1/memory_stores/.../memories`
  inline-write path unchanged; that's the source-of-truth for REST
  writes and never depended on the queue)
- Not introducing a new dependency (S3PollAdapter uses the AWS SDK
  we'd already need for `S3BlobStore` if we ever added it; no new
  npm dep beyond that)
- Not touching tenant DB sharding (works orthogonally — the observer
  writes to the SqlClient passed in; per-tenant SqlClient = per-tenant
  reflection automatically)

## Open questions

1. **Cross-tenant routing.** When CF Queue → consumer fans out, how
   does the consumer pick the tenant's SqlClient? Today main's
   `services.sessions` accessor takes tenantId. We'd need to derive
   tenantId from `<store_id>` (which today maps 1:1 to a tenant via
   `memory_stores.tenant_id`). One D1 query per batch to derive the
   mapping; cheap.

2. **R2ListReconciler cost.** `ListObjectsV2` on a 10M-object bucket
   is paginated + slow + expensive. For the cron backstop we should
   list with `--prefix` per-store, not whole-bucket. Cron iterates
   stores from the D1 store registry.

3. **InlineNotifyAdapter and idempotency.** A FUSE-write-then-
   crash-before-RPC scenario means the notify never fires. The cron
   reconciler is the safety net. Worth confirming the reconciler
   runs frequently enough to catch this within SLA (today: target ~1
   hour).

## Recommendation

Do Phase 1 only this branch (~ 2 hours). Get the abstraction in,
delete the duplication, ship. Phases 2–4 are independent PRs that
follow once Phase 1 lands.

Phase 1 alone:
- Removes ~400 LOC of duplicated reflection logic
- Doesn't change any current behavior (CF prod queue still works,
  CFless chokidar still works)
- Makes the lane "no queue consumer" patch principled (it's a wiring
  choice, not a workaround)
- Sets up Phase 2/3/4 to be small additive changes, not refactors
