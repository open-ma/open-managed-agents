# ADR 0007: Fenced credential egress for managed runtimes

**Status**: Accepted (2026-09-06)
**Deciders**: Engineering
**Supersedes**: the tenant-global self-host `oma-vault` lookup described in
[`mcp-credential-architecture.md`](../mcp-credential-architecture.md)
**Related**: [`0005-self-hosted-worker-runtime-resources.md`](0005-self-hosted-worker-runtime-resources.md),
[`0006-session-execution-authority.md`](0006-session-execution-authority.md)

---

## Context

The Claude Managed Agents self-hosted Environment Worker protocol assigns
work, carries a short-lived per-work Session credential, and accepts lifecycle
and Session operations. It deliberately does not standardize the worker's
sandbox provider, firewall, transparent proxy, or arbitrary credential
injection. A community Environment Worker can therefore run unchanged without
an OpenMA networking extension.

OpenMA has an additional requirement. It runs native coding agents and tools
inside mutually untrusted sandboxes while credentials remain in an OpenMA
Vault. A prompt-injected process must be able to use an approved credential for
an approved destination without reading the plaintext, replaying it from a
different Session, or bypassing the injector through a direct connection.

The legacy implementations do not meet that requirement consistently:

- Cloudflare's Sandbox outbound handler performs live Session-scoped lookup,
  but the new `ManagedRuntimeHost` never binds it. Lookup errors also fall back
  to direct egress.
- The Node `oma-vault` proxy matches the first credential for a hostname. Its
  optional tenant filter is process-global and it does not enforce the
  Session's `vault_ids`.
- Local subprocess, E2B, Daytona, LiteBox, and BoxRun adapters only publish
  `HTTP_PROXY`/`HTTPS_PROXY` and a CA path. A client can ignore those variables.
- The runtime resource fence does not currently gate credential use, so a
  stale sandbox may keep using Vault authority after its work generation is
  replaced.

The providers expose materially different wire points. Treating them all as a
boolean `supportsProxy` would overstate security:

| Provider | Strongest available wire point | Important boundary |
|---|---|---|
| Cloudflare Sandbox | host-enforced transparent HTTP/HTTPS handler plus deny-by-default Internet policy | only ports 80/443 are intercepted; disabling Internet is required to block other protocols |
| E2B Cloud/BYOC | host-enforced allow/deny, HTTP header transforms, and a fail-closed SOCKS5 TCP egress proxy | UDP/DNS/QUIC are not tunneled; open-source E2B infra does not expose the hosted egress proxy |
| Daytona | network/domain allowlist plus provider Secrets placeholder substitution | `outboundProxyUrl` alone is not a security boundary; provider Secrets are organization resources |
| BoxLite | VM-level allowlist plus host-side HTTPS secret substitution | provider receives secret material; only supported HTTPS traffic is substituted |
| BoxRun | BoxLite REST control plane, but the OpenMA adapter does not expose its current network/secret create shape | must fail closed until the deployed BoxRun API proves those capabilities |
| Node/Docker | isolated Docker network with a dual-homed egress sidecar or host netns policy | ordinary proxy environment variables are advisory and bypassable |
| Local subprocess | no isolation boundary | local trusted-debug only; never claim enforced Vault egress |

## Decision

### Preserve the official protocol exactly

OpenMA will not add Vault, proxy, provider, fence, or network fields to
`BetaSelfHostedWork`, `Environment.config`, webhook events, or any other Claude
Managed Agents shape. An unmodified official/community worker remains usable.

Credential egress is a private Runtime Host resource transaction. It begins
only after the official work claim (or an OpenMA-native execution claim) has
been acquired.

### Add a narrow `CredentialEgressPort`

The Runtime Host composes a fifth independent Port:

```ts
interface CredentialEgressPort {
  capabilities(scope): Promise<CredentialEgressCapabilities>;
  prepare({ scope, fence, requirement, idempotencyKey, signal })
    : Promise<CredentialEgressBinding | null>;
  attach({ scope, fence, binding, sandbox, signal }): Promise<void>;
  revoke({ scope, fence, binding, reason }): Promise<void>;
  release({ scope, fence, binding }): Promise<void>;
}
```

`CredentialEgressBinding` is transient and contains only an opaque binding ID
and declared enforcement metadata. It is never written into sandbox lease
metadata, workspace checkpoints, output manifests, logs, or the Managed Agents
wire protocol. Provider adapters and the Port may share a private in-process
registry keyed by that ID for creation-time configuration. Plaintext Vault
credentials are never members of the portable contract.

A runtime profile declares one of:

- `required`: the harness must not start unless the provider proves a
  deny-by-default, non-bypassable route for supported traffic;
- `best_effort`: allow an advisory proxy for trusted local debugging, but label
  it accurately;
- `disabled`: do not prepare a Vault egress binding.

Absence of the Port is equivalent to unsupported, never silently supported.
The default for profiles that predate this ADR is `disabled`, preserving
official worker compatibility. OpenMA-created profiles with attached Vaults
must explicitly request `required`.

### Fence every egress grant

An egress grant is scoped to the complete runtime identity:

```text
(workspaceId, environmentId, sessionId, workId, fence generation)
```

It authorizes only the current Session's active `vault_ids` and only the hosts
declared by those credentials. A central proxy validates the active generation
on every request (or against a bounded cache whose TTL is shorter than the
resource lease). Provider-native secret substitution receives a per-runtime
snapshot and must be revoked or the runtime must be destroyed on lease loss;
it cannot claim live-rotation semantics unless the provider supports an atomic
update.

The sandbox may hold a short-lived egress capability or harmless provider
placeholder. That value is not an upstream credential. Copying it to another
Session, runtime, host, or generation must fail.

### Lifecycle order

The normative transaction is:

```text
claim work / acquire runtime fence
  -> materialize workspace and outputs
  -> prepare egress binding
  -> acquire or restore sandbox using the opaque binding
  -> attach/verify provider wire point
  -> start harness
  -> revoke egress on completion, failure, cancellation, or fence loss
  -> stop/suspend sandbox
  -> release egress binding and other resources
```

`prepare` must happen before sandbox acquisition because E2B, Daytona,
BoxLite, BoxRun, and Docker may require creation-time network policy. `attach`
must finish before the first harness instruction. On lease loss, authorization
is rejected by generation validation before best-effort process termination;
this is the credential-side split-brain fence.

If egress revocation fails, cleanup records an orphan and the old generation
remains rejected by the authoritative fence. Revocation success is not used as
proof of ownership.

### Separate data-plane classes

Vault egress does not absorb all sandbox networking:

- **Vault destinations**: proxy/substitution injects credentials and strips any
  sandbox-supplied competing credential header.
- **Model gateway and Managed Agents control plane**: separate Layer-A routes;
  they are allowlisted but do not resolve Session Vault entries.
- **Public build/package destinations**: deployment policy may allow them
  without credential injection.
- **All other destinations and non-intercepted protocols**: denied when the
  profile requires enforced egress.

This distinction prevents a Session Vault entry from becoming a general
Internet tunnel and avoids treating the model endpoint credential as an MCP or
tool credential.

For an official self-hosted Work, the existing `sessions_token` is also the
HTTP MCP gateway capability. The sandbox sends it only to the exact configured
OpenMA origin and only in `Authorization`. The API decrypts its workspace,
environment, Session, Work, issue/expiry and claim fields, verifies exact token
equality against the current stored claim and heartbeat TTL, then resolves the
Session/server/Vault binding. Reclaim rotates the token. The Cloudflare
provider binds the control-plane origin to a dedicated per-host handler because
the catch-all Vault handler deliberately strips sandbox `Authorization`.

