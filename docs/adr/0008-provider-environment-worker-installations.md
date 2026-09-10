# ADR 0008: Embedded provider drivers and the external Worker boundary

**Status**: Accepted and partially implemented (2026-09-07)

**Related**: [`0005-self-hosted-worker-runtime-resources.md`](0005-self-hosted-worker-runtime-resources.md),
[`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0007-sandbox-credential-egress.md`](0007-sandbox-credential-egress.md),
[`../claude-managed-agents-sandbox-provider-audit.md`](../claude-managed-agents-sandbox-provider-audit.md)

## Context

Claude Managed Agents standardizes Environment Work, not the placement of the
provider sandbox control plane. Provider references show three physical
placements:

- a host process calls the provider SDK directly;
- a sidecar or remote driver service calls the provider SDK;
- mandatory provider-native components participate in acquisition.

Those placements all perform the same logical second-layer job: receive Work,
manage the sandbox lifecycle and run the Environment Worker. OpenMA should own
that logical control loop for the integrations it maintains. It should not also
become an installer and operator for every provider’s sample application.

OpenMA already has the correct maintained execution spine:

```text
ManagedEnvironmentWorker
  -> ManagedRuntimeHost
     -> ManagedSandboxPort
     -> WorkspacePersistencePort
     -> SessionOutputPort
     -> SandboxHarnessDriverPort
     -> RuntimeCheckpointPort / CredentialEgressPort / orphan handling
```

Users must still be able to bring any conforming external Environment Worker.
That is a protocol compatibility boundary, not an OpenMA-maintained provider
implementation.

## Decision

### Maintain only the embedded execution model

`embedded` means that OpenMA owns the second-layer state machine and its
reliability guarantees. It does **not** require every provider driver to execute
inside the same Node.js process.

```ts
type EmbeddedDriverPlacement =
  | "in_process"
  | "driver_service"
  | "provider_native";

interface EmbeddedProviderSpec {
  environmentId: string;
  provider: string;
  placement: EmbeddedDriverPlacement;
  requirements: {
    workspace: "durable" | "continuable" | "ephemeral";
    outputs: "durable" | "best_effort" | "disabled";
    credentialEgress: "required" | "best_effort" | "disabled";
    harnessPlacement: "outside" | "inside" | "both";
  };
  providerConfig: Readonly<Record<string, unknown>>;
}
```

The placement is an adapter implementation detail:

- `in_process`: OpenMA imports a provider SDK directly;
- `driver_service`: an OpenMA-owned, versioned local or remote service exposes
  the same resource Port;
- `provider_native`: the driver uses mandatory provider infrastructure such as
  AWS MicroVM launch or GKE `SandboxClaim`.

All three are embedded in the architectural sense because OpenMA owns Work
delivery, fencing, retry policy, persistence composition, egress lifecycle and
canonical publication.

### Reuse the current Runtime Host rather than wrapping it

The provider adapter supplies resource Ports to `ManagedRuntimeHost`. It does
not introduce another `runSession()` facade.

```ts
interface EmbeddedProviderResources {
  sandbox: ManagedSandboxPort;
  workspace: WorkspacePersistencePort;
  outputs: SessionOutputPort;
  harnessDriver: SandboxHarnessDriverPort;
  runtimeCheckpoint?: RuntimeCheckpointPort;
  credentialEgress?: CredentialEgressPort;
}

interface EmbeddedProviderDriverFactory {
  descriptor(): {
    provider: string;
    version: string;
    placements: readonly EmbeddedDriverPlacement[];
    capabilities: ManagedRuntimeResourceCapabilities;
  };

  create(input: {
    environmentId: string;
    placement: EmbeddedDriverPlacement;
    profile: ManagedRuntimeProfile;
    plan: ManagedRuntimePlan;
    providerConfig: Readonly<Record<string, unknown>>;
  }): Promise<EmbeddedProviderResources>;
}
```

The factory owns the provider SDK client or its driver-service/provider-native
bridge. Its constructor keeps provider-specific deployment settings—such as
GKE namespace/template/warm-pool names, Cloudflare bindings/backend resolvers,
or AWS launcher/AMI settings—strongly typed inside the isolated adapter. Only
the dynamic loader boundary treats those values as opaque. Per-environment
`providerConfig` is forwarded unchanged and never promoted into the common
Work protocol.

`createManagedRuntimeProviderHost()` projects a selected driver into the
ordinary `ManagedRuntimeHost` instead of creating a second lifecycle facade.
It performs descriptor admission before calling the driver, checks the
returned Port capabilities for drift, and then uses the same fenced
acquire/prepare/run/publish/release state machine as a preinstalled runtime.
Work lifecycle selection is made once by
`createManagedEnvironmentWorkerInstallation()`; only the selected adapter
module is imported.
`ManagedRuntimeHost` retains resource fencing and the acquire/prepare/run/
publish/release ordering.

