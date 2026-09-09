# Open Managed Agents v1 architecture

## Version line

- **v0** is the existing application and its OMA-specific internal shapes.
- **v1** is the SDK-first architecture defined here.
- Managed Agents HTTP remains on the official `/v1/*` paths. OMA-only HTTP
  remains under `/v1/oma/*`; v1 does not create a `/v2` namespace.
- v0 and v1 coexist during migration. New v1 packages may not import an app,
  route, Durable Object, or service container from v0.

The self-hosted worker boundary, workspace/output persistence semantics,
provider capabilities, fencing rules, and adapter rollout are normative in
[`ADR 0005`](adr/0005-self-hosted-worker-runtime-resources.md). The official
Managed Agents `self_hosted` shape and OpenMA's managed-runtime resource Ports
are deliberately separate planes.

## Package model

v1 follows an interface-package plus implementation-package model. A domain
interface is independently installable and has no platform or database-driver
dependency. Implementations are independently installable and point inward to
that interface.

```text
@open-managed-agents/domain
               │
               ▼
@open-managed-agents/agent-store
       ▲                    ▲
       │                    │
agent-store-memory   agent-store-sql ──> sql-client
                                      ▲
                                      │
                              D1 / SQLite / Postgres / MySQL drivers
```

The first extracted domain families are now:

```text
agent-store            agent-store-memory            agent-store-sql
credential-store       credential-store-memory       credential-store-sql
deployment-store       deployment-store-memory       deployment-store-sql
deployment-run-store   deployment-run-store-memory   deployment-run-store-sql
dream-store            dream-store-memory            dream-store-sql
environment-store      environment-store-memory      environment-store-sql
environment-work-store environment-work-store-memory environment-work-store-sql
file-store             file-store-memory             file-store-sql
memory-store-store     memory-store-store-memory     memory-store-store-sql
memory-document-store  memory-document-store-memory  memory-document-store-sql
skill-store            skill-store-memory            skill-store-sql
tunnel-store           tunnel-store-memory           tunnel-store-sql
user-profile-store     user-profile-store-memory     user-profile-store-sql
session-store          session-store-memory          session-store-sql
session-event-store    session-event-store-memory    session-event-store-sql
session-resource-store session-resource-store-memory session-resource-store-sql
session-thread-store   session-thread-store-memory   session-thread-store-sql
vault-store            vault-store-memory            vault-store-sql
```

Session Threads are an independent aggregate from Sessions. The
`session-thread-store` family owns workspace/Session isolation, stable
pagination, lookup, insertion, and the atomic archive transition. Its archive
outcome says whether the call performed the transition so the application can
emit lifecycle work exactly once.

Thread Events are not a second writable event model or table. They are a
narrow read projection (`SessionThreadEventStore`) of the same append-only
`SessionEventStore`. Memory and SQL compositions must provide both Ports from
the same Store instance; SQL keeps `thread_id` as an indexed physical relation
while leaving the canonical event document unchanged.

Session Resources are a projection of the Session aggregate, not a second
Session copy. The `session-resource-store` family reads and replaces resources
against the same Session revision. Memory composition wraps the selected
`SessionStore`; SQL composition updates the Session document, sealed GitHub
tokens, and `managed_session_memory_stores` relation rows in one guarded batch.
SDK validation, mount-path rules, cursors, File lookup, and resource resolution
stay in the application layer.

The SDK `beta.webhooks` surface does not define an inbound Managed Agents HTTP
resource. It performs local signature verification/unwrapping and exposes
protocol event types. OpenMA therefore does not invent a Webhook Store or
route; those codecs and Managed Event/OpenMA Event mappings belong in
`openma-common/protocol`.

The repeated `store` in `memory-store-store` is intentional. The existing
`@open-managed-agents/memory-store` package owns the v0 memory-content system
and remains installed during migration. The v1 package name avoids taking
over that namespace or making an apparently compatible breaking replacement.

Memory Stores retain the SDK-derived external contract: optional
`description` and string metadata, nullable update patches, `limit`/`page`
pagination, inclusive `created_at[gte]` and `created_at[lte]` filters, archive
timestamps, and the `memory_store_deleted` response. The API package owns the
snake_case mapper; `MemoryStoreStore` owns only workspace-scoped aggregate
persistence, stable oldest-first ordering, archive/delete outcomes, and CAS.

