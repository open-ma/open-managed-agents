# @open-managed-agents/acp-runtime

Spawn and drive [ACP](https://agentclientprotocol.com/)-compatible agents (Claude Code, Codex CLI, Gemini CLI, Hermes, …) from any host that can produce a `ChildHandle`.

The protocol layer is delegated to [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk). This package owns process lifecycle, restart policy, and the host-portability boundary (Node child_process vs. CF sandbox vs. Tauri vs. …).

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
     NodeSpawner                    CfSandboxSpawner
     (clash-bridge,                 (openma session DO,
      desktop, dev)                  multi-tenant cloud)
```

The `Spawner` boundary is the only host-specific contract. Everything above it (lifecycle, ACP protocol, session API) is host-agnostic and shipped from this package.

## Layout

```
src/
  index.ts            Public exports
  types.ts            Spawner / ChildHandle / AcpSession / SessionOptions / RestartPolicy
  runtime.ts          AcpRuntime impl — turns Spawner into session factory
  session.ts          AcpSession impl — wraps ClientSideConnection + lifecycle
  registry.ts         KNOWN_ACP_AGENTS catalog + detect()
  spawners/
    node.ts           NodeSpawner — child_process.spawn
    cf-sandbox.ts     CfSandboxSpawner — adapts openma's sandbox.exec
    types.ts          (re-export of Spawner from ../types)
```

The spawners are subpath exports so a host can pull only the implementation it needs without dragging the others' transitive deps (e.g. clash-bridge in pure Node never needs the cf-sandbox adapter).

## Status

Skeleton — interfaces and structure agreed. Implementation lands as separate PRs once the API surface settles.

## Usage sketch

### clash-bridge (local)

```ts
import { AcpRuntime } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { detect } from "@open-managed-agents/acp-runtime/registry";

const runtime: AcpRuntime = new AcpRuntime(new NodeSpawner());

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
import { AcpRuntime } from "@open-managed-agents/acp-runtime";
import { CfSandboxSpawner } from "@open-managed-agents/acp-runtime/cf-sandbox";

// Inside SessionDO, where `this.sandbox` is the existing openma sandbox handle.
const runtime = new AcpRuntime(new CfSandboxSpawner(this.sandbox));

const session = await runtime.start({
  agent: {
    command: "claude-code",
    args: ["--acp"],
    env: { ANTHROPIC_API_KEY: await this.vault.resolve("anthropic") },
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
- **stderr discipline**: `CfSandboxSpawner` currently merges stderr into the container log stream rather than exposing it. `NodeSpawner` exposes it directly. Sufficient for now but means downstream tooling that reads `stderr` for diagnostics behaves differently per host.
- **Multiple in-flight prompts**: ACP allows it; we currently serialize per session. Revisit once openma sub-agent multiplex needs it.

## Non-goals

- **Implementing the ACP protocol itself.** Use [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) directly if you don't need the spawner / lifecycle layer. We track its version closely.
- **Discovery of remote ACP servers.** This package is for local subprocess agents. Remote ACP-over-HTTP is a separate concern (clash uses CF Worker reverse-relay; openma uses HTTPS calls — neither fits in a "spawn a process" abstraction).
- **Pairing / auth.** clash-bridge handles its own pairing token flow because it's clash-product-specific. openma uses its existing vault. Both are above this layer.
