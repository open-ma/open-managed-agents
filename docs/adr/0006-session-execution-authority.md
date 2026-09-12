# ADR 0006: One fenced execution authority for Session turns

**Status**: Accepted (2026-09-04)  
**Related**: [`0005-self-hosted-worker-runtime-resources.md`](./0005-self-hosted-worker-runtime-resources.md), [`v1-architecture.md`](../v1-architecture.md)

## Decision

An accepted batch of Managed Session Events has exactly one durable execution
record. The record is admitted in the same transaction as the Event Log
revision and is claimed through `SessionExecutionStorePort`:

```text
client → Event Log + execution outbox (one CAS/transaction)
                         │
                         ▼
       SessionExecutionStorePort (queue, lease, fence)
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       SessionDO host          Node worker host
              │                     │
              └─────── parent fence┘
                         │
          harness → SandboxPort → output/event ports
```

The SessionDO is a host for one claimed lane, not a second queue or source of
truth. Node workers use the same port against SQLite or PostgreSQL. Cloudflare
uses D1; PostgreSQL is optional and is never required by the public SDK or the
Cloudflare deployment.

## Lease and fencing rules

- Claims are FIFO within `(workspace_id, session_id, lane_id)`; independent
  lanes may run concurrently.
- A claim creates a monotonically increasing `generation`, an opaque
  `attempt_id`, an owner id, a lease expiry, an attempt count, and a total
  deadline. The store is authoritative for every transition.
- The host renews before the lease expires and performs one final renewal
  immediately before settle. A failed renewal aborts the harness and forbids
  settle. `max_attempts` and `deadline_at_ms` bound poison work; expiry makes
  the row failed instead of recycling forever.
- `requestInterrupt` and `cancelSession` update durable execution state. The
  local `AbortController` is only a latency optimization. A replacement host
  observes the same interrupt through claim/renew and cannot resurrect the
  old generation.
- Event, workspace-candidate, output-manifest, and native-session writes are
  accepted only while the current generation is valid. Late writes receive a
  conflict or are dropped at the projection boundary; they never advance the
  active pointer.

The in-process `SessionDO` maps and `status` values are mirrors for UI latency
and backward compatibility. They are not used for recovery or ownership.

## Parent fence and sandbox boundary

The claimed Session fence is passed into the harness context. The portable
`withSandboxExecutionGuard` wrapper checks the parent `AbortSignal` and the
latest lease expiry both before and after every provider/container method.
Read methods are guarded too: a stale hand must not continue collecting or
using a result after losing authority. Pure introspection and local secret
registration are the only exemptions. A `startProcess` handle is terminated
with `SIGTERM` when the parent fence aborts.

Sub-agents are logical child lanes, not independent execution owners. They
inherit the parent sandbox guard and fence; a child-targeted interrupt adds a
child abort signal without granting a second publication authority. Their
events are tagged with the child thread id and projected through the parent
generation.

The DO-local Event Log is wrapped by the same fence for harness-emitted
events. The managed projection RPC receives the fence explicitly. Output
mounts and workspace snapshots remain provider operations, but their writes
are made through the guarded sandbox and their active candidates are
published only by the resource-fence Port.

## Recovery and wakeups

The service-binding dispatch is a wake hint, not delivery authority. If it is
dropped, a DO alarm scans `managed_session_executions` for queued or expired
running rows scoped to that Session and lets the same claim path recover them.
Node workers poll the same table. A dead host therefore leaves durable work
that another host can reclaim after the lease expires; no in-memory turn id is
needed.

Recovery is at-least-once. The execution `attempt_id`/`generation` fence makes
the canonical commit at-most-once, while external tool effects still require
their own idempotency keys. A provider process can remain alive briefly after
network loss, but its sandbox guard and fenced ports prevent canonical writes.

## Migration and compatibility

`0020_session_execution_store.sql` is the Cloudflare migration. Node applies
the generated `0022` migration for SQLite/PostgreSQL. Bootstrap code upgrades
the early preview D1/SQLite table additively before creating the lane index, so
an operator can deploy the code before running the migration without losing
existing rows.

The old DO-local `pending_events`/`turn_id` path is retained only for sessions
without a central execution binding (legacy self-host fixtures and an
explicit migration window). A migrated deployment never admits new work
through that path. Once the migration soak is complete, the compatibility
branch can be removed without changing the Managed Agents API.

## Provider boundaries

The protocol intentionally does not promise one persistence mechanism:

| Provider | Execution store | Workspace | Process memory | Output |
| --- | --- | --- | --- | --- |
| Cloudflare | D1 + SessionDO host | `createBackup`/`restoreBackup` or provider volume | not advertised | R2 collector/manifest |
| Node + Docker | SQLite or PostgreSQL | local volume or immutable archive | not advertised | filesystem collector/object store |
| E2B-compatible | adapter-selected lease store | retained runtime or E2B snapshot | provider-specific, never assumed | adapter-selected collector |

Every provider must advertise capabilities and fail configuration when a
requested durable guarantee is unavailable. A provider-native snapshot is a
workspace candidate until it is published through the OpenMA fence; it is not
automatically a Session checkpoint or a process-memory image.

