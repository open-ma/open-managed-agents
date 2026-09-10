# ADR 0005: AMA-compatible workers with provider-neutral runtime resources

**Status**: Accepted (2026-09-03)  
**Deciders**: Engineering  
**Supersedes**: None  
**Related**: [`v1-architecture.md`](../v1-architecture.md),
[`architecture.md`](../architecture.md)

---

## Context

Anthropic Managed Agents (AMA) standardizes the boundary between its control
plane (the "brain") and a self-hosted environment worker (the "hands"). A
self-hosted environment is declared with only:

```ts
await client.beta.environments.create({
  name: "self-hosted",
  config: { type: "self_hosted" },
});
```

The public environment shape does not declare a sandbox provider, persistence
mode, checkpoint support, output transport, suspend/resume behavior, or
retention policy. The official worker protocol covers work polling and claim,
acknowledgement, heartbeat, stop, per-work credentials, tool results, session
events, skill materialization, and Memory Store synchronization. Attached
files are addressable through the Managed Files API but are not automatically
mounted by the official `EnvironmentWorker`; repositories likewise remain a
runtime concern. For self-hosted environments, sandbox allocation, file and
repository materialization, runtime lifecycle, and durable delivery of
generated files remain the operator's responsibility.

Provider integrations fill that gap independently. Cloudflare, E2B, Daytona,
Modal, Namespace, Vercel, and other platforms expose different combinations
of long-lived volumes, retained runtimes, pause/resume, filesystem snapshots,
portable archives, object storage mounts, and final file collection. These are
provider solutions and templates, not an AMA capability-negotiation protocol.

OpenMA needs both properties:

1. An unmodified official AMA worker must be able to consume OpenMA's
   self-hosted work queue.
2. OpenMA-managed workers must get portable lifecycle, workspace persistence,
   and output delivery semantics across Cloudflare, E2B, Node/Docker, and
   future providers.

The second property must not contaminate the first. In particular, provider
SDKs, mounts, databases, and platform context cannot leak into Managed Agents
HTTP shapes or core application Ports.

## Decision

OpenMA will implement two explicitly separate planes.

### 1. AMA compatibility plane

The Managed Agents API remains the canonical public protocol:

- `Environment.config` is exactly the official shape. A self-hosted
  environment is `{ type: "self_hosted" }`; OpenMA does not add `provider`,
  `volume`, `checkpoint`, or `outputs` fields.
- The Environment Work endpoints and state transitions remain compatible with
  the official SDK and `EnvironmentWorker`.
- Work and webhook payloads remain scheduling signals; they do not embed the
  Session snapshot. After claim/ACK, the worker decodes the claim's
  `sessions_token` and retrieves exactly that Session before selecting a
  runtime profile or starting compute.
- `Session.metadata` is an opaque `Record<string, string>` written by the API
  client. OpenMA preserves it and makes it available to the worker, but does
  not invent a standard repository/file manifest schema.
- `Session.resources` is different: the claimed Session returned by the
  control plane includes the official `file`, `github_repository`, and
  `memory_store` resource records, including mount paths and checkout data.
  The worker/runtime decides how to materialize those records.
- Official SDK workers can point their `baseURL` at OpenMA without importing an
  OpenMA runtime package.
- Environment `metadata` may label an environment for people, but it is never
  interpreted as runtime configuration or capability negotiation.
- Provider selection and credentials are deployment/runtime configuration,
  outside the official Managed Agents lane.

The per-work Session bearer is an exact capability projection of the resolved
Session snapshot. It may retrieve the claimed Session and its events, declared
skills, attached files, attached Memory Stores with their declared access
mode, the bound MCP gateway, and its own Work heartbeat/stop endpoints. It may
not list/upload/delete files, cross to another Session or resource, or mutate a
read-only Memory Store. Claim rotation fences the previous bearer against all
of these routes. A sandbox egress adapter may narrow the reachable route
families further, but the API-side live-claim check remains authoritative.

