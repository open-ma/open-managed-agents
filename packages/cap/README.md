# cap — CLI Auth Protocol

A pure-data + pure-function library that codifies how common CLIs authenticate, and an enforcement runtime that turns `(spec, token, request)` into the right wire output for that CLI's protocol.

CAP is the missing layer between **vault systems** (HashiCorp Vault, OMA's vaults-store, 1Password, …) and **CLIs** (`gh`, `aws`, `kubectl`, `docker`, `git`, …). Vaults know how to store credentials; CLIs know how to use them. CAP knows how to translate.

> **Status**: First wave — L1 spec + L2 enforcement. L3 (consumer's resolver impl) and L4 (HTTPS proxy / metadata server / exec helper binary) are wired by consumers.

## Why

Vault injection for HTTPS-MITM is straightforward: match by hostname, inject `Authorization: Bearer …`. But many CLIs need more than a header — AWS reads from a metadata endpoint, kubectl spawns an exec credential plugin, docker calls a credential helper binary.

Without CAP, every consumer (OMA, your CI tool, your security daemon) reinvents the per-CLI knowledge: which endpoints does `aws` actually talk to, what JSON envelope does kubectl's exec credential plugin expect, what's the magic stdin terminator git's credential helper requires.

CAP encodes all of that once, declaratively, with a tiny runtime to apply it.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  L4  Adapter (consumer's, environment-specific)          │
│      - HTTPS proxy / mockttp daemon                      │
│      - Metadata server (sidecar / loopback alias)        │
│      - Exec helper binary (PATH-installed)               │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  L3  Resolver (consumer's, vault-specific)               │
│      implements `Resolver`: { resolve, invalidate, store}│
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  L2  Enforcement (this lib, shared)                      │
│      handleHttp / handleExec — orchestrators             │
│      modes: header / metadata-aws / metadata-gcp         │
│             / exec-kubectl / exec-docker / exec-git      │
│      oauth: device-flow builders + parsers               │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  L1  Spec (this lib, shared, pure data)                  │
│      builtinSpecs: 11 CLIs covering 3 inject modes       │
└──────────────────────────────────────────────────────────┘
```

The `Resolver` port is defined in L2 and **implemented** in L3 — dependency inversion, so CAP's core has zero knowledge of where credentials come from.

## What's in the box

**11 built-in CLI specs** covering three inject modes:

| CLI | Mode | OAuth device flow |
|---|---|---|
| gh | header | ✓ |
| glab | header | ✓ (register your own client_id) |
| fly | header | — |
| vercel | header | — |
| doctl | header | — |
| npm | header | — |
| aws | metadata_ep (Container Credentials) | — (use IAM/STS) |
| gcloud | metadata_ep (GCE metadata server) | ✓ |
| kubectl | exec_helper (client.authentication.k8s.io/v1) | — |
| docker | exec_helper (credential-helper protocol) | — |
| git | exec_helper (credential-helper protocol) | — |

## Install

CAP is currently distributed as source. From your project:

```sh
pnpm add file:../path/to/cap
```

## Usage — the 30-second tour

```ts
import {
  builtinSpecs,
  createSpecRegistry,
  handleHttp,
  type Resolver,
  type ResolveInput,
  type ResolvedToken,
} from "cap";

// 1. Implement Resolver against your vault.
class MyVaultResolver implements Resolver {
  async resolve(input: ResolveInput): Promise<ResolvedToken | null> {
    const row = await myVault.lookup(input.principal, input.cli_id, input.hostname);
    return row ? { token: row.token, expires_at: row.expires_at } : null;
  }
  async invalidate(input: ResolveInput): Promise<void> {
    await myVault.markStale(input.principal, input.cli_id, input.hostname);
  }
  async store(input: ResolveInput, token: ResolvedToken): Promise<void> {
    await myVault.upsert(input.principal, input.cli_id, input.hostname, token);
  }
}

// 2. Build the registry once.
const registry = createSpecRegistry(builtinSpecs);
const deps = {
  resolver: new MyVaultResolver(),
  registry,
  clock: { nowMs: () => Date.now() },
};

// 3. From your L4 adapter (e.g. inside an HTTPS proxy):
const result = await handleHttp(outboundReq, { principal: "user_42" }, deps);
switch (result.kind) {
  case "forward":     return fetch(result.req.url, { /* …rebuilt… */ });
  case "respond":     return new Response(result.res.body, { status: result.res.status });
  case "passthrough": return fetch(outboundReq);
}
```

For exec credential helpers (kubectl, docker, git), the L4 is a small wrapper binary that calls `handleExec(cli_id, ctx, {stdin, env, args}, deps)` and writes the result to stdout.

## OAuth device flow

For CLIs whose upstream supports the OAuth Device Authorization Grant (RFC 8628), CAP provides pure builders + parsers. The L4 driver:

```ts
import {
  buildDeviceInitiateRequest,
  parseDeviceInitiateResponse,
  buildDevicePollRequest,
  parseDevicePollResponse,
} from "cap";

const ghSpec = registry.byCliId("gh")!;

// 1. Initiate
const initRes = await fetch(buildDeviceInitiateRequest(ghSpec));
const state = parseDeviceInitiateResponse(ghSpec, await toResLike(initRes), clock);

// 2. Show the user
console.log(`Visit ${state.verification_uri} and enter ${state.user_code}`);

// 3. Poll
while (true) {
  await sleep(state.interval_seconds * 1000);
  const pollRes = await fetch(buildDevicePollRequest(ghSpec, state));
  const r = parseDevicePollResponse(ghSpec, await toResLike(pollRes), clock, state);
  if (r.kind === "ready") {
    await resolver.store(
      { principal: "user_42", cli_id: "gh", hostname: "api.github.com" },
      r.token,
    );
    break;
  }
  if (r.kind === "pending") continue;
  if (r.kind === "slow_down") { state.interval_seconds = r.new_interval_seconds; continue; }
  throw new Error(`device flow ${r.kind}`);
}
```

CAP doesn't fetch on its own — `check-no-io.mjs` enforces this — so the L4 driver owns sleep, fetch, and user interaction (terminal stdout, web console toast, Slack DM, whatever fits the environment).

## Bootstrap

Each CLI spec includes a `bootstrap` field describing the static scaffolding the L4 adapter should write once per sandbox/env so the CLI doesn't refuse to dial out at all:

- `bootstrap.env` — env vars to set in the CLI's process (always sentinels like `__cap_managed__`, never real tokens)
- `bootstrap.files` — config-file stubs (kubeconfig template, `~/.docker/config.json` fragment)

Real credentials live only in the vault and are pulled on-demand at request time.

## Design decisions worth knowing

- **AWS SigV4 punt** — `aws` is metadata_ep only. CAP never re-signs SigV4. The AWS SDK fetches temp creds from CAP's emulated Container Credentials endpoint, then signs upstream itself. Re-signing would force real keys into the proxy's address space and break SigV4 body-hash for streaming uploads.
- **Hostname matching** — exact match wins over wildcard; only `*.foo.bar` shape supported. No mid-segment globs.
- **Resolver-null per-mode reply** — header_inject returns `passthrough` (let CLI's own header reach upstream and surface a 401 the user can debug). metadata_ep returns 401. exec_helper returns the protocol-shaped failure (kubectl ExecCredential with `status.message`, docker `{}`, git `quit=1`).
- **No fs/network in src/** — enforced by `scripts/check-no-io.mjs`. All I/O via injected ports.
- **kubectl v1 only** — v1beta1 is deprecated since k8s 1.22 (2021).

## Develop

```sh
pnpm install
pnpm test                  # run the unit suite
pnpm test:watch            # watch mode
pnpm test:coverage         # run with coverage report
pnpm typecheck             # tsc --noEmit
pnpm check:no-io           # enforce purity in src/
pnpm smoke                 # end-to-end public-API smoke test
pnpm verify                # all of the above (typecheck + no-io + tests + smoke)
```

Tests are at `test/unit/**`; mirror the source layout (`test/unit/modes/header.test.ts`, etc).

Adding a new CLI:
1. Write `src/builtin/<cli>.ts` with a `CapSpec`
2. Append to `builtinSpecs` in `src/builtin/index.ts`
3. Add `test/unit/cli/<cli>.test.ts` with at least one happy-path integration assertion
4. `builtin-shape.test.ts` runs mode-generic invariant checks automatically

## Out of scope (for now)

- L3 OMA resolver adapter — separate package
- L4 wiring in OMA / other consumers — separate packages per environment
- OAuth Authorization Code with PKCE — device flow covers all current CLI use cases
- Spec override mechanism (per-tenant custom CLIs) — wait for real demand
- npm publication — currently source-only

## License

TBD.
