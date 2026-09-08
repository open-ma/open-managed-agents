# @open-managed-agents/acp-runtime

Spawn and drive [ACP](https://agentclientprotocol.com/)-compatible agents (Claude Code, Codex CLI, Gemini CLI, Hermes, …) from any host that can produce a `ChildHandle`.

The product-neutral protocol/session/process core lives in
`@openma/common/acp-runtime`. This workspace package is intentionally a thin
compatibility wrapper: it re-exports that exact implementation and keeps the
OpenManaged-only agent registry beside it.

## Why

Two unrelated systems in this monorepo need the same capability:

1. **clash-bridge** (clash repo) — runs locally on a user's machine, spawns an ACP agent for the user's BYO chat session, relays JSON-RPC over a reverse WebSocket back to clash's web UI.
2. **openma session DO** — spawns an ACP agent (e.g. Claude Code) inside its sandbox container and uses the agent's reasoning loop in place of openma's own default loop. Lets openma "outsource" agent runtime to a battle-tested implementation.

Both want: `spec → live process → typed conversation → clean shutdown`. This package is that.

## Layers

```
            ┌──────────────────────────────────────────┐
            │           AcpSession                     │
            │   prompt() / provideToolResult() / ...   │
            └────────────────┬─────────────────────────┘
                             │ uses
                             ▼
            ┌──────────────────────────────────────────┐
            │   ClientSideConnection                   │
            │   from @agentclientprotocol/sdk          │
            │   (JSON-RPC framing, request/notify)     │
            └────────────────┬─────────────────────────┘
                             │ reads/writes
                             ▼
            ┌──────────────────────────────────────────┐
            │           ChildHandle                    │
            │   { stdin, stdout, stderr, kill,         │
            │     exited }                             │
            └────────────────┬─────────────────────────┘
                             │ produced by
                             ▼
            ┌──────────────────────────────────────────┐
            │           Spawner                        │
            │   spawn(AgentSpec): Promise<ChildHandle> │
            └──────────────────────────────────────────┘
                             ▲
                             │ implementations
              ┌──────────────┴───────────────┐
              ▼                              ▼
     NodeSpawner                    SandboxSpawner
     (clash-bridge,                 (any sandbox exposing
      desktop, dev)                  live duplex stdio)
```

The `Spawner` boundary is the only host-specific contract. Everything above it
(lifecycle, ACP protocol, session API) is host-agnostic and shipped from
`openma-common`, so Backchat and OpenManaged cannot drift independently.

## Layout

```
src/
  index.ts            Public exports
  types.ts            Spawner / ChildHandle / AcpSession / SessionOptions / RestartPolicy
  runtime.ts          Thin re-export from @openma/common/acp-runtime
  session.ts          Thin re-export from @openma/common/acp-runtime
  placement.ts        Composition helper for local vs sandbox placement
  sandbox-agent.ts    Per-agent prepare/state plan; Harbor informs artifact paths
  registry.ts         KNOWN_ACP_AGENTS catalog + detect()
  spawners/
    node.ts           Thin re-export of the shared NodeSpawner
    sandbox.ts        SandboxSpawner — adapts SandboxDuplexProcessPort
```

The spawners are subpath exports so a host can pull only the implementation it
needs. A sandbox host must explicitly provide the live-stdio capability; a
command/log-polling sandbox cannot be composed with ACP by accident.

## Harness-in-sandbox preparation

`./sandbox-agent` is the adapter boundary for installed coding agents. It
does not replace ACP or start a process itself. `prepareAcpSandboxAgent()`
selects the Harbor-derived native-session profile, returns the isolated launch
environment and the exact session artifact manifest, and declares the
lifecycle policy used by the host:

```ts
import {
  materializeAcpSandboxAgentState,
  prepareAcpSandboxAgent,
} from "@open-managed-agents/acp-runtime/sandbox-agent";

const preparation = prepareAcpSandboxAgent({
  sessionId,
  agent: { id: "pi-acp", command: "pi-acp" },
});

await materializeAcpSandboxAgentState(sandbox, preparation);
// ACP runtime starts preparation.launch and owns initialize/resume/prompt.
// preparation.lifecycle is retain on shutdown/crash, delete on destroy.
```

Unknown agents deliberately produce an `opaque` ACP-only plan. The host can
still run them through ACP and canonical-event recovery, but must not claim
native resume. Credentials and model endpoints are supplied by the host/vault
composition; they are never inferred from or persisted as native session
artifacts.

The lifecycle helpers consume only `AcpSandboxAgentStatePort` (`writeFile` and
`exec`). Cloudflare Sandbox, Docker, E2B-compatible providers, and test fakes
all implement this narrow Port structurally; the ACP package never imports a
provider SDK. The live native root is ephemeral under `/tmp`; capture copies
only the declared Session artifacts into
`/workspace/.openma/harness-state/`. Harbor supplies useful path knowledge,
not OpenMA's durability semantics.

For a complete whole-brain in-sandbox loop, compose this package with
`@open-managed-agents/harness-runtime-acp`. That package owns command dispatch,
checkpoint-before-completion ordering, restore-before-resume, canonical-event
semantic recovery, and the supervisor lifecycle. The outer Runtime Host owns
durable candidate publication and fencing.

## Status

Active. Backchat and OpenManaged now instantiate the same `AcpRuntimeImpl` and
`AcpSessionImpl`; placement only selects `NodeSpawner` or `SandboxSpawner`.

## Usage sketch

### clash-bridge (local)

```ts
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { detect } from "@open-managed-agents/acp-runtime/registry";

const runtime = createAcpRuntime({
  type: "local",
  spawner: new NodeSpawner(),
});

// User picked "Claude Code" from clash chat dropdown
const agent = await detect("claude-agent-acp");
if (!agent) throw new Error("claude-code not installed locally");

const session = await runtime.start({
  agent,
  restart: { mode: "on-crash", maxRestarts: 3, windowMs: 60_000 },
  idleTimeoutMs: 30 * 60_000,
});

for await (const event of session.prompt(userMessage)) {
  relayToCloud(event); // forward over reverse-WS to clash Worker
}
```

### openma session DO (cloud)

```ts
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { supportsDuplexProcess } from "@open-managed-agents/sandbox";

// Inside SessionDO, where `this.sandbox` is the existing openma sandbox handle.
if (!supportsDuplexProcess(this.sandbox)) {
  throw new Error("selected sandbox cannot host an ACP process");
}
const runtime = createAcpRuntime({ type: "sandbox", sandbox: this.sandbox });

const session = await runtime.start({
  agent: {
    command: "claude-code",
    args: ["--acp"],
    // Provider credentials stay on the host and are injected by the
    // sandbox outbound proxy; do not copy raw vault values into env.
  },
  restart: { mode: "on-crash" },
  perTurnTimeoutMs: 5 * 60_000,
});

for await (const event of session.prompt(userMessage)) {
  await this.eventLog.append(event);
  this.broadcast(event);
}
```

## Open questions

- **Tool-result return path under restart**: if a child crashes between `tools/request` and `provideToolResult`, the new child has no memory of the request. ACP itself doesn't support "resume mid-tool" — caller will need to surface this as a turn failure. Considering an explicit `restartLost` event so the host can handle gracefully.
- **Remote duplex support**: ACP composition deliberately requires
  `SandboxDuplexProcessPort`. Remote adapters that only expose command/log
  polling cannot be used until they implement live stdin/stdout/stderr.
- **Multiple in-flight prompts**: ACP allows it; we currently serialize per session. Revisit once openma sub-agent multiplex needs it.

## Non-goals

- **Implementing the ACP protocol itself.** Use [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) directly if you don't need the spawner / lifecycle layer. We track its version closely.
- **Discovery of remote ACP servers.** This package is for local subprocess agents. Remote ACP-over-HTTP is a separate concern (clash uses CF Worker reverse-relay; openma uses HTTPS calls — neither fits in a "spawn a process" abstraction).
- **Pairing / auth.** clash-bridge handles its own pairing token flow because it's clash-product-specific. openma uses its existing vault. Both are above this layer.