SDK Memories use the separate `memory-document-store` family. A Managed
Agents Memory is a hierarchical text document inside a Memory Store, not the
v0 `memory-store` package and not the Memory Store aggregate itself. The Store
atomically persists current state together with immutable Memory Version
history, enforces workspace/store/path uniqueness and revision CAS, produces
stable `memory | memory_prefix` pagination, and keeps terminal history after a
delete. Content projection, path validation, SHA-256 preconditions (including
idempotent retries), and SDK error mapping remain in the application/API
layers.

SDK Skills and Skill Versions use the `skill-store` family. Skill metadata,
its latest-Version pointer, immutable Version metadata, and the uploaded
package archive form one persistence aggregate. Creating the first Version,
appending a Version, deleting a Version, and promoting its predecessor are
atomic Store operations guarded by the Skill revision. Multipart parsing,
package compilation, cursor mapping, and binary download headers remain in
the application/API layers.

SDK Tunnels and Tunnel Certificates use the `tunnel-store` family. A Tunnel,
its connector-token identifier, and all Certificate records form one aggregate;
archiving the Tunnel and its active Certificates is one revision-CAS mutation.
Provisioning/retiring hostnames, revealing or rotating live token values, and
registering CA material remain three separate outbound Ports. The Store never
receives a live connector token or private-key material.

SDK User Profiles use the `user-profile-store` family. The domain matches the
official User Profile resource: metadata, provider-owned `trust_grants`, and
the optional access, external ID, name, and relationship fields. Metadata
patching, nullable-field clearing, SDK cursor mapping, and enrollment URL
issuance remain application concerns. Enrollment URLs are ephemeral outbound
values and never enter the Store; `trust_grants` are persisted output state but
remain read-only through the API.

OpenMA tenant ownership is intentionally absent from this domain. A tenant is
the outer SDK consumer/host concern. `workspaceId` is only the generic
host-provided Store partition key used for isolation; it does not create a
Tenant entity, membership model, or User Profile relationship.

SDK Environment Work uses the `environment-work-store` family. A work item,
its encrypted runner credential, claim/worker identity, heartbeat lease, and
revision form one queue aggregate. Atomic claim/reclaim, active Session lookup,
queue statistics, and newest-first list positions belong to the Store. Long
poll waiting, Environment lookup, Session credential issuance, SDK validation,
and lifecycle transitions remain narrow application/runtime Ports. The
plaintext work secret is returned only by `poll`; SQL implementations receive a
cipher at construction and never place it in the work document or logs.

File bytes are a separate capability from File metadata:

```text
file-content-store  <──  managed-agents-adapters-blob  <──  blob-store
```

This preserves the existing upload compensation, metadata/content
consistency, pagination, and tenant-isolation application logic while allowing
metadata and bytes to use different implementations and migrate independently.

Credentials preserve their existing whole-document encryption boundary.
`credential-store-sql` receives a `CredentialDocumentCipher` as an
implementation construction dependency; the application graph receives only
`CredentialStore`. Secret redaction, auth-variant immutability, Vault checks,
validation probing, cursor rules, and revision conflict handling remain in the
retained Credentials application service.

Vaults follow the same rule. `VaultStore` owns Vault persistence only; the
retained Vaults application service continues to own display-name validation,
metadata patch semantics, pagination, archive/delete behavior, and optimistic
revision conflicts. Credential-to-Vault validation is a narrow application
Port produced by `credentialVaultSourceFromVaultStore(...)` at composition
time. Neither Store imports or resolves the other Store.

Deployments keep their existing aggregate-oriented application core. The
retained service still owns semantic validation, dependency readiness,
schedule planning, secret redaction, pause/archive transitions, manual-run
phases, pagination, and optimistic revision handling. `DeploymentStore`
persists the complete Deployment plus its resource-secret records;
`deployment-store-sql` receives a `DeploymentResourceSecretCipher` only as an
implementation construction dependency. The cipher and SQL client never enter
the application Port graph.

Deployment Runs are a separate query/CAS Store, but manual admission is one
explicit transactional operation: it creates a Run only when the referenced
Deployment exists at the expected revision, is active, and is not archived.
`deployment-run-store-sql` implements that promise with one guarded
`INSERT ... SELECT`; the application never performs a racy read-then-insert.
The Memory implementation takes the selected `DeploymentStore` as a
construction dependency and serializes admissions per workspace for local
development.