Memory Store ownership has exactly two lanes. An unmodified `ama_worker` owns
download and read-write synchronization through Anthropic's SDK; OpenMA does
not mount or write the same Store. An `openma_supervised` harness delegates the
same responsibility to `SessionInputMaterializerPort`: `materialize` prepares
the mount and baseline, while `synchronize` runs periodically and immediately
before workspace publication. The Port sees Session-scoped operations, never
the raw bearer. A writable attachment uses create/update/delete CAS, treats a
rename as create-before-delete, and rechecks `RuntimeResourceFencePort` before
each canonical mutation. A reclaimed process can reuse the baseline saved in
the durable workspace; retries after partial success are idempotent because the
next pass re-lists and rebases to the canonical winner.

This protocol persists filesystem and Memory documents, not process memory.
If both a sandbox and its last unpublished workspace checkpoint disappear,
edits made after the most recent periodic sync can still be lost; the default
exposure window is 15 seconds plus provider termination/detection latency.
Conversely, a stale sandbox may keep changing its private filesystem briefly,
but Session-token rotation and per-mutation resource fencing prevent it from
committing Memory or publishing workspace/output candidates after reclaim.

The Work lease is authoritative for the worker-facing control-plane
operations. An unmodified AMA hands worker does not own the model loop: it
reads Session configuration and the event stream, executes requested tools,
and sends the matching `user.tool_result` or `user.custom_tool_result` event.
An OpenMA-supervised in-sandbox harness may own the model loop and produce
agent events, but it is still fenced by that same single Work claim. A stale
worker may remain alive briefly at the infrastructure level, but it must not
be able to submit an accepted Session event, publish an active workspace
checkpoint, or finalize outputs after losing ownership.

### 2. OpenMA managed-runtime plane

OpenMA adds a provider-neutral Runtime Host around an assigned execution. The
assignment may be an official Environment Work item or an OpenMA-native
Session run. The host composes narrow Ports rather than branching on provider
names or assuming which side owns the agent loop:

```text
official Environment Work queue    OpenMA Session scheduler
 (AMA hands or in-sandbox brain)      (application brain)
             │                              │
             └──────── execution assignment ┘
                         │
                         ▼
OpenMA Managed Runtime Host
  ├─ Runtime lease + fencing
  ├─ SandboxPort
  ├─ WorkspacePersistencePort
  ├─ SessionInputMaterializerPort
  ├─ SessionOutputPort
  └─ SandboxHarnessDriverPort
          │
          ▼
Cloudflare | E2B | Node/Docker | future provider adapters
```

There are therefore three supported execution arrangements:

| Arrangement | Agent-loop owner | Wire protocol | Lifecycle and persistence owner |
|---|---|---|---|
| Vanilla AMA worker | Managed Agents control plane | Official Environment Work API | User/provider template |
| AMA worker under OpenMA Runtime Host | Managed Agents control plane | Same official Environment Work API | OpenMA Ports and selected adapters |
| OpenMA supervised harness in sandbox | Pi, ACP, or another OpenMA harness in the sandbox | Official Environment Work externally; OpenMA supervisor internally | OpenMA Ports and selected adapters |

The enhanced mode is additive. OpenMA must never require its private resource
protocol in order to run a vanilla AMA worker.

For an OpenMA-managed worker the normative activation order is:

```text
poll/claim + ACK
  -> decode per-claim sessions_token
  -> GET the claimed Session
  -> validate Session id and Environment id
  -> read official Session.resources + application-owned Session.metadata
  -> acquire/restore and attach runtime resources
  -> materialize declared Session inputs
  -> start the selected harness driver
```

Session retrieval happens before runtime acquisition. Input materialization
happens after the workspace, outputs, and credential-egress bindings are
attached, but before the worker/harness process starts. Failure at either
boundary never starts the harness. The failed Work is not force-stopped; its
lease may expire and a replacement worker can reclaim it.

These are two orthogonal choices, not competing definitions of a worker:

1. **Who drives the agent loop?** In AMA self-hosting, the remote Managed
   Agents control plane remains the brain and `EnvironmentWorker` is the
   hands. In harness-in-sandbox, Pi/ACP is the brain and produces the agent
   events.
2. **Who owns runtime resources?** Either role may run in compute managed by
   the same Runtime Host, which provides fencing, sandbox lifecycle,
   `/workspace`, and Session outputs without understanding the agent loop.

