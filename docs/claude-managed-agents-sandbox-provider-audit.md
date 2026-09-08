# Claude Managed Agents sandbox provider adapter audit

> Audit date: 2026-09-07
>
> Scope: provider-maintained implementations that connect Anthropic Claude
> Managed Agents (CMA) Environment Work to provider sandboxes. OpenMA continues
> to own its public API, Environment Work/Event Log authority, leases and fences.

## Conclusion

There is one CMA worker protocol, but there is no single portable “managed
sandbox adapter” package. The first-party references combine several different
roles in different processes:

1. **Session client** creates the CMA Session.
2. **Managed Agents control plane** creates Environment Work and owns its queue.
3. **Work consumer** receives a webhook or polls, then claims Work when the
   provider design requires a claim before launch.
4. **Sandbox control plane** calls the provider SDK/API to create, reconnect,
   restore, configure, probe and retire a sandbox.
5. **In-sandbox runner** handles one claimed Work item or polls for the matching
   Session from inside the sandbox.
6. **Installer** deploys the Work consumer, templates, images, secrets and
   provider infrastructure.

The provider SDK launch calls are runtime control-plane behavior. They do not
become “deployment” merely because a provider publishes the caller as a
deployable reference application. Installation is orthogonal to execution
placement.

OpenMA needs two product surfaces:

- **Maintained embedded execution:** OpenMA’s `ManagedEnvironmentWorker` owns
  Work delivery and the common lifecycle state machine. A provider driver may
  run in-process, behind an OpenMA-owned driver service, or use mandatory
  provider-native components.
- **External Worker compatibility:** OpenMA exposes the CMA-compatible Work,
  webhook and credential boundary. Users may deploy any Worker they want, but
  OpenMA does not operate or guarantee its sandbox lifecycle.

First-party control-plane applications are implementation evidence and test
oracles for embedded drivers. OpenMA does not need to install and maintain all
of them. Opaque hosted connectors are outside the maintained provider scope.

## CMA protocol boundary