Dreams retain their existing aggregate lifecycle and execution core.
`DreamStore` owns workspace-scoped aggregate persistence, stable pagination,
and optimistic replacement only. Curating memories, resolving Session inputs,
creating/replacing output Memory Stores, and deferring execution remain
separate semantic Ports. `dreamExecutionModule()` exposes the retained
execution state machine independently; `dreamsModule()` consumes a scheduler
Port and never resolves a queue, SQL client, or platform context.

Runtime coordination follows the same interface/implementation split:

```text
session-runtime-contract   session-runtime-sql
session-realtime           session-realtime-memory
session-wakeup             session-wakeup-memory
                           session-wakeup-cloudflare
runtime-relay              RuntimeRoom / future Node relay hosts
```

`session-realtime` and `session-wakeup` scope every operation by the pair
`workspaceId + sessionId`. Implementations use nested maps or an unambiguous
tuple encoding; a bare Session ID is never a runtime ownership key.

The repository already contains a v0 `@open-managed-agents/session-runtime`
implementation package. During coexistence, the new narrow v1 interfaces live
in `@open-managed-agents/session-runtime-contract`; v1 code must not import the
v0 machine/adapter package. The old name can only be reconsidered at a package
major-version boundary after v0 consumers have migrated.

The same shape applies independently to sessions, session threads, session
events, memories, credentials, files, deployments, and the remaining Managed
Agents domains.
There is no universal `Store` service locator.

Database relationships belong to the domain implementation. For example,
agent current/version tables, optimistic replacement, workspace isolation,
ordering, and transaction semantics live in `agent-store-sql`. A D1,
Postgres, or MySQL driver implements the generic SQL client and knows nothing about
Agents.

Cross-domain business relationships are different: they are expressed as
narrow application Ports and wired by `createApp`. A SQL join or an aggregate
Store is not allowed to become an implicit service locator between domains.

## Port rules

1. An application module declares every required and provided Port.
2. A module receives only its declared requirements. It cannot resolve an app,
   container, environment, or aggregate Store.
3. Each feature receives its narrow domain Store Port, such as
   `agentStorePort`; it never receives all Stores.
4. Interface packages contain plain domain data and discriminated outcomes.
   They do not import Hono, Cloudflare types, Node APIs, database drivers, or
   vendor SDKs.
5. Implementations receive their low-level dependency in their constructor or
   factory. `createApp` receives the finished domain implementation.
6. HTTP, storage, sandbox, MCP, harness, scheduling, realtime delivery, and
   runtime coordination are separate capabilities.
7. Official Managed Agents and OMA extensions remain distinct inbound lanes
   until the outer HTTP composition boundary.

Example composition:

```ts
const agents = new SqlAgentStore(sqlClient);

const app = createApp({
  modules: [
    providePort(workspaceContextPort, { workspaceId }),
    providePort(agentStorePort, agents),
    agentsModule(),
  ],
});
```

`SqlClient` is not an application Port in this example. It is a construction
dependency of one Store implementation.

## Durable Object decomposition

Durable Objects are Cloudflare implementations, not business objects or app
containers. A v1 Durable Object shell may translate Cloudflare lifecycle
callbacks and supply implementation packages; it may not own the session
state machine, SQL queries, protocol conversion, or business decisions.

| v0 responsibility | v1 interface/domain package | Cloudflare implementation | Other implementation |
| --- | --- | --- | --- |
| Session state, threads, usage, pending callbacks | per-domain Session Stores | domain SQL Stores over DO SQLite/D1 | SQLite/Postgres/MySQL Stores |
| Canonical event append/list and pending queue | Session Event Store | SQL Store over DO SQLite | SQL Store over SQLite/Postgres/MySQL |
| Turn begin/end, interruption, recovery | Session Runtime | thin CF runtime host | Node runtime host |
| One-turn-at-a-time and per-thread coordination | Turn Coordinator | DO single-writer coordinator | process/distributed lock coordinator |
| Scheduled wakeups and recovery polling | Wakeup Scheduler | DO alarm adapter | timer/queue scheduler |
| Session WebSockets and event fanout | Realtime Hub | DO WebSocket adapter | WebSocket/SSE adapter |
| Harness selection and turn execution | Harness | injected harness package | the same harness package |
| Sandbox lifecycle and workspace restore | Sandbox | Cloudflare Sandbox implementation | local/E2B/Daytona implementation |
| stdio/remote MCP lifecycle | MCP Runtime | sandbox-backed implementation | subprocess/remote implementation |
| Model and credential lookup | Model/Credential domain Ports | injected Stores/providers | injected Stores/providers |
| Browser lifecycle and billing hooks | Browser Harness | Cloudflare browser implementation | CDP/local implementation |
| Provider hooks and event projection | Event Sink/Projector | HTTP/queue implementation | HTTP/queue implementation |
| Runtime daemon ↔ harness relay | Runtime Relay | `RuntimeRoom` DO adapter | Node relay service |
| Runtime identity and tenant authorization | Runtime Registry/Policy | SQL-backed CF implementation | SQL-backed Node implementation |
| HTTP path dispatch | session HTTP adapter | `fetch()` delegates to handler | Node server delegates to handler |