An AMA hands worker is therefore not adapted into a Pi brain. The exact worker
and its community image remain reusable in the AMA lane; the provider's
container, volume, snapshot, process, and networking integrations remain
reusable in both lanes. What is intentionally not reused is the hands-only
`SessionToolRunner` as an OpenMA agent loop, because it observes tool requests
and returns tool results rather than calling the model.

The Runtime Host also supports two explicitly different harness drivers:

| Driver | What runs | Guaranteed lifecycle |
|---|---|---|
| `ama_worker` | An official or community AMA worker command/image, unmodified | Process/container exit, external Work and resource heartbeats, hard cancellation |
| `openma_supervised` | An OpenMA harness supervisor with a selected Pi, ACP, or future harness | Ready handshake, harness heartbeat, graceful drain, bounded stop, optional warm checkpoint |

`ama_worker` is mandatory for ecosystem compatibility. It consumes the public
Environment Work API exactly as the official SDK specifies. The supervised
driver is an optional OpenMA-native execution lane and must never become a
prerequisite for that API. Workspace and output persistence can still be
provided outside an unmodified worker through mounts or final collection, but
live quiescing and process-memory checkpoints require cooperation from a
supervisor.

Concretely, an existing AMA worker image or command is passed unchanged to the
`ama_worker` driver. It does not import `@open-managed-agents/harness-supervisor`,
does not receive a fencing token, and does not implement an OpenMA heartbeat.
The Runtime Host observes process/container liveness and owns resource fencing
outside that process. Pi, ACP, and other OpenMA-native harnesses may instead
embed the supervisor SDK so they share one ready/heartbeat/completion/drain/stop
state machine. That choice is deployment configuration. `openma_supervised` is
an internal Runtime Host protocol and is not presented as a second Managed
Agents wire protocol or as an extension of `Environment.config`.

Runtime profiles are declaration-time inputs to deployment composition, not
fields added to the public Environment payload:

```ts
type HarnessDriver =
  | { type: "ama_worker"; process: RuntimeProcessDeclaration }
  | {
      type: "openma_supervised";
      protocol: "openma-harness-supervisor-v1";
      supervisor: RuntimeProcessDeclaration;
      harness: { id: string; version: string };
    };
```

The implementation may use a provider-native volume, process supervisor,
sidecar, watcher, or final collector. These are execution mechanisms selected
from capabilities, not public protocol concepts. In particular, fencing is a
control-plane atomicity requirement and cannot be implemented only by a
sandbox sidecar.

## Normative Port boundaries

The following types describe the required semantics. Exact TypeScript names
may change during extraction, but implementations must preserve these
boundaries.

### SandboxPort

`SandboxPort` owns isolated compute, not durable data:

```ts
interface SandboxPort {
  capabilities(): Promise<SandboxCapabilities>;
  acquire(input: AcquireSandboxInput): Promise<SandboxLease>;
  heartbeat(lease: SandboxLease): Promise<HeartbeatResult>;
  suspend(lease: SandboxLease): Promise<SuspendResult>;
  resume(input: ResumeSandboxInput): Promise<SandboxLease>;
  terminate(lease: SandboxLease, reason: TerminationReason): Promise<void>;
  inspect(ref: SandboxRef): Promise<SandboxObservation>;
}
```

It may internally use a Durable Object, MicroVM, container, process, isolate,
or vendor sandbox. Provider SDK types stay inside adapter packages.

### WorkspacePersistencePort

`WorkspacePersistencePort` owns the canonical filesystem state needed to
continue a coding-agent Session:

```ts
interface WorkspacePersistencePort {
  plan(input: WorkspacePlanInput): Promise<WorkspacePlan>;
  materialize(input: MaterializeWorkspaceInput): Promise<WorkspaceBinding>;
  attach(input: AttachWorkspaceInput): Promise<void>;
  checkpoint(input: CheckpointWorkspaceInput): Promise<WorkspaceCheckpoint>;
  release(input: ReleaseWorkspaceInput): Promise<void>;
}
```

Every successful materialization presents `/workspace` to the worker, but the
implementation is not required to use a POSIX network mount. A plan selects
one of these semantic strategies:

