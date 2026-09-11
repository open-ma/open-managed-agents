# Migrating from v0 to v1

v1 can run beside v0. Migrating an application does not require migrating its
database, HTTP entrypoint, and runtime in the same release.

Use `@open-managed-agents/migrate-v0` to generate a no-I/O dry-run plan before
changing composition:

```ts
import { planV0Migration } from "@open-managed-agents/migrate-v0";

const plan = planV0Migration({
  platform: { kind: "node" },
  domains: [
    { name: "agents", strategy: "compat" },
    { name: "sessions", strategy: "native" },
  ],
  rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
});
```

The result lists the platform SDK, domain packages, ordered steps,
verification targets, rollback actions, and path-specific diagnostics. The
platform step verifies workspace-scoped app identity, cross-workspace Port
isolation, and lifecycle behavior. The planner never writes configuration,
routes, or data.

Use the reviewed plan directly as the workspace cutover boundary. This keeps
the rollout predicate out of Stores and makes the selected lane observable:

```ts
import {
  createV0MigrationRouter,
  planV0Migration,
} from "@open-managed-agents/migrate-v0";

const router = createV0MigrationRouter({
  plan,
  v0: legacyApplicationSource,
  v1: createNodePlatform({ features: { preset: "none", agents: true } }),
});

const { lane, app } = router.resolve({ workspaceId });
logger.info({ workspaceId, lane }, "managed-agents lane selected");
```

`rollout.type = "workspaces"` sends only the exact listed keys to v1; all
other workspaces stay on v0. `rollout.type = "all"` sends every workspace to
v1. Invalid plans, empty keys, surrounding whitespace, and duplicate rollout
keys are rejected before routing.

## Version and HTTP compatibility

- v0 means the legacy package architecture and OMA-specific internal shapes.
- v1 means the SDK-first package architecture.
- Official Managed Agents HTTP remains under `/v1/*`.
- OMA extensions remain under `/v1/oma/*`.
- There is no `/v2` HTTP namespace.
- Official Models and OMA Models are separate interfaces:
  `GET /v1/models`, `GET /v1/models/:id`, and
  `POST /v1/oma/models/list`.

Model migration is SDK-first:

- `GET /v1/models` represents active tenant Model Cards in the official
  Managed Agents shape. Pi supplies display names, token limits, and the
  conservative capability projection.
- `POST /v1/oma/models/list` accepts an open Pi provider id and no longer
  requires `api_key`. Supplying `api_key` remains a deprecated compatibility
  branch for the old Anthropic/OpenAI live catalog.
- Stored `ant`, `oai`, `ant-compatible`, and `oai-compatible` tags continue to
  resolve. New cards should use Pi provider ids. A custom provider needs
  `base_url` plus `pi_config.api`.
- Agent `model.effort` and `model.speed` are runtime policy. They must not be
  migrated into a Model Card. Pi normalizes effort; fast speed maps only where
  Pi has an explicit Anthropic/OpenAI request control. `inference_geo` remains
  round-trip-only and does not currently route requests.

## Lowest-risk first change

Existing Agent, Environment, and Session persistence implementations already
satisfy the first extracted v1 Store interfaces. Install
`@open-managed-agents/compat-v0` and change only the composition boundary.

For code that constructs application services directly:

```ts
import { AgentsApplicationService } from
  "@open-managed-agents/managed-agents-application";
import { agentsDependenciesFromV0 } from
  "@open-managed-agents/compat-v0/agents";

const agents = new AgentsApplicationService(agentsDependenciesFromV0({
  workspaceId,
  persistence: existingAgentPersistence,
  clock,
  ids,
}));
```

The adapter returns the v1 dependency shape with `store` and preserves the
existing implementation's identity. It does not copy data or wrap every call.
`sessionsDependenciesFromV0` provides the equivalent Session migration.

For code adopting the v1 app graph:

```ts
import { createApp, providePort } from "@open-managed-agents/app";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "@open-managed-agents/app/capabilities";
import { agentsModule } from "@open-managed-agents/app/modules/agents";
import { v0AgentPersistenceModule } from
  "@open-managed-agents/compat-v0/agents";

const app = createApp({
  modules: [
    providePort(workspaceContextPort, { workspaceId }),
    providePort(clockPort, clock),
    providePort(idGeneratorPort, ids),
    v0AgentPersistenceModule(existingAgentPersistence),
    agentsModule(),
  ],
});
```

This moves dependency composition to v1 while leaving storage untouched.
Replace the compatibility module later with `providePort(agentStorePort,
nativeV1Store)`.

For a platform-level cutover, pass the same adapters to the aggregation SDK.
The workspace registry prevents a process-global app from retaining the first
tenant's `workspaceContextPort`:

```ts
import { createNodePlatform } from "@open-managed-agents/platform-node";
import { agentStoreFromV0 } from "@open-managed-agents/compat-v0/agents";

const platform = createNodePlatform({
  stores: { agents: agentStoreFromV0(existingAgentPersistence) },
  features: { preset: "none", agents: true },
});

const app = platform.app({ workspaceId });
```

The compatibility Store is private to composition. It is surfaced to modules
only as `agentStorePort`; the platform object has no `.stores` escape hatch.
Replace that one option with a native Store after parity checks. Cloudflare
accepts the same v1 Store interfaces and defaults to SQL implementations over
the supplied `SqlClient`.

## Current Store package map

| Domain | Interface | Memory implementation | SQL implementation | v0 bridge |
| --- | --- | --- | --- | --- |
| Agents | `agent-store` | `agent-store-memory` | `agent-store-sql` | `compat-v0/agents` |
| Credentials | `credential-store` | `credential-store-memory` | `credential-store-sql` | `compat-v0/credentials` |
| Deployments | `deployment-store` | `deployment-store-memory` | `deployment-store-sql` | `compat-v0/deployments` |
| Deployment Runs | `deployment-run-store` | `deployment-run-store-memory` | `deployment-run-store-sql` | `compat-v0/deployment-runs` |
| Dreams | `dream-store` | `dream-store-memory` | `dream-store-sql` | `compat-v0/dreams` |
| Environments | `environment-store` | `environment-store-memory` | `environment-store-sql` | `compat-v0/environments` |
| Environment Work | `environment-work-store` | `environment-work-store-memory` | `environment-work-store-sql` | `compat-v0/environment-work` |
| Files (metadata) | `file-store` | `file-store-memory` | `file-store-sql` | `compat-v0/files` |
| Memory Stores | `memory-store-store` | `memory-store-store-memory` | `memory-store-store-sql` | `compat-v0/memory-stores` |
| Memories + Versions | `memory-document-store` | `memory-document-store-memory` | `memory-document-store-sql` | `compat-v0/memories` |
| Skills + Versions | `skill-store` | `skill-store-memory` | `skill-store-sql` | `compat-v0/skills` |
| Tunnels + Certificates | `tunnel-store` | `tunnel-store-memory` | `tunnel-store-sql` | `compat-v0/tunnels` |
| User Profiles | `user-profile-store` | `user-profile-store-memory` | `user-profile-store-sql` | `compat-v0/user-profiles` |
| Sessions | `session-store` | `session-store-memory` | `session-store-sql` | `compat-v0/sessions` |
| Session Events | `session-event-store` | `session-event-store-memory` | `session-event-store-sql` | `compat-v0/session-events` |
| Session Resources | `session-resource-store` | `session-resource-store-memory` | `session-resource-store-sql` | `compat-v0/session-resources` |
| Session Threads | `session-thread-store` | `session-thread-store-memory` | `session-thread-store-sql` | `compat-v0/session-threads` |
| Vaults | `vault-store` | `vault-store-memory` | `vault-store-sql` | `compat-v0/vaults` |

Session Threads migrate together with their thread-event read projection. Use
`sessionThreadStoreFromV0`, `sessionThreadsDependenciesFromV0`, and
`v0SessionThreadPersistenceModule` for the aggregate; use
`sessionThreadEventStoreFromV0`,
`sessionThreadEventsDependenciesFromV0`, and
`v0SessionThreadEventPersistenceModule` for the projection. The v0 aggregate
did not expose insertion, so the bridge rejects `insert` explicitly and cannot
add the native Store's atomic concurrent-archive guarantee. Promote to the
native Store before enabling writers or concurrent archive traffic.