This capability is readable by the in-sandbox worker and therefore may be
stolen from a compromised active sandbox. Its safety comes from narrow API
scope and immediate claim fencing, not secrecy. It never authorizes Vault reads
or becomes the upstream MCP header; the gateway replaces it. Deployments still
need rate limits and should keep heartbeat TTLs short.

## Provider mapping

Adapters report one of three enforcement levels:

| Level | Meaning | Valid for `required` |
|---|---|---|
| `enforced` | provider/host prevents direct bypass for the declared traffic class | yes |
| `advisory` | proxy variables or cooperative client configuration only | no |
| `unsupported` | no tested wire point | no |

Initial mappings:

- **Cloudflare**: `enforced` after the global outbound handler is installed,
  Internet is deny-by-default, and fence-aware Session lookup is verified.
- **Node/Docker**: `enforced` only with a managed isolated network and egress
  gateway. A user-supplied normal Docker network is not sufficient.
- **E2B**: `enforced` only in hosted/BYOC configurations using host-enforced
  network policy plus either provider transforms or a configured egress
  gateway. Open-source deployments without that feature are `advisory` or
  `unsupported`.
- **Daytona**: `enforced` with a strict domain allowlist and provider Secrets,
  or with an allowlist that makes an OpenMA gateway the only reachable egress.
- **BoxLite**: `enforced` with `network.allowNet` and provider-side `secrets`.
- **BoxRun**: `unsupported` until the runtime API capability handshake confirms
  equivalent fields and OpenMA passes conformance tests.
- **Local subprocess**: always `advisory` and local-debug only.

Provider-native substitution is a trust choice: the provider control plane may
receive plaintext during configuration even though the sandbox does not. A
deployment that requires OpenMA-only custody must select a forced central
gateway mode instead.

## Failure semantics

- Missing CA, gateway, provider rule, Session, Vault binding, or active fence
  is a hard startup failure for `required`.
- A Vault lookup failure for an approved credential-bearing destination is
  denied, never passed through without authentication.
- No matching credential does not automatically mean unrestricted Internet;
  the separate public-egress allowlist decides whether anonymous access is
  allowed.
- A credential host collision across tenants is impossible because lookup is
  first constrained by workspace/tenant and Session `vault_ids`.
- Reclaim rotates generation. The old runtime's next request is rejected even
  if it has not yet observed heartbeat failure.
- Logs contain binding IDs, scope hashes, host, decision, status, generation,
  and latency. They never contain proxy capability values, upstream headers,
  request bodies, or credentials.

## Verification

Every provider claiming `enforced` must pass the same conformance and chaos
matrix:

1. approved host receives the correct Session credential;
2. same hostname in another tenant/Session never receives it;
3. unbound Vault and arbitrary host are denied according to policy;
4. client ignores proxy variables and direct connect still fails;
5. stale generation is rejected before sandbox termination completes;
6. proxy/control-plane outage fails closed;
7. credential rotation behavior matches the declared live/snapshot capability;
8. bindings, checkpoints, process identity, and logs contain no credential or
   egress-capability value;
9. IPv4, IPv6, DNS, UDP, QUIC, alternate ports, redirects, and CONNECT are
   either covered or explicitly denied;
10. restored/retained runtimes cannot reuse a prior generation's grant.

Docker provides the deterministic local conformance lane. Credentialed cloud
lanes are opt-in release gates because hosted provider enforcement cannot be
faithfully emulated by a lightweight fake.

## Consequences

OpenMA gains a uniform policy and lifecycle contract without pretending that
all provider network implementations are equivalent. The official Managed
Agents ecosystem stays reusable because its public shapes and worker process
remain unchanged.

The cost is an additional deployment component for providers without native
substitution, stricter startup failures, and provider-specific adapters below
the Port. That complexity is intentional: a bypassable environment-variable
proxy is useful for debugging but cannot be represented as a Vault security
boundary.