| Strategy | Meaning | Typical implementation |
|---|---|---|
| `durable_mount` | Writes reach a durable external filesystem | Provider volume or object-backed mount |
| `retained_runtime` | Files survive while the provider retains the runtime | Pause/resume or stop/start |
| `checkpoint_restore` | Local files are restored at acquire and committed explicitly | Snapshot or portable archive |
| `ephemeral` | No continuation guarantee | Disposable sandbox; allowed only when requested |

`retained_runtime` is not durable by itself. If the provider can expire or
delete the runtime, the composition must also checkpoint to an externally
durable store before claiming a stronger retention guarantee.

A portable checkpoint commit follows this order:

1. Freeze or quiesce writes when the provider supports it.
2. Write an immutable candidate archive/snapshot.
3. Produce and verify a manifest containing revision, hashes, and format.
4. Atomically compare-and-set the active checkpoint pointer using the current
   fencing generation.
5. Garbage-collect superseded candidates asynchronously.

An interrupted upload never becomes the active checkpoint. Replaying a commit
with the same idempotency key returns the same outcome.

### SessionOutputPort

`SessionOutputPort` owns user-visible deliverables, independently from the
mutable workspace:

```ts
interface SessionOutputPort {
  prepare(input: PrepareOutputsInput): Promise<OutputBinding>;
  attach(input: AttachOutputsInput): Promise<void>;
  collect(input: CollectOutputsInput): Promise<OutputCandidate[]>;
  finalize(input: FinalizeOutputsInput): Promise<OutputManifest>;
  release(input: ReleaseOutputsInput): Promise<void>;
  abort(input: AbortOutputsInput): Promise<void>;
}
```

The OpenMA Runtime Host uses `/mnt/session/outputs` as its conventional
delivery directory. That path is an OpenMA runtime convention, not an added
field in the AMA Environment shape and not, by itself, a persistence
protocol.

Adapters may implement one of these output transports:

| Strategy | Meaning |
|---|---|
| `durable_mount` | The directory writes directly to durable storage |
| `watch_and_upload` | A sidecar/watcher uploads stable files while work runs |
| `final_collect` | The host enumerates and uploads files during drain |

Finalization writes an immutable, content-addressed manifest. The identity of
an output is at least `(sessionId, logicalPath, contentHash)`, so retrying
collection cannot duplicate a deliverable. Only the active fencing generation
may publish the manifest. Partial files may be retained for diagnosis but are
marked incomplete and are not silently presented as final output.

### SessionInputMaterializerPort

`SessionInputMaterializerPort` stages the claimed Session's official resource
records and interprets its application-owned metadata:

```ts
interface SessionInputMaterializerPort {
  materialize(input: {
    session: {
      id: string;
      environmentId: string;
      metadata: Readonly<Record<string, string>>;
      resources: readonly (Readonly<Record<string, unknown>> & {
        type: string;
      })[];
    };
    workspace: WorkspaceBinding;
    sandbox: ManagedSandboxLease;
    activeWorkspaceCheckpoint: RuntimePublicationCandidate | null;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<void>;
}
```

An implementation clones/downloads the standard `github_repository` and
`file` resources and may attach another application resource according to its
own metadata keys. The Port does not standardize metadata keys and does not
receive the raw Work secret. Provider SDKs, pre-signed locators, or a separately
configured scoped API client remain behind the implementation. Materialization
must be idempotent for the supplied Work generation and must fail closed on an
unknown required input.

### Runtime checkpoints

Process-memory snapshots are an optional optimization exposed by a runtime
adapter, not part of `WorkspacePersistencePort` and never the recovery source
of truth.

A warm runtime checkpoint can be reused only when its Session, work
generation, workspace revision, harness version, and image/runtime identity
all match. Otherwise OpenMA acquires a clean runtime, restores `/workspace`,
and rebuilds brain state from the durable Session event log. A provider that
cannot snapshot memory remains fully conformant.

### Independent liveness signals

The Runtime Host does not collapse unrelated failure domains into one
heartbeat:

1. AMA Work heartbeat keeps the official worker claim alive and gates accepted
   tool-result events.
2. Runtime resource fencing gates atomic publication of workspace and output
   candidates.
3. A supervised harness heartbeat reports the health of the process inside the
   sandbox. Direct `ama_worker` drivers have only process/container liveness.