The native path installs `session-thread-store-sql` together with
`session-event-store-sql`. Both Session Event and Thread Event Ports resolve
the same event Store; no event rows are copied and no competing event log is
created. Verify first-transition lifecycle signaling, thread relation indexes,
stable cursors, workspace/Session isolation, and byte-equivalent existing
event documents before promotion.

Session Resources remain part of the Session revision. Use
`sessionResourceStoreFromV0`, `sessionResourcesDependenciesFromV0`, or
`v0SessionResourcePersistenceModule` to retain the existing structural
persistence object without copying rows. The native path installs
`session-resource-store-sql` with `session-store-sql`; it synchronizes the
public Session document, sealed GitHub tokens, and Memory Store relation rows
in one CAS batch. Verify official SDK responses, mount-path/cursor behavior,
workspace isolation, ciphertext secrecy, and exact relation rows before
promotion.

Files deliberately use two capabilities: `file-store` owns metadata and
`file-content-store` owns bytes. Existing `BlobFileContentStore` deployments
can be retained while metadata composition moves through `compat-v0/files`;
neither adapter copies data. The existing Files application logic—including
upload compensation, pagination, scope filtering, and cleanup—stays in place.
The migration planner verifies metadata counts and content checksums
independently.

Memory Stores deliberately use `memory-store-store` because the existing
`memory-store` package belongs to the v0 memory-content system. Use
`memoryStoreStoreFromV0`, `memoryStoresDependenciesFromV0`, or
`v0MemoryStorePersistenceModule` to reuse the current structural persistence
without copying rows. The native Store retains workspace keys, aggregate
documents, revisions, timestamps, inclusive time filters, and stable cursor
ordering. Verify through `@anthropic-ai/sdk`, not a repository-only DTO.

Memories deliberately use `memory-document-store`. The existing
`memory-store` package is v0 content infrastructure, while
`memory-store-store` represents the SDK Memory Store resource; neither is the
hierarchical SDK Memory document. Use `memoryDocumentStoreFromV0`,
`memoriesDependenciesFromV0`, `memoryVersionsDependenciesFromV0`, or
`v0MemoryPersistenceModule` to keep a structurally compatible implementation
without copying rows. Before promotion, verify the SDK `memory | memory_prefix`
union, basic/full projections, SHA-256 preconditions and idempotent retries,
path uniqueness, atomic current/history writes, inclusive version filters,
redaction, deletion history, and workspace isolation.

Skills use `skill-store` for both Skill metadata and immutable Skill Version
archives. Use `skillStoreFromV0`, `skillsDependenciesFromV0`,
`skillVersionsDependenciesFromV0`, or `v0SkillPersistenceModule` to retain a
structurally compatible persistence object without copying rows or archives.
Before promotion, verify official SDK multipart uploads, source filtering and
stable cursors, latest-Version revision CAS, byte-identical archive downloads,
Version deletion with predecessor promotion, and workspace isolation.

Tunnels use `tunnel-store` for the Tunnel and Certificate aggregate while
hostname provisioning, live connector tokens, and CA registration remain
separate outbound Ports. Use `tunnelStoreFromV0`, `tunnelsDependenciesFromV0`,
`tunnelCertificatesDependenciesFromV0`, or `v0TunnelPersistenceModule` to
retain existing rows. Verify the official SDK beta header and routes, stable
cursors, the two-active-Certificate admission rule, aggregate archive CAS and
idempotency, live-token secrecy/rotation, and workspace isolation.

User Profiles use `user-profile-store` for the official SDK resource only.
Use `userProfileStoreFromV0`, `userProfilesDependenciesFromV0`, or
`v0UserProfilePersistenceModule` to retain a structurally compatible
persistence object without copying rows. Before promotion, verify metadata
merge/delete behavior, nullable field clearing, ascending and descending
cursor binding, read-only `trust_grants`, ephemeral enrollment URLs, and
workspace isolation. Do not migrate or introduce Tenant, membership, or auth
relationships here: OpenMA tenancy belongs to the outer SDK consumer, while
`workspaceId` is only the Store partition supplied by that host.