### Keep orchestration libraries behind the Port boundary

The maintained runtime kernel may use Effect internally for structured
concurrency, cancellation, timeout/retry policy, typed internal failures and
uninterruptible compensation. This is an implementation choice, not part of
the runtime protocol:

- public resource Ports remain Promise-based and provider-neutral;
- SDK, HTTP, CLI, Console and provider configuration shapes never expose
  `Effect`, `Scope`, `Layer` or Effect error types;
- each provider adapter remains independently packaged and does not inherit an
  Effect dependency merely because the kernel uses it;
- the Promise boundary unwraps typed failures, caller abort reasons and defects
  so callers do not observe `FiberFailure` wrappers;
- Effect is reserved for lifecycle orchestration. Pure validation, mapping and
  serialization stay ordinary TypeScript.

Long-lived sandbox ownership remains represented by the persisted OpenMA
lease/fence state machine. An in-process Effect scope must not become the
source of truth and must not release a successfully attached sandbox when the
short acquisition program exits.

Official Session resources are also a fail-closed boundary. If a claimed
Session contains file, repository, or memory-store resource records, the
selected composition must supply `SessionInputMaterializerPort`; otherwise the
host rejects the run before provider compute allocation. A provider replacement
therefore cannot appear healthy while silently dropping declared inputs.

### Make Work acquisition strategy explicit

The provider references do not all claim Work at the same point:

```ts
type WorkAcquisitionStrategy =
  | "claim_then_acquire"
  | "acquire_then_session_poll"
  | "poll_unacked_then_dispatch";
```

- `claim_then_acquire`: the OpenMA Runtime Host uses the official SDK poller,
  which ACKs before yielding, and owns heartbeat/stop while it acquires the
  sandbox. Node/Docker and direct Runtime Host providers use this lane.
- `poll_unacked_then_dispatch`: OpenMA calls the raw official `work.poll`
  endpoint, deliberately does not ACK, and routes the reserved Work to a
  session runtime. The runtime sends the first heartbeat/ACK and then owns
  heartbeat/stop. Cloudflare MicroVM/Isolate and GKE `SandboxClaim` use this
  lane.
- `acquire_then_session_poll`: a signed webhook is durably deduplicated and
  launches provider compute before any outer Work poll. The worker inside that
  compute polls and claims its Session Work. AWS MicroVM uses this lane.

This strategy belongs to the OpenMA-owned kernel/driver composition. It does not
change the CMA HTTP payloads.

The corresponding isolated packages are:

- `environment-dispatch-cloudflare` and `environment-dispatch-gke`, loaded
  through `createManagedEnvironmentWorkDispatchPort()`;
- `environment-activation-aws`, loaded through
  `createManagedEnvironmentActivationPort()`;
- provider-neutral SQL activation intents in
  `environment-activation-store-sql`.

The Cloudflare dispatch contract addresses a session-named MicroVM Sandbox DO
or Isolate runner DO and invokes one idempotent `dispatch()` method. The runtime,
not the generic adapter, serializes concurrent starts, restores storage before
read/write access, applies egress before first outbound traffic, and owns the
Work lease. The Environment key stays in the trusted Worker/DO binding and is
not copied into Work metadata or the runtime dispatch payload.

### Treat `external_worker` as BYOW compatibility, not a provider adapter

OpenMA exposes the unchanged CMA-compatible boundary required by a user-managed
Worker:

- Environment Work poll/claim/heartbeat/stop endpoints;
- webhook delivery and fallback-poll compatibility;
- scoped Environment Worker credential issue, rotate and revoke;
- Session/Work identifiers and official SDK/CLI wire shapes;
- optional protocol conformance tooling and observability.

The user owns deployment, provider SDK calls, sandbox lifecycle, persistence,
egress, scaling, recovery and cleanup. OpenMA does not pin, install, upgrade,
probe or destroy the external application and does not advertise its provider
capabilities as an OpenMA guarantee.

There is therefore no `ExternalWorkerInstallationPort` in the maintained core.
The Work API itself is the Port. A future marketplace or deployment plugin can
automate an external Worker without becoming part of the runtime correctness
boundary.

### Use one credential and Work state machine for both lanes

BYOW and embedded execution do not get separate Work authorities. Both use a
dedicated, rotatable Environment service key for poll/claim+ACK, then prefer
the same per-claim `sessions_token` for heartbeat/stop and Session APIs. Both
credentials traverse the same official Work endpoints and state machine. Only
after claim does placement branch:

```text
Environment Work state machine
  -> external Worker (operator owns everything below Work)
  -> embedded Runtime Host (OpenMA owns provider lifecycle below Work)
```

An Environment key is Bearer-only and exact-Environment Work-only. The
claim-bound token is also Bearer-only, exact-Work/Session scoped and checked
against the current claim generation. A workspace key is an administrator
credential used to mint/revoke the Environment key, not a standing Worker
credential. `runExternalEnvironmentWorkerConformance()` and
`scripts/environment-worker-conformance.ts` provide the protocol oracle for an
already-enqueued disposable Work item.

## Embedded provider baseline

| Provider | OpenMA-owned placement | What remains provider-native | Upstream reference use |
|---|---|---|---|
| Cloudflare | `in_process` on Workers; `driver_service` from Node | Sandbox SDK, Durable Object/Container bindings and egress hooks | Lifecycle source and conformance oracle |
| Blaxel | `driver_service` or direct provider API | Sandbox compute, Volume and native proxy | Recovery/duplicate-suppression oracle |
| Daytona | `in_process` or `driver_service` | Sandbox service, archive/retain and network broker | SDK/lifecycle implementation reference |
| E2B | `in_process` | Sandbox service, pause/auto-resume and snapshots | SDK plus routing/liveness reference |
| Sprites | `driver_service` or direct provider API | Sprite Service/Task, persistent filesystem and Connectors | Lifecycle implementation reference |
| Vercel | `in_process` or `provider_native` | Vercel Sandbox and native firewall injection | Firewall and launch reference |
| Modal | `driver_service` | Modal Sandbox, Function and Volume | Python lifecycle reference |
| AWS MicroVM | `provider_native` | Launcher API, MicroVM execution identity and in-VM Worker | Launch/idempotency reference |
| GKE Agent Sandbox | `provider_native` | Kubernetes controllers, WarmPool, `SandboxClaim` and gVisor | Warm-pool/reaper reference |
| Superserve | `in_process` | Sandbox service, pause/resume, token rotation and native secret proxy | SDK/liveness/egress reference |

The upstream applications are audited source and test oracles. OpenMA may reuse
their SDK packages and provider-native components, but does not promise to
deploy or operate those applications for users.

Every maintained provider driver is published as its own
`managed-runtime-<provider>`, `sandbox-adapter-<provider>`,
`environment-dispatch-<provider>`, or
`environment-activation-<provider>` package. Vendor SDKs are optional peer
dependencies of that package, never dependencies of the kernel, Runtime Host,
generic Sandbox composition, provider-neutral stores, or another provider
driver. The workspace disables pnpm peer auto-installation so the default
install remains provider-neutral. A deployment installs only the selected
driver plus its vendor SDK; the relevant lazy loader validates its uniform
factory and provider descriptor before allocation or dispatch.

The common factory is intentionally not a lowest-common-denominator
configuration object. `factoryOptions` is owned and strongly typed by the
selected adapter package. GKE keeps namespace, template and warm-pool
configuration; Cloudflare keeps Worker bindings/backend resolvers; AWS keeps
launcher, image and network identifiers; other providers keep equivalent
native launch fields. These values may change how a driver satisfies a common
capability, but they do not leak into the provider-neutral Work, lease,
workspace, output, or fencing payloads.

Embedded Runtime Host drivers preinstall a Session input materializer. A
claim-scoped access Port downloads attached files without exposing the
`sessions_token` to the provider or persistence layers; files are staged as
exact bytes, repository resources are cloned after credential egress is
attached, and a restored canonical workspace suppresses a destructive
re-clone. The official AMA Worker continues to own Skill and Memory Store
hydration and uses the SDK's `SessionMemoryStores` loop. A supervised harness
instead assigns Memory Store ownership to the shared OpenMA materializer. That
implementation hydrates a dedicated mount, records a durable private CAS
baseline, syncs every 15 seconds and at live/final checkpoint boundaries, and
performs a three-way merge through the Work token's Session-scoped Memory API.
Every create, update, delete, and rename revalidates the runtime fence; remote
state wins a two-sided conflict. Missing markers and bulk deletes fail safe and
trigger a canonical rebase rather than a mass server delete. Docker and all
generic provider drivers consume this same Port, while a provider may replace
only the filesystem projection. The host rejects missing required resource or
credential-egress capabilities before allocation and never treats a skipped
resource as successful staging.