Losing either authoritative lease aborts the harness driver. The Runtime Host
continues resource-fence heartbeats through drain, checkpoint, output
collection, and the atomic publication—not only while the harness command is
running.

### Session execution ownership across Cloudflare and Node

The Session brain depends on `SessionEventDispatchPort`; it does not depend on
Durable Objects, a process-local registry, or SQL. The two production presets
provide equivalent ownership semantics through different adapters:

```text
accepted Managed Events
          │
          ▼
SessionEventDispatchPort
   ├─ Cloudflare ──> one SessionDO id per Session
   │                  └─ DO SQLite pending-event queue + structural single writer
   │
   └─ Node ───────> durable execution outbox
                      └─ SessionExecutionCoordinatorPort
                           └─ SQL claim/lease/generation adapter
                                └─ stateless Node workers
```

Cloudflare does not emulate the Node SQL lease queue inside a Durable Object.
The DO namespace already routes one Session id to one logical actor, and its
SQLite queue survives actor eviction. Node processes do not have that
structural singleton, so an accepted actionable Event batch is atomically
written to the event log and `managed_session_executions`; any replica may
then claim it under a renewable lease.

`managed_session_executions` is Node runtime infrastructure, not a Managed
Agents resource. It is present only in the Node PostgreSQL and SQLite schema
barrels and migrations. It does not add a field to `managed_sessions`, change
an SDK response, or appear in the Cloudflare D1 schema. A Redis, queue, or
external scheduler adapter may implement `SessionExecutionCoordinatorPort`
without this table.

The Node coordinator guarantees:

1. accepted Events and the execution outbox commit in one database
   transaction under the Session revision CAS;
2. strict FIFO within a Session and parallel claims across Sessions;
3. one winning claim generation, renewable only by its owner/attempt;
4. expired attempts may be reclaimed only by a different live owner;
5. interrupt intent is durable, cancels queued work, and is observed through
   renewal by a running owner;
6. every canonical runtime projection is committed with the execution fence,
   so an expired generation cannot append accepted output.

PostgreSQL acceptance first obtains a write lock through the existing Session
revision row. Event inserts, interrupt updates, the outbox insert, and the
revision advance are one transaction. A concurrent writer whose revision is
stale cannot leak an Event or execution row. SQLite gets the same result from
its serialized write transaction. Deployment applies the generated Node
migrations; request handling never creates or alters this schema.

Execution attempts are **at least once**, not arbitrary side effects exactly
once. After lease loss a stale process is cancelled and all later canonical
Session writes fail the generation fence, but a tool call that already changed
GitHub, a database, or another external service cannot be undone. Such tools
need an idempotency key or compensation. A renewal transport error is treated
as uncertain ownership: the local runtime is stopped rather than allowed to
continue speculatively.

Harness placement selects exactly one execution authority:

```text
harness outside sandbox
  SessionExecution claim
    └─ harness executor
         └─ optional sandbox/resource publication fence

harness inside self-hosted sandbox
  official Environment Work claim
    └─ one sandbox executor (supervisor + harness + tools)
         └─ resource publication fence
```

The in-sandbox lane does not acquire a second `SessionExecution` claim. Its
Environment Work lease is the sole scheduling authority for the combined
sandbox and harness attempt. `RuntimeResourceFence` is subordinate publication
authority for workspace/checkpoint/output candidates, not another scheduler
or executor. The supervisor heartbeat is process-health evidence, not an
ownership claim.

Both scheduling planes use the same internal lease-controller semantics for
serialized renewal, transient-failure deadlines, cancellation, graceful stop,
and final renewal. Their adapters and public shapes remain distinct: Session
execution uses `SessionExecutionStorePort`; self-hosted execution uses the
unchanged official Environment Work API.

Each Environment Work claim mints a fresh claim-bound Session bearer. The
control plane compares that bearer with the token stored on the current Work
record before accepting canonical Session requests. Reclaim therefore fences
the previous executor immediately even if its sealed token has not reached its
cryptographic expiry. The current token may still reach Work heartbeat/stop
after TTL so the official endpoint can return `412` or complete cleanup; it
cannot use that grace path to append Session Events.

## Capability negotiation