The target Cloudflare shell has four kinds of code only:

```text
constructor: create CF implementations and createApp
fetch:       delegate Request to an injected HTTP handler
alarm:       delegate to WakeupScheduler/SessionRuntime
websocket:   delegate lifecycle frames to RealtimeHub/RuntimeRelay
```

Business SQL moves into the corresponding domain Store implementation. Event
and protocol transformations move into `openma-common`; neither remains in a
Durable Object.

The first completed SessionDO vertical slice is scheduled wakeups. The v0
`scheduleWakeup`, `cancelWakeup`, `listWakeups`, and `onScheduledWakeup`
methods remain as an outer compatibility facade, while validation, terminated
Session handling, capacity, and delivery decisions run through
`session-wakeup`. `session-wakeup-cloudflare` owns the durable alarm row
codec, filters internal callbacks, and can read both native v1 payloads and
legacy `scheduled_at` / `parent_event_id` rows already in flight.

`RuntimeRoom` follows the same shell pattern for the daemon relay. Wire codecs
live in `openma-common/session-kernel`; tenant authorization, tenant selection,
and storage-effect planning live in `runtime-relay`. The Durable Object now
loads platform state and executes the returned effects, preserving the old
WebSocket and storage keys while removing those decisions from the container.

## Platform aggregation

Platform packages are SDKs, not applications:

```text
@open-managed-agents/platform             workspace registry contract
@open-managed-agents/platform-node
@open-managed-agents/platform-cloudflare
```

They select implementations and expose factories. They do not redefine domain
interfaces. A host application supplies authentication, configuration, and a
workspace/tenant key, then requests a scoped app instance. The platform SDK
must support an app registry/factory so one process or Worker cannot leak a
workspace-bound Port into another tenant.

Both built-in factories provide workspace context, clock, IDs, HTTP, the
currently extracted Store Ports, and a configurable Managed Agents feature
preset. The default `core` preset installs Agents, Deployment Runs,
Environments, Memory Stores, and Vaults because those features require no
runtime adapter beyond the platform Stores. Adapter-backed features are
enabled explicitly. `false` disables a default feature, and an `AppModule`
value replaces its official implementation only when it provides the same
application Port. They do not expose concrete Stores on the returned SDK
object; callers reach dependencies only through `app.port(...)`.

The `modules(scope)` extension callback remains the advanced escape hatch for
narrow runtime Ports. It runs once per cached workspace graph. Request-only
capabilities such as an authenticated actor or Cloudflare `waitUntil` use the
uncached `createCloudflareManagedAgentsApp(...)` entrypoint instead.

```ts
const platform = createNodePlatform({
  features: {
    files: true,
    agents: customAgentsModule,
  },
  fileContent: blobFileContentStore,
});

const app = platform.app({ workspaceId });
await app.start();
const agents = app.port(managedAgentsPortTokens.agents);
```

For a single workspace, the convenience factories remove the registry step:

```ts
const nodeApp = createNodeManagedAgentsApp({ workspaceId, stores });

const requestApp = createCloudflareManagedAgentsApp({
  workspaceId,
  sql: new CfD1SqlClient(env.DB),
  modules: requestScopedModules,
}, {
  features: { preset: "none", dreams: true },
});
```

Cloudflare uses the same registry contract with SQL implementations. During
migration, either platform can receive a `compat-v0` Store adapter through its
typed `stores` option; the returned app still exposes only the v1 Port. A new
platform implements `WorkspaceAppRegistry` and supplies modules—it does not
fork the domain packages.