Environment Work uses `environment-work-store` for the self-hosted runner
queue aggregate. Use `environmentWorkStoreFromV0`,
`environmentWorkDependenciesFromV0`,
`environmentWorkEnqueuerDependenciesFromV0`, or
`v0EnvironmentWorkPersistenceModule` to reuse the current structural queue
without copying rows. Verify the official SDK work routes, metadata patching,
atomic claim/reclaim ordering, heartbeat preconditions, worker statistics,
workspace isolation, and that credentials are encrypted at rest and exposed
only by `poll`.

Vault migration is also identity-preserving. `vaultStoreFromV0`,
`vaultsDependenciesFromV0`, and `v0VaultPersistenceModule` reuse the existing
structural persistence object without copying rows. Vault and Credential
Stores remain independent; compose `credentialVaultSourceFromVaultStore` over
the selected Vault Store so Credential validation observes the same workspace
and archive state. Verify Vault counts, archive state, revisions, Credential
lookup consistency, and official API responses before promotion.

Deployment migration preserves the existing application core and the full
stored aggregate. `deploymentStoreFromV0`, `deploymentsDependenciesFromV0`,
and `v0DeploymentPersistenceModule` reuse a structurally compatible v0
persistence object without copying data. Verify Deployment counts, statuses,
revisions, dependency readiness, official API responses, and sealed
resource-secret round trips before promotion; comparisons and logs must never
contain plaintext authorization tokens.

Deployment Run migration retains the atomic admission contract. Use
`deploymentRunStoreFromV0`, `deploymentRunsDependenciesFromV0`, or
`v0DeploymentRunPersistenceModule` to install an existing structural
persistence implementation unchanged. Before promotion, verify Run counts,
Deployment linkage, session/error outcomes, Run revisions, and that a stale,
paused, archived, or missing Deployment cannot admit a manual Run.

Dream migration keeps the current curator, execution state machine, scheduler
outcomes, and Memory Store write behavior. Use `dreamStoreFromV0`,
`dreamsDependenciesFromV0`, `dreamExecutionDependenciesFromV0`, or
`v0DreamPersistenceModule` to retain the existing structural persistence
object without copying rows. Verify lifecycle status counts, revisions,
scheduler-failure recording, execution outputs/usage, and official API
responses before promotion. Node may cache the composed app per workspace;
Cloudflare should compose the in-process scheduler at the request boundary so
its `waitUntil` callback never outlives the request that supplied it.

Runtime capabilities migrate independently from Stores:

| Capability | Interface | Development implementation | Platform implementation | v0 coexistence |
| --- | --- | --- | --- | --- |
| Session runtime commands/reads | `session-runtime-contract` | — | `session-runtime-sql` plus Node/CF adapters | v0 `session-runtime` keeps its package name |
| Realtime fanout | `session-realtime` | `session-realtime-memory` | injected by the platform composition root | old Node hub remains on the v0 lane |
| Scheduled wakeups | `session-wakeup` | `session-wakeup-memory` | `session-wakeup-cloudflare` | SessionDO keeps the snake_case tool facade and reads legacy alarm rows |
| Runtime daemon relay policy | `runtime-relay` | pure policy package | RuntimeRoom or a Node relay executes planned effects | existing WebSocket frames and DO storage keys remain valid |

For the Cloudflare wakeup slice, deploy the interface and implementation
packages before removing any old alarm rows. No data migration is required:
the adapter recognizes legacy callback payloads, while newly registered rows
use the v1 application-native payload. Existing `delay_seconds`, `fire_at`,
`scheduled_at`, and `parent_event_id` names terminate at the SessionDO
compatibility facade.

The dry-run planner exposes this path explicitly and will not silently choose
a runtime platform:

```ts
planV0Migration({
  domains: [{
    name: "session-wakeups",
    strategy: "compat",
    platform: "cloudflare",
  }],
  rollout: { type: "workspaces", workspaceIds: ["workspace_01"] },
});
```

It verifies delivery, terminated-Session suppression, the capacity guard, and
legacy row decoding. A Node wakeup implementation must be selected separately;
the planner will not recommend the Cloudflare package for Node.

`SqlAgentPersistence` and `SqlSessionPersistence` remain compatibility class
names in the old SQL adapter package. Their implementations now come from the
domain SQL packages. New code should use `SqlAgentStore` and
`SqlSessionStore`.

`SqlSessionThreadPersistence` is retained as a compatibility class name and
delegates to `SqlSessionThreadStore`. Thread-event compatibility delegates its
old `list` method to `SqlSessionEventStore.listThread`; it does not own another
event table. New composition installs `session-thread-store-sql` through
`sessionThreadStorePort` and supplies the same `SqlSessionEventStore` instance
to `sessionEventStorePort` and `sessionThreadEventStorePort`.

`SqlSessionResourcePersistence` is retained as a compatibility class name and
delegates to `SqlSessionResourceStore`. New composition installs it through
`sessionResourceStorePort` with the same SQL client and secret sealer used by
the selected Session Store. Resource replacement now also reconciles
`managed_session_memory_stores`, preventing stale Session list-filter links
after a resource update or deletion.

`SqlEnvironmentPersistence` follows the same rule and delegates to
`SqlEnvironmentStore`. The dry-run planner supports an `environments` slice,
so the old persistence object can first be installed through
`compat-v0/environments` without copying rows or changing table names.

`SqlCredentialPersistence` is retained as a compatibility class name and
delegates to `SqlCredentialStore`. Its cipher still seals and opens the entire
Credential document, so existing ciphertext, table rows, revisions, and key
management remain valid. The dry-run planner verifies redacted official API
responses separately from encrypted document round trips; migration must never
log or compare plaintext secrets.

`SqlFileMetadataPersistence` is likewise retained as a compatibility class
name and delegates to `SqlFileStore`. The dry-run planner supports a `files`
slice and installs `file-store` together with `file-content-store`, so metadata
and content can be cut over independently without changing existing rows or
blob keys.

`SqlVaultPersistence` is retained as a compatibility class name and delegates
to `SqlVaultStore`. It uses the same tables, workspace keys, ordering, and
revision values. The retained Vaults application service still owns validation,
null patch semantics, cursor behavior, archive/delete outcomes, and CAS
conflicts; migration changes construction boundaries, not those rules.

`SqlDeploymentPersistence` is retained as a compatibility class name and
delegates to `SqlDeploymentStore`. Existing Deployment rows, workspace keys,
aggregate revisions, filtering/order semantics, and encrypted resource-secret
documents remain valid. `DeploymentResourceSecretCipher` is still constructed
at the outer SQL/platform boundary. The retained Deployments application
service continues to own validation, dependency resolution, scheduling,
redaction, state transitions, manual-run orchestration, and CAS conflicts.

`SqlDeploymentRunPersistence` is retained as a compatibility class name and
delegates to `SqlDeploymentRunStore`. The native SQL Store preserves existing
Run rows and revisions and keeps the active-Deployment revision guard inside a
single database statement. Both official Deployment and Deployment Run routes
resolve Ports from the same workspace app graph during migration.

`SqlDreamPersistence` is retained as a compatibility class name and delegates
to `SqlDreamStore`. The native Store uses the same table, workspace key,
aggregate document, status index, ordering, and revision values. New code
installs `dream-store-sql` through `dreamStorePort`; the retained application
and execution services continue to own lifecycle and concurrency decisions.

`SqlMemoryStorePersistence` is retained as a compatibility class name and
delegates to `SqlMemoryStoreStore`. New composition installs
`memory-store-store-sql` through `memoryStoreStorePort`; the retained
application service continues to own validation, nullable patch behavior,
cursor encoding, page sizing, and revision-conflict mapping. Official routes
resolve that service through `memoryStoresModule()` on Node and Cloudflare.