Capability negotiation happens during Runtime Host composition, before work
is acknowledged. It does not happen through the AMA Environment payload.

Capabilities are semantic, not provider-name switches:

```ts
interface SandboxCapabilities {
  lifecycle: {
    suspendResume: "supported" | "unsupported";
    hardTerminate: "supported" | "best_effort";
  };
  workspace: ReadonlyArray<
    "durable_mount" |
    "retained_runtime" |
    "checkpoint_restore" |
    "ephemeral"
  >;
  outputs: ReadonlyArray<
    "durable_mount" | "watch_and_upload" | "final_collect"
  >;
  runtimeCheckpoint: "filesystem" | "process" | "none";
}
```

An application declares required semantics separately from provider
capabilities. Assembly fails before starting the worker if no valid strategy
can meet the requirement. It must not silently downgrade durable workspace or
output guarantees to ephemeral storage.

Provider-specific values such as image ID, region, timeout, volume handle,
bucket, retention period, and credentials belong in the selected adapter's
configuration. Preset factories may make the common cases concise:

```ts
createCloudflareManagedRuntime({ ...bindings });
createE2BManagedRuntime({ ...credentials });
createNodeManagedRuntime({ sql, docker, workspaceRoot, outputRoot });
```

The factories preinstall adapters and validate capabilities; the core Runtime
Host still depends only on Ports.

The current package split is:

- `runtime-resource-contract`: provider-free Ports and capability profiles;
- `runtime-resource-fence-sql`: atomic generation fencing for SQLite,
  PostgreSQL, and Cloudflare D1 through the common `SqlClient`;
- `managed-runtime-host`: planning and lifecycle orchestration;
- `managed-runtime-sandbox`: adapter bridge for existing sandbox providers;
- `managed-runtime-node`: Docker/filesystem reference composition;
- `harness-supervisor`: optional in-sandbox lifecycle SDK for Pi/ACP/native
  harnesses;
- `harness-runtime-acp`: the provider-neutral in-sandbox Session command loop,
  ACP child lifecycle, per-agent native-state capture/restore, and canonical
  event recovery fallback.

Harbor is an implementation reference only for the per-agent native Session
artifact inventory. OpenMA owns all durable semantics: immutable candidates,
checkpoint format/version, restore-before-ready barrier, CAS/fencing,
publication, retries, retention and deletion. Live agent homes are isolated in
ephemeral runtime storage; only declared Session artifacts are copied into the
workspace candidate.

The ACP checkpoint manifest also carries the last completed input event id.
The supervisor advances that marker and captures native artifacts before it
publishes canonical `session.status_idle`; the Runtime Host commits the outer
workspace/output candidate afterward. On replacement, the HTTP control adapter
derives the canonical completed-turn watermark from Managed Events and the
native-state adapter permits resume only when the restored marker matches.
This explicitly closes the publish-before-pointer-CAS crash window: canonical
history remains authoritative and an older native candidate triggers one
bounded semantic-recovery turn rather than silent context loss.

Provider drivers expose the direct `ama_worker` lane plus an optional
`HarnessSupervisorTransportPort`. The shared provider registry projects that
transport into `openma_supervised`; individual provider packages do not repeat
the supervisor state machine. A driver that advertises the supervised lane but
returns neither an already-composed driver nor the transport fails capability
admission before sandbox acquisition. Providers without streaming stdin, such
as the current Vercel and Cloudflare Bridge adapters, expose neither the lane
nor a misleading transport object.

The Cloudflare and E2B presets currently advertise only capabilities backed by
their adapter tests. Neither claims process-memory checkpoint support. Provider
runtime retention is not described as durable workspace persistence, and a
plain session output mount is not described as fenced finalization unless its
publication path is generation-scoped and atomically committed.

The Cloudflare full preset preinstalls D1 fencing and the durable orphan queue,
Sandbox DO compute, R2 output candidates, and both the direct AMA and supervised
harness drivers. The E2B resource preset preinstalls durable output collection
only when a complete S3-compatible `FILES_S3_*` target (or an explicit
`outputStore`) is configured. Node/Docker remains the executable reference
composition and can initialize the SQL schema explicitly for local deployments.