On a Cloudflare deployment, the OpenMA Worker can call `getSandbox()` through
its configured `DurableObjectNamespace` binding in-process. A generic Node
process cannot hold that binding directly: it calls an OpenMA-owned deployment
of the official Sandbox bridge over HTTP. The bridge is a provider driver
service, not another CMA Environment Worker or another Work control plane.
The implemented Bridge driver uses the official create/running/delete,
argv/SSE exec, workspace file, persist and hydrate routes. It exposes only the
`ama_worker` lane because `/exec` has no streaming stdin. Portable workspace
archives are hashed and persisted through `BlobStore`; final outputs keep the
canonical `/mnt/session/outputs` contract and are read through argv/SSE.

Both direct and Bridge paths use a readiness barrier before runtime
publication. If identity validation, liveness, abort, hydrate or runtime
checkpoint restore fails, the newly allocated runtime is destroyed. Provider
lease renewal is attempted only when the provider explicitly declares a lease;
the Bridge declares liveness without inventing provider-lease semantics.

## One-click provider replacement

OpenMA guarantees one-click replacement only between maintained embedded
drivers whose declared capabilities satisfy the workload:

```text
validate candidate provider and portability requirements
  -> prepare candidate driver and candidate-only credential
  -> run lifecycle + protocol + persistence + egress probes
  -> CAS active provider generation
  -> candidate may acquire normal Work
  -> old generation drains owned Work but cannot acquire new Work
  -> revoke old egress and Worker credentials
  -> release/reap old provider resources
```

Provider-private Volumes, disks and process snapshots are not automatically
portable. Replacement must either checkpoint/collect through OpenMA’s canonical
workspace/output Ports, drain old Work in place, accept Event Log plus workspace
cold recovery, or reject the switch.

For an external Worker, OpenMA only supports credential rotation/revocation and
Work draining at the protocol boundary. The user is responsible for deploying
the replacement and proving its provider behavior.

## State ownership

Embedded provider generation:

```text
candidate -> active -> draining -> retired
         \-> failed   \-> rollback
```

Persist at minimum:

- Environment ID, provider, driver version, placement and generation;
- validated provider-config digest, never plaintext secrets;
- observed capability manifest and conformance result;
- active/draining pointer revision;
- token-free sandbox/resource handles and orphan cleanup state.

Per-Work runtime state remains the existing leased and fenced execution state
machine. Provider sample locks, JSON maps or routing databases never become the
OpenMA Work/Event Log source of truth.

## Persistence and egress requirements

Every embedded driver reports actual capabilities:

- workspace: native durable filesystem, provider Volume, retained runtime,
  portable checkpoint/restore, or ephemeral;
- outputs: durable mount, watch-and-upload, final collection, or disabled;
- process memory: separately declared and never implied by workspace state;
- egress: transparent interception/native broker, enforced network proxy,
  network policy only, or advisory environment variables.

OpenMA fails closed when a runtime profile requires a guarantee the embedded
driver cannot enforce. Credential specs contain references only; values are not
persisted in driver configuration, leases, checkpoints or logs.

No such guarantee is inferred for an external Worker. External operators may
publish self-declared metadata for observability, but it remains untrusted until
verified by their own conformance run.

## Conformance and chaos gates

Every maintained embedded driver must pass:

1. duplicate webhook and fallback poll produce one effective claim;
2. lost webhook is recovered;
3. post-claim acquire failure releases or reclaims Work correctly;
4. host/driver-service/provider-native launcher crash recovers idempotently;
5. duplicate acquire does not create duplicate effective runtimes;
6. stale generation cannot claim, heartbeat, publish or settle;
7. runner crash and provider timeout create a retryable state or durable orphan;
8. checkpoint/output publication rejects stale fencing tokens;
9. credentials are revoked before retained compute is released when enforceable;
10. destroy/reap is idempotent and serialized state contains no secret;
11. workspace/output behavior survives the provider-specific failure it claims
    to tolerate;
12. AWS/Cloudflare/GKE alternative acquisition strategies preserve one
    effective Work owner and never let the outer raw poller ACK on behalf of
    an in-runtime worker.

The external Worker surface receives protocol compatibility tests only. Users
can run an exported conformance kit against their deployment, but OpenMA does
not put their sandbox reliability into its release gate.

## Consequences

OpenMA maintains one reliable execution kernel and a finite set of embedded
provider drivers. First-party provider references remain valuable as audited
behavioral sources without turning OpenMA into a cross-cloud deployment
platform.

External Workers remain fully interoperable through the official protocol,
while their deployment and reliability stay under the operator’s control. The
trade-off is explicit: BYOW is flexible, but only embedded drivers receive
OpenMA lifecycle, persistence, egress and chaos-test guarantees.