`SqlMemoryPersistence` is retained as a compatibility class name and delegates
to `SqlMemoryDocumentStore`. New composition installs
`memory-document-store-sql` through `memoryDocumentStorePort`; HTTP and Dreams
resolve the retained application through `memoriesModule()` (and HTTP also
installs `memoryVersionsModule()`). Existing current Memory rows and immutable
Memory Version history remain in place.

`SqlSkillPersistence` is retained as a compatibility class name and delegates
to `SqlSkillStore`. New composition installs `skill-store-sql` through
`skillStorePort`; HTTP resolves the retained Skills and Skill Versions
application services through `skillsModule()` and `skillVersionsModule()`.
Existing Skill rows, Version rows, revisions, and package archives remain in
place.

`SqlTunnelPersistence` is retained as a compatibility class name and delegates
to `SqlTunnelStore`. New composition installs `tunnel-store-sql` through
`tunnelStorePort`; HTTP resolves `tunnelsModule()` and
`tunnelCertificatesModule()` from the same workspace app graph. Existing
Tunnel aggregates, revisions, hostnames, Certificate records, and token
identifiers remain in place; live connector-token values stay outside the
Store.

`SqlUserProfilePersistence` is retained as a compatibility class name and
delegates to `SqlUserProfileStore`. New composition installs
`user-profile-store-sql` through `userProfileStorePort`; HTTP resolves
`userProfilesModule()` from the workspace app graph. Existing profile rows,
revisions, metadata, trust grants, and optional fields remain in place.
Enrollment URLs remain outbound-only and are not migration data.

`SqlEnvironmentWorkPersistence` is retained as a compatibility class name and
delegates to `SqlEnvironmentWorkStore`. New composition installs the Store
through `environmentWorkStorePort`; HTTP resolves `environmentWorkModule()` and
Session lifecycle resolves `environmentWorkEnqueuerModule()` from the same app
graph. Existing queue rows, sealed credentials, claims, heartbeat leases,
revisions, and worker polling records remain in place.

`SqlManagedSessionsComposition` is also retained as a migration facade. Its
`portsFor(workspaceId)` method now resolves a strict v1 `createApp` graph made
from the Sessions, Session Events, Session Resources, Session Threads, and
Session Thread Events modules. Repeated calls for one workspace return the
same Port graph; another workspace receives a separate graph. Existing HTTP
and Deployment callers can therefore keep the old facade while application
construction moves to v1, then switch to the module Ports independently.

## Recommended rollout

1. Add v1 packages without removing v0.
2. Move one domain's composition to a `compat-v0` module.
3. Run the existing black-box tests and compare official API responses.
4. Enable v1 for selected workspaces or sessions.
5. Observe errors, event traces, row counts, revisions, and side-effect
   receipts.
6. Replace the compatibility module with a native v1 implementation.
7. Remove the v0 path only after the observation window.

Keep the rollout decision outside domain Stores. A workspace/session router at
the application boundary can choose v0 or v1 without contaminating either
interface.

## Rollback

Before cutover, record the exact v0 module/factory and routing predicate being
replaced. Rollback changes the route back to that factory; it does not mutate
the Store interface. Data migrations are additive by default, and destructive
schema cleanup is a separate, later operation.

Do not dual-write by default. Use it only when a domain's cutover cannot be
validated through shared storage or an additive copy. Any dual-write adapter
must emit independent receipts for the v0 and v1 writes so partial success is
visible and retryable.

## Test disposition

Existing v0 tests are retained when they verify public behavior or safety
invariants. During extraction each test is classified as `v1-contract`,
`compatibility-only`, `replaced`, or `removed-intentionally`. The existing SQL
Agent and Session test suites currently execute through the old class names,
which verifies that those compatibility imports still reach the native v1 SQL
Stores.

The existing `@open-managed-agents/session-runtime` package is a v0 machine
and adapter implementation. New code depends on the narrow
`@open-managed-agents/session-runtime-contract` interfaces. Both packages are
installed side by side during migration; no package-name takeover is required.