All final-collector implementations verify file bytes again after enumeration.
An existing content-addressed blob is accepted as an idempotent retry only when
its bytes—not merely its object size—match the expected SHA-256 digest.

## Lifecycle and split-brain rules

Each execution receives a monotonically fenced generation tied to its claimed
work item. Runtime states are:

```text
candidate ──claim──> active ──lease loss/finish──> draining ──> released
     │                  │                                  └──> orphan
     └──claim fails─────┘
```

The following invariants are mandatory:

1. At most one generation is accepted as active for a Session work item.
2. A stale generation cannot append accepted events or tool results.
3. A stale generation cannot advance the canonical workspace pointer.
4. A stale generation cannot finalize an output manifest.
5. Every active workspace pointer references a complete, verified candidate.
6. Retrying acquire, checkpoint, collect, finalize, drain, or release is
   idempotent.
7. Releasing compute never implicitly deletes canonical durable workspace or
   finalized outputs.

Heartbeat failure first fences the worker at the control plane, then requests
cooperative cancellation, then hard-terminates the sandbox where supported.
Orphan reconciliation continues asynchronously. This bounds split brain but
does not make arbitrary external tool side effects exactly-once. Tools that
modify external systems still require their own idempotency keys or
application-level compensation.

No correctness claim depends on one fixed heartbeat duration. The conformance
suite uses a virtual clock and verifies behavior at the configured lease TTL,
network timeout, cancellation deadline, and termination deadline.

## Failure semantics

| Failure | Required behavior |
|---|---|
| Worker loses its lease | Fence immediately; reject late control-plane writes and commits |
| Network partition | Do not renew ownership speculatively; drain and terminate after policy deadline |
| Sandbox disappears | Reacquire, restore last committed workspace, replay Session events |
| Host crashes during checkpoint upload | Candidate remains inactive; retry or collect later |
| Host crashes after upload but before pointer CAS | Retry CAS using the same idempotency key and fence |
| Harness publishes turn completion before workspace pointer CAS | Compare canonical and native completed-turn watermarks; reject stale native resume and recover once from canonical Managed Events |
| Checkpoint is corrupt | Reject during verification and fall back to the last valid revision |
| Runtime resume fails | Cold acquire plus workspace restore and event replay |
| Output upload is duplicated | Content-addressed finalize collapses duplicates |
| Output finalization fails | Session records an explicit incomplete-output condition and retries |
| Provider retention expires | Restore from external checkpoint if durability was promised |
| Hard termination is unavailable | Mark orphan, keep it fenced, and reconcile until provider confirms exit |

The orphan record contains the resource scope, generation, owner, serialized
provider/runtime identity, reason, attempt count, and bounded last error. It
never contains the resource fence token. A reaper can therefore reconnect and
destroy provider compute after a host crash without gaining authority to
publish workspace or output state.

## Provider mapping

Provider adapters select the strongest available strategy; they do not pretend
all providers are POSIX mount providers.

| Provider family | Workspace candidates | Output candidates | Boundary |
|---|---|---|---|
| Node/Docker | bind/volume or portable archive | bind mount, watcher, or collector | Reference implementation can run entirely in Docker |
| Cloudflare Sandbox | retained sandbox plus snapshot/archive; durable mount only when explicitly configured | object-backed mount or collector | Durable Object coordinates ownership; it is not canonical workspace storage |
| E2B | pause/resume, provider snapshot/volume, or portable archive | object-store mount or collector | Provider retention must not be presented as permanent durability |
| Daytona and similar | stop/start, snapshot/volume, or portable archive | mount or collector | Adapter must declare actual retention and delete behavior |
| Minimal/remote executor | ephemeral or portable archive | final collector | No mount or process-checkpoint assumption |

Exact provider support is established by conformance tests, not by this table.
An adapter reports only behaviors exercised successfully in its real runtime.

## Conformance and test strategy

### AMA worker-wire suite

Run the official Anthropic SDK client and `EnvironmentWorker` against an
OpenMA server and cover:

- environment create/retrieve/list/update/archive/delete;
- work poll, claim/ack, heartbeat, update, stop, and terminal races;
- claimed-Session retrieval with the per-work bearer, identity mismatch, and
  unavailable Session recovery;