Anthropic’s [self-hosted sandbox contract](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
defines these invariants:

- An Environment is a Work queue.
- A Worker may poll continuously or be awakened by webhook. Webhook delivery
  does not itself standardize provider sandbox lifecycle.
- The customer/provider owns sandbox creation, files/Git staging, network and
  filesystem behavior.
- The SDK/CLI worker can run in a host process or inside the sandbox depending
  on the reference topology.
- `/workspace` is the default working directory. Self-hosted output and durable
  workspace semantics are provider/customer responsibilities.
- The Work/session credential is scoped to CMA operations; third-party secrets
  still require an egress/broker design.

## Where the provider SDK actually runs

| Provider | Work consumer | Provider SDK/API caller | Runner | Reusable first-party unit | Recommended OpenMA use |
|---|---|---|---|---|---|
| Cloudflare | Ordinary Workers request handler drains Work | The same Worker calls `getSessionSandbox()` or `getIsolateRunner()` | In MicroVM or Isolate | Private Workers application plus public Sandbox SDK/bridge | Embedded driver: in-process on Workers, driver service from Node |
| Blaxel | Orchestrator sandbox polls and performs recovery | The orchestrator calls the Blaxel SDK | Per-session worker sandbox | Provider reference app/images | Embedded driver; reference supplies recovery tests |
| Daytona | Long-lived Python host, by polling or webhook | That host calls Daytona SDK create/get/start/stop/archive APIs | Per-session Daytona sandbox | Provider guide/reference app plus public SDK | Embedded driver |
| E2B | Direct host poller, app webhook server, or router sandbox | Whichever component owns routing calls `Sandbox.connect/create` | Per-session E2B sandbox | Public SDK plus multiple reference topologies | Embedded in-process driver |
| Fly.io / Sprites | Fly dispatcher polls or handles webhook | Dispatcher calls Sprites SDK | Worker process inside persistent Sprite | Provider reference deployment plus public SDK | Embedded driver; reference supplies lifecycle behavior |
| Vercel | Vercel Function handles webhook and polls/acks | Function calls `Sandbox.create()` in `waitUntil` | Vercel Sandbox | Private reference Next app plus public SDK | Embedded driver; retain native firewall integration where available |
| Modal | Modal webhook Function drains Work | Function calls `modal.Sandbox.from_name/create` | Modal Sandbox | Modal App/reference source plus SDK | Embedded driver service |
| AWS Lambda MicroVM | Launcher Lambda handles webhook but does not claim first | Launcher calls `RunMicrovm`; launched VM polls matching Session Work | Lambda MicroVM | SAM/CloudFormation reference stack | Embedded provider-native acquisition strategy |
| GKE Agent Sandbox | Dispatcher reserves Work with raw poll but does not ACK it | Dispatcher creates a Kubernetes `SandboxClaim` and dispatches to its bound warm pod | gVisor warm-pool pod owns first heartbeat/ACK | Kubernetes manifests/controller-facing reference | Embedded provider-dispatch strategy |
| Superserve | Long-running host poller | Host calls `AsyncSandbox.list/connect/create/resume/pause` | Superserve sandbox | Public SDK plus CMA guide | Embedded driver |

This matrix is the reason a single deployment-only Port is insufficient. For
Cloudflare, Vercel, Modal, Daytona, E2B, Sprites and Superserve, the code that
receives Work also calls the provider SDK at runtime. For AWS, the launcher is
webhook-driven and the VM subsequently claims matching Work. GKE additionally
has a warm-pool claim layer. The OpenMA kernel therefore needs pluggable Work
acquisition and sandbox lifecycle drivers rather than deployments of every
reference application.

## Provider findings

### Cloudflare

The [Cloudflare reference](https://github.com/cloudflare/claude-managed-agents/tree/22d60e7e297e8444a8a581496ce797ef9c49e674)
is a Workers-based control plane. Its
[`drainWork`](https://github.com/cloudflare/claude-managed-agents/blob/22d60e7e297e8444a8a581496ce797ef9c49e674/src/webhooks.ts)
polls Work and routes it to either the MicroVM sandbox or Isolate runner. The
MicroVM and Isolate are two sandbox backends, not two upstream control planes.
The Durable Objects and container bindings are Cloudflare implementation
details needed by those backends.

The MicroVM path restores before dispatch, snapshots around idle/lifecycle
boundaries and applies egress configuration before starting the container.
Cloudflare Sandbox SDK semantics also matter here: `getSandbox()` resolves a
stable logical sandbox handle, while compute starts lazily on first operation;
readiness therefore requires an explicit operation/probe rather than treating
handle acquisition as “running.”

When OpenMA itself runs as a Cloudflare Worker, this driver calls the configured
`DurableObjectNamespace` binding directly. A generic Node process cannot hold a
Workers binding directly. Cloudflare’s
[Sandbox bridge](https://developers.cloudflare.com/sandbox/bridge/) exposes the
Sandbox SDK through a self-deployed HTTP Worker, allowing the same OpenMA-owned
kernel to use a remote driver without deploying the CMA reference control plane.

### Blaxel

The [Blaxel reference](https://github.com/blaxel-ai/cma-blaxel-sandbox/tree/bb35bb42dd47d4e86f17284d912bd932e3ae789b)
uses an orchestrator sandbox that polls, recovers missed webhook work and calls
the Blaxel SDK. It implements bounded cold starts, duplicate process
suppression, worker-owned heartbeat handoff and terminal cleanup. This is the
best reference for failure scenarios, not a provider-neutral package.

### Daytona

The [Daytona reference](https://github.com/daytonaio/daytona/tree/5378d6d2238768e052fd83d9ac10b88b6b49a1ad/guides/python/claude/claude-managed-agents)
puts polling/webhook orchestration in a long-lived Python process. That process
directly performs get/create conflict recovery, labels ownership, checks runner
liveness and runs a janitor through the Daytona SDK. It can therefore be
embedded in an OpenMA-owned host or deployed as an external Worker.

### E2B

The [E2B reference](https://github.com/e2b-dev/e2b-cookbook/tree/1952c800623ef78198e36136ba8133c7f174fb24/examples/anthropic-managed-agents)
demonstrates three placements: direct worker sandbox, auto-resumable router
sandbox, and application-hosted webhook/poller. In the application shape, the
app drains Work and calls `Sandbox.connect/create`; in router shape, an E2B
sandbox owns that control loop. The example JSON assignment store is explicitly
not a transactional production authority and must not replace OpenMA fencing.

### Sprites, Vercel and Modal

- The [Sprites dispatcher](https://github.com/fly-apps/sprites-claude-managed-agents/tree/41948fb8450522e1848589c5ebe369eb4eb209dd/dispatch)
  calls `create_sprite`, relies on Service/Task lifecycle primitives, and starts
  a worker protected by `flock`.
- The [Vercel route](https://github.com/vercel-labs/cma-vercel-sandbox/blob/3d9c1487853d6e74d176088056b18130acd794a3/app/api/webhook/route.ts)
  polls/acks Work, then calls `Sandbox.create()` inside `waitUntil`; its firewall
  can inject CMA authorization without exposing the real credential.
- The [Modal webhook Function](https://github.com/modal-labs/claude-managed-agents-modal-sandbox/blob/91c550f9cb4bbf41f9471881cb039056b4c255d5/examples/cli/src/claude_webhook_handler.py)
  drains Work and calls named `modal.Sandbox` APIs, with a Volume optionally
  mounted at `/workspace`.

### AWS and GKE

The [AWS sample](https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents/tree/aff9237f387ec2c5debae0f08bba5c526fe6b9ed)
is an important exception: the webhook Lambda idempotently calls `RunMicrovm`,
then the launched VM polls for the matching Session Work. A generic “webhook
always wakes a poller that claims before launch” statement would be false.

The [GKE sample](https://github.com/GoogleCloudPlatform/kubernetes-engine-samples/tree/8708c6c6bd28dc5d8e3b642642e62115c049d6fd/ai-ml/anthropic-agent-sandbox)
has a dispatcher that raw-polls Work without ACK, creates a `SandboxClaim`, and
sends the Session/Work identity to a bound warm pod. The in-pod worker owns the
first heartbeat/ACK. Warm-pool capacity, claim reaping and pod dispatch are
provider runtime control-plane behavior implemented by the deployment.

### Superserve

The [Superserve guide](https://docs.superserve.ai/integrations/managed-agents/claude-managed-agents)
shows a host poller using SDK reconnect/create/resume/pause and liveness probes.
The provider SDK is reusable; the CMA glue is reference code.

## Lifecycle, persistence and egress comparison

| Provider | Identity/recovery | Workspace/output semantics | Egress/secret observation |
|---|---|---|---|
| Cloudflare | Stable Session-derived backend; restore barrier; activity expiry and destroy | MicroVM backup/restore to R2; Isolate uses its own workspace persistence | Transparent HTTPS interception and outbound handlers are first-class |
| Blaxel | Session sandbox plus recovery poller and duplicate suppression | Optional provider Volume | Native proxy/secret injection available |
| Daytona | Deterministic name, labels, prepared-state/PID probes, janitor | Retain/archive provider sandbox; durability depends on configured lifecycle | Native outbound proxy/firewall/secret broker |
| E2B | Named reconnect/create, pause/auto-resume, PID probes | Retained/paused sandbox or explicit snapshot; no universal POSIX mount | Reference commonly injects config; broker must be supplied separately |
| Sprites | Deterministic persistent Sprite, Service restart, Task activity hold | Ext4 filesystem backed by object storage; process memory is not cold-resume state | Network policy and Connectors |
| Vercel | Fresh sandbox per handled Work in reference | Snapshot is a base image, not Session workspace continuation | Deny-by-default firewall with path-scoped credential injection |
| Modal | Named sandbox plus idle timeout | Modal Volume at `/workspace` when configured | Network rules exist; CMA sample injects credential |
| AWS | Idempotent webhook launch; bounded VM lifetime | No general durable workspace protocol in sample | SSM reference resolved using execution identity; VPC controls |
| GKE | Warm-pool `SandboxClaim`, stale-claim reaper, bounded redispatch | Ephemeral workspace; output-only GCS FUSE mount | Default-deny NetworkPolicy/FQDN rules and Secret Manager |
| Superserve | Metadata reconnect, token-rotating activate, resume/pause and idempotent kill | Paused sandboxes retain running processes and files; auto-delete is disabled when omitted | Native deny/allow policy plus provider-side proxy tokens, host-scoped secret injection and request audit |

Provider capabilities must be reported explicitly. A Volume, retained runtime,
filesystem checkpoint, output collector and process-memory snapshot are not
equivalent. Likewise, `HTTP_PROXY` environment variables are advisory unless
the provider prevents bypass.

## What OpenMA should reuse

1. Reuse provider SDKs and mandatory provider-native components inside OpenMA’s
   embedded drivers.
2. Use pinned first-party control-plane source as lifecycle evidence, test
   oracle and a source of failure scenarios; OpenMA does not operate it.
3. Let users deploy any such reference through the external Worker protocol,
   without turning it into an OpenMA-maintained provider integration.
4. Never replace OpenMA’s Work/Event Log/fencing authority with a sample JSON
   map, process lock or provider-private routing database.
5. Keep external deployment outside the maintained runtime; embedded resource
   acquisition remains inside the Runtime Host composition.
6. Put provider-specific cleanup, restore, network enforcement and liveness in
   the provider binding, but require them through common capability contracts
   and conformance tests.

## Implemented OpenMA boundary

The resulting implementation keeps one Work control plane for both external
and embedded workers:

- Environment-scoped `oma_env_` service keys are Bearer-only,
  exact-Environment Work-only, rotatable by create/revoke, and never authorize
  Session resources;
- every claimed Work gets a separate claim-bound Session token;
- external workers can run the official-client-compatible destructive
  conformance probe without adopting OpenMA provider code;
- embedded providers pass through a common readiness/cleanup barrier before
  their handle is published;
- Cloudflare Workers use the direct binding composition, while Node may use the
  official self-deployed Sandbox Bridge through
  `createCloudflareBridgeManagedRuntime()`;
- the Bridge driver covers lifecycle, SSE execution, workspace file I/O,
  hashed tar checkpoint/hydrate and canonical output collection, but does not
  claim interactive stdin, process-memory recovery, provider leases or
  create-time deterministic identity.
- provider SDK adapters for Daytona, BoxLite/BoxRun, Blaxel, Sprites, Vercel,
  Modal and Superserve are isolated packages behind the same runtime resource
  Ports. Superserve uses provider-retained pause/resume, strict egress defaults,
  full-duplex commands and its native secret proxy without promoting pause
  state to a portable OpenMA checkpoint.
- Cloudflare and GKE raw-poll dispatchers are isolated behind
  `ManagedEnvironmentWorkDispatchPort`; AWS launch-before-poll is isolated
  behind `ManagedEnvironmentActivationPort` with durable SQL activation
  intents, lease generations, retry budgets and total deadlines.
- `createManagedEnvironmentWorkerInstallation()` selects Runtime Host,
  provider dispatch, provider activation, or protocol-only external Worker in
  one place and imports only the selected adapter package.

The Port shape is intentionally small, not artificially identical provider
configuration. Provider-specific fields remain inside `factoryOptions`: for
example GKE namespace/template/warm-pool values, Cloudflare backend bindings,
and AWS launcher/image/network identifiers. The common contract standardizes
ownership and lifecycle outcomes; it does not erase provider capabilities.

The last limitation creates a narrow remote-allocation leak window if the Node
host dies after Bridge `POST /v1/sandbox` but before the runtime ID is durably
recorded. Once the handle is published, normal fenced orphan reaping applies.
Direct Cloudflare binding uses a stable Session-derived identity and is the
stronger placement on Workers.

## Verification performed

The following immutable revisions were cloned and source-audited:

| Repository | Commit | Executed upstream tests |
|---|---|---|
| Cloudflare | `22d60e7e297e8444a8a581496ce797ef9c49e674` | 8 files, 152 tests passed |
| Blaxel | `bb35bb42dd47d4e86f17284d912bd932e3ae789b` | 161 tests passed |
| Sprites | `41948fb8450522e1848589c5ebe369eb4eb209dd` | 6 tests passed |
| Daytona | `5378d6d2238768e052fd83d9ac10b88b6b49a1ad` | No dedicated CMA failure suite found |
| E2B | `1952c800623ef78198e36136ba8133c7f174fb24` | CMA smoke workflows; no local transactional failure suite |
| Modal | `91c550f9cb4bbf41f9471881cb039056b4c255d5` | No dedicated CMA lifecycle suite found |
| Vercel | `3d9c1487853d6e74d176088056b18130acd794a3` | Credentialed scripts, not a unit failure suite |
| AWS | `aff9237f387ec2c5debae0f08bba5c526fe6b9ed` | Deployment verification scripts only |
| GKE | `8708c6c6bd28dc5d8e3b642642e62115c049d6fd` | Smoke/deployment scripts only |
| Superserve | `10a138ac9b7a5fa7c5d59f3d3b208a7640b83825` | Provider SDK tests; no dedicated CMA lifecycle suite |

Cloudflare’s audited application is marked `private`; it is not an npm adapter
package. Its dependency audit also reported vulnerabilities, so pinning and
reviewing the deployable artifact is preferable to silently vendoring it.

## Required common tests

Every supported binding mode must pass deterministic tests for duplicate and
lost webhooks, fallback polling, claim expiry, post-claim create failure,
launcher crash, runner crash, stale owner, credential revoke race, checkpoint
publish race, provider timeout and idempotent janitor cleanup. Credentialed
provider lanes then verify the actual network and persistence claims; fake SDKs
cannot certify those properties.