The first production consumer slices are official Agents, Credentials,
Deployments, Deployment Runs, Dreams, Environments, Environment Work, Files, Memory Stores,
Memories, Memory Versions, Models, Skills, Skill Versions, Tunnels, Tunnel
Certificates, User Profiles, and Vaults.
Both `main-node` and the Cloudflare Worker now resolve their
application Ports from the workspace app instead of constructing application
services in HTTP routes. Node reuses its existing SQL Stores through typed
overrides; Cloudflare passes the request-resolved tenant `SqlClient` in the
workspace scope, which preserves sharded D1 routing. File content is supplied
as a separate request/workspace-scoped capability, while the existing Files
application service remains the owner of upload and cleanup behavior. OMA
Models remains a separate `/v1/oma/models/list` lane.

Node composes official Vaults and Credentials over one `SqlVaultStore`.
Cloudflare creates its official application graphs at the request boundary so
a workspace cannot retain a request-specific D1 shard, actor, cipher, or
execution context. Vault and Credential graphs still use the same tenant SQL
rows, and Credential lookup is derived from the Vault Store through the narrow
application Port.

Deployments need several cross-domain reads and runtime launch capabilities.
Those are supplied as narrow request/workspace-resolved modules, not by giving
the Deployment Store a database or application service locator. Node binds the
existing SQL/runtime implementations once per workspace; Cloudflare constructs
the same Port set from the request-resolved tenant `SqlClient`, session facade,
and secret cipher before installing `deploymentsModule()`.

Dreams use the same modules on both platforms. Node caches one app graph per
workspace and supplies its SQL Store, curator, memory workspace, Session
source, and in-process scheduler through Ports. Cloudflare creates the graph at
the request boundary because `executionCtx.waitUntil` is request-scoped; this
prevents a cached workspace app from retaining the first request's execution
context while preserving the same Store and application modules.

Official Memories and Memory Versions are composed per request because the
version actor is request-scoped. The actor Port is therefore never captured by
the workspace registry's first request. Dreams install the same
`memoriesModule()` with a fixed `service_account:dream_executor` actor and
consume `managedAgentsPortTokens.memories`; they do not construct or bypass
the retained Memories application service.

The official Sessions surface is migration-facade-first. The retained
`SqlManagedSessionsComposition` builds the same strict app modules for
Sessions, Events, Resources, Threads, and Thread Events and caches one Port
graph per exact workspace key. The old facade owns only SQL/runtime adapter
construction; it no longer constructs application services directly.

## Migration experience

v1 adoption is incremental and reversible; it is not a flag-day rewrite. Two
outer packages support the transition without adding v0 shapes to v1 core:

```text
@open-managed-agents/compat-v0   runtime adapters between selected v0 and v1 boundaries
@open-managed-agents/migrate-v0  config, schema/data migration, validation and codemods
```

The initial `compat-v0` release covers Agent, Credential, Deployment,
Deployment Run, Dream, Environment, Environment Work, File, Memory Store, Memory, Skill, Tunnel,
User Profile, Vault, and Session
Store composition, Session Event Store composition, direct-constructor
dependency adapters, and `createApp` modules. The initial `migrate-v0` release
is a pure dry-run planner with actionable diagnostics and rollback steps, plus
a generic workspace router that applies a reviewed rollout to existing v0/v1
app sources. See
[`migrating-v0-to-v1.md`](./migrating-v0-to-v1.md) for the supported path.

Runtime migration is also facade-first. Node's managed runtime now injects a
`SessionRealtimeHub` and publishes application-native camelCase events only
after runtime projection commits. Cloudflare's managed runtime adapter carries
workspace scope on every internal lifecycle, dispatch, thread, and WebSocket
request; its DO lookup uses the tuple `[workspaceId, sessionId]`. Existing v0
HTTP and schedule-tool callers keep their old wire shape at the outer facade.

The supported path is domain by domain:

1. Add the v1 packages alongside v0.
2. Run migration tooling in dry-run mode and review unsupported behavior.
3. Adapt the existing implementation to a v1 Port, or install a native v1
   implementation.
4. Route selected workspaces/sessions to v1 while the remainder stays on v0.
5. Compare API results, event traces, counts, versions, and side-effect
   receipts with the migration verifier.
6. Promote the slice, while retaining a documented rollback route.
7. Remove its compatibility adapter only after the observation window.

Migration tooling must provide actionable diagnostics rather than a generic
"unsupported config" error. Every unsupported field reports its path, the v1
replacement when one exists, and whether it can be ignored safely.

Database migration is additive by default. A domain migrator creates v1 data
beside v0 data, validates row counts and stable checksums, and records a
checkpoint so it can resume. Dual-read or dual-write is used only for domains
whose cutover window requires it; it is not baked into the Store interface.