- opaque Session metadata projection and input-materialization failure before
  harness start;
- per-work secret scope and rejection of stale credentials;
- tool result and Session event projection;
- always-on polling and webhook/per-Session execution;
- duplicate delivery, retries, cancellation, and lease expiry.

This suite proves that OpenMA can consume existing AMA community workers. It
must not import OpenMA's provider Ports.

### Runtime-resource contract suite

Every Sandbox, Workspace, and Output adapter runs the same contract suite.
The Node/Docker reference adapter runs in normal CI. Cloud adapters run both
deterministic fake-provider tests and credentialed staging smoke tests.
External dependencies such as the LLM and MCP server are scripted protocol
fakes; the runtime and storage implementation under test remain real.

Fault injection covers at least:

- crash or disconnect before and after every checkpoint phase;
- duplicate work and concurrent stale workers;
- heartbeat delay, lease expiry, and failed hard kill;
- provider runtime expiration and failed resume;
- corrupt/truncated archives and hash mismatch;
- output changes during collection and duplicate finalize;
- cleanup retry and orphan reconciliation;
- capability mismatch and forbidden downgrade.

The tests assert invariants and externally observable traces, not private
implementation order. Coverage gates apply to the state machines and failure
branches; a happy-path percentage alone is not a conformance claim.

The deterministic chaos lane (`pnpm test:chaos:runtime`) enumerates every
post-acquire lifecycle boundary and runs seeded multi-owner action sequences.
Seeds are committed with the suite so a failure is exactly reproducible. A
credentialed provider smoke lane may add timing jitter and real process loss,
but it supplements rather than replaces this model-based CI gate.

## Rollout

1. **Wire audit** — generate RED tests from the installed official SDK and
   close all Environment Work compatibility gaps.
2. **Port extraction** — establish vendor-free sandbox, workspace, output,
   lease, and checkpoint contracts plus deterministic fakes.
3. **Reference Runtime Host** — implement Node/Docker composition and the full
   lifecycle/fault conformance suite.
4. **Cloudflare adapter** — move current sandbox lifecycle, workspace backup,
   and output behavior behind the new Ports; verify in staging.
5. **E2B adapter** — map real pause/resume/snapshot or archive semantics and
   object-store output delivery; verify in a real E2B runtime.
6. **Additional providers** — add adapters only with published capability
   matrices and the same conformance evidence.
7. **SDK packaging** — expose preset factories and a low-level composition API
   without changing the official Managed Agents facade.

Migration is additive. Existing v0 tests that describe still-supported
behavior remain regression fixtures; historical branches that conflict with
the accepted Port invariants may be deleted after their replacement tests are
green.

## Non-goals

- Extending the official `self_hosted` Environment shape with OpenMA fields.
- Defining one lowest-common-denominator POSIX mount API.
- Making process-memory snapshots portable or required.
- Guaranteeing exactly-once behavior for arbitrary external tool side effects.
- Inferring final deliverables from every modified workspace file.
- Treating a provider's temporary runtime retention as durable storage.

## Consequences

### Positive

- Existing AMA workers and provider community templates remain reusable.
- OpenMA applications can change providers without importing provider SDKs
  into business logic.
- Workspace recovery and output delivery become testable contracts rather
  than incidental adapter behavior.
- Capability mismatch becomes an early configuration error instead of silent
  data loss.
- Split-brain safety is enforced at all durable commit points.

### Negative

- OpenMA must maintain a runtime host and conformance suite in addition to wire
  compatibility.
- Some providers need a collector/archive fallback and cannot offer live
  durable mounts.
- Fencing prevents stale publication but cannot undo external side effects
  already performed by a stale sandbox.
- Provider claims require periodic credentialed tests; deterministic mocks are
  necessary but insufficient.

## References

- [Anthropic: Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [Anthropic: Self-hosted security model](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security)
- [Anthropic: Managed Agents reference](https://platform.claude.com/docs/en/managed-agents/reference)
- [Cloudflare: Set up Claude Managed Agents](https://developers.cloudflare.com/sandbox/tutorials/claude-managed-agents/)
- [E2B: Claude Managed Agents](https://docs.e2b.dev/agents/claude-managed-agents)