The primary user entrypoints remain small:

```ts
createManagedAgentsApp({ modules: [...] })
createNodeManagedAgentsApp({ workspaceId, ... })
createCloudflareManagedAgentsApp(scope, { ... })
createNodePlatform({ ... }).app({ workspaceId })
createCloudflarePlatform({ ... }).app({ workspaceId })
```

Platform factories select sensible implementations and expose escape hatches
as ordinary v1 interfaces. Users do not need to understand `createApp`'s
internal graph to complete a standard migration.

## Migration order

1. Freeze the official Managed Agents and OMA extension HTTP lanes.
2. Extract domain types and one Store interface at a time.
3. Ship memory and SQL implementations against a shared behavioral contract.
4. Point the v1 application module at the domain Store Port.
5. Extract Session Runtime, Realtime Hub, Wakeup Scheduler, Harness, Sandbox,
   and MCP interfaces before changing a Durable Object.
6. Move SessionDO responsibilities behind those interfaces in vertical slices;
   keep the outer DO entrypoint delegating throughout the migration.
7. Apply the same split to RuntimeRoom and sandbox/container entrypoints.
8. Build Node and Cloudflare aggregation SDKs from the same application
   modules and verify tenant-scoped parity.
9. Switch consumers from v0 to v1 one resource/runtime at a time.

## v0 test asset policy

v0 currently has hundreds of tests, including substantial recovery, alarm,
event-log, WebSocket, scheduling, and runtime-route coverage. Migration keeps
their behavioral knowledge without making v1 depend on v0 implementation.
Passing in v0 makes a behavior evidence, not an automatic v1 requirement.

The migration default is:

- preserve correctness and safety invariants: tenant isolation, authorization,
  idempotency, CAS/concurrency, ordering, recovery without duplicate side
  effects, and official API behavior;
- decide historical fallbacks, permissive error handling, old state fields,
  and OMA-only quirks case by case;
- drop private-method, table-name, service-container, and old namespace
  compatibility unless a current consumer demonstrably needs it;
- place useful legacy behavior that would weaken a v1 interface in an outer
  compatibility adapter, never in the v1 domain package.

Every migrated test therefore receives an explicit disposition: `v1-contract`,
`compatibility-only`, `replaced`, or `removed-intentionally`. A removed behavior
needs a short migration note, not a fake v1 test that preserves it forever.

Each test is classified before its owning slice moves:

1. **Retain as black-box:** official SDK/API tests and end-to-end user-visible
   behavior continue to run against both lines where the contract is shared.
2. **Promote to interface contract:** Store, scheduler, event-log, runtime,
   sandbox, and relay behavior becomes a reusable suite that every v1
   implementation must pass. The new Agent memory and SQL packages follow
   this pattern.
3. **Convert to differential fixture:** stable input/event sequences are run
   through v0 and v1, then compared after removing explicitly versioned fields
   such as generated IDs and timestamps.
4. **Retire after replacement:** tests that assert a v0 private method, table
   placement, service-container shape, or old OMA DTO are removed only after a
   v1 interface/black-box test covers the actual invariant.

Before SessionDO is split, its valuable tests are captured by capability:

- recovery decisions and idempotency;
- active-turn versus orphan-turn alarm behavior;
- alarm rearming, poisoned schedules, and mutation during callbacks;
- event append/dedup, pending promotion, and per-thread drain serialization;
- WebSocket replay-before-live ordering and multi-client fanout;
- scheduled wakeup delivery;
- thread event/history behavior;
- long-idle and cold-start recovery;
- RuntimeRoom tenant authorization, resume state, and daemon/harness relay.

Tests that merely require `SessionDO.prototype.someMethod` are implementation
coupling. Their business expectation is moved to the relevant interface suite;
the method-shape assertion itself is not a v1 contract.

## v1 completion criteria

- No v1 interface or application package imports Cloudflare, Node, Hono, a
  database driver, or a v0 app/container.
- Every v1 domain Store has a reusable behavior contract and at least one
  non-platform implementation.
- Node and Cloudflare execute the same application modules and differ only in
  implementation selection and lifecycle adapters.
- Durable Objects contain no domain SQL and no protocol mapping.
- Official SDK black-box tests, OMA extension tests, Store contracts, replay
  tests, and Node/Cloudflare runtime parity tests all pass.
