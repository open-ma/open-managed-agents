---
title: "The Architecture of Open Managed Agents: Durable Objects, R2, and the Brain/Sandbox Split"
description: "How Open Managed Agents is structured under the hood. Durable Objects with embedded SQLite as the per-session log, Cloudflare Containers as the sandbox, R2 for blobs, and the deliberate split between the brain (harness) and the body (sandbox)."
publishedAt: 2026-05-12
author: openma
tags: ["architecture", "cloudflare", "durable-objects", "design"]
---

The interesting thing about building an agent platform on Cloudflare in
2026 isn't the model layer — that's a commodity API call. It's the
question of where the **session state** lives, where the **code
execution** happens, and how the two stay coordinated when a process
dies mid-step.

This post walks through the architecture decisions in
[Open Managed Agents](https://github.com/open-ma/open-managed-agents).
The mental model that ties it all together: a clean split between the
**brain** (the harness — stateless code that calls the model) and the
**body** (the sandbox — a real Linux process the agent can drive).
Everything else is in service of that split.

## The brain/sandbox split

An agent loop is two things, and they're easier to reason about
separately:

1. **The brain.** A function that reads recent events, decides what to
   send the model, makes the API call, parses the response, decides
   what to do with any tool calls. Pure CPU and network. No persistent
   state of its own.

2. **The body.** A long-lived environment where the agent can write
   files, run commands, install packages, save snapshots. Real
   filesystem, real processes. State that must survive across the
   brain's individual decisions.

In Open Managed Agents these are physically separate:

```
┌─────────────────────────────────────────────────────────┐
│  Brain — apps/agent SessionDO + harness function        │
│  Stateless. Crash → rebuild from event log → resume.    │
│  Lives in a Worker, runs for the duration of one step.  │
└────────────────────┬────────────────────────────────────┘
                     │ container_runtime.exec()
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Body — Cloudflare Container per session                │
│  Stateful filesystem. Long-lived (warm-pooled).         │
│  Snapshots to R2 on session end.                        │
└─────────────────────────────────────────────────────────┘
```

The brain can crash and resume — its state lives in the event log, not
in memory. The body holds filesystem state that's expensive to rebuild,
so it's pooled and snapshotted, not recreated every step.

This split is why crash recovery is straightforward and why custom
harnesses are easy to ship: there's no hidden in-memory state to
preserve when you swap one harness function for another.

## SessionDO: per-session Durable Object

Each session in Open Managed Agents is a **Durable Object** — a
Cloudflare primitive that gives you a single-instance, strongly
consistent worker associated with a specific id. The id is the session
id, so there's exactly one DO per session, exactly one place handling
its events, exactly one writer to its event log.

The DO embeds a SQLite database (Durable Objects gained this in 2024).
The schema is small:

```sql
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL  -- JSON
);

CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

That's it. Every input (user message, tool result) and every output
(agent message, tool call, sandbox command) is appended as an event.
The `state` table holds derived state (current step, sandbox handle,
last cache breakpoint) that can be rebuilt from events but is faster to
look up directly.

Why a DO instead of a row in D1?

- **Strong consistency without a transaction.** A session always has
  exactly one writer, so two concurrent harness invocations can't race.
- **Co-located storage.** SQLite lives in the same DO; no network hop
  to read recent events. A typical step reads the last ~50 events; that
  read is microseconds, not milliseconds.
- **Cheap WebSocket fan-out.** The DO is the natural place to broadcast
  events to subscribed clients (the Console, your own dashboards, the
  test harness). It already owns the writes.

The DO model has limits — per-DO throughput, storage caps — but for
agent sessions those limits are far above what one session needs. A
session doing one step a second for an hour is well under any DO
threshold.

## The event log as source of truth

This is the load-bearing decision that makes everything else simple.

**The harness is stateless.** It takes the session's event log as
input, returns events as output. If the worker crashes mid-step, the
DO restarts, reads the event log, replays it through the harness, and
the harness rebuilds context as if nothing happened.

```ts
async function step(events: Event[]): Promise<Event[]> {
  const context = buildContext(events);          // pure function
  const response = await model.call(context);    // network call
  return parseResponse(response);                 // pure function
}
```

In practice the function is a bit more nuanced — it has to handle
streaming, partial tool calls, sandbox interactions — but the contract
holds. Same input, same output. No hidden state.

The two implications:

1. **Custom harnesses are trivial to swap.** Any function with the
   same `(events) → events` shape works. You can A/B-test harnesses on
   different sessions, ship a new caching strategy without coordinating
   a deploy across services, or fork the default for a custom domain.

2. **Crash recovery is just retry.** No checkpointing, no snapshot of
   in-flight model state, no fancy WAL. The event log was already the
   thing being persisted; replay just works.

The cost: every harness invocation rebuilds context from scratch. For
a session with hundreds of events that's not free. The default harness
addresses this with explicit prompt caching breakpoints and
periodic compaction, both of which are themselves recorded as events
(so they're idempotent across replays).

## Cloudflare Containers for the sandbox

The sandbox is where the agent actually runs code. A few constraints
shape the implementation:

- It needs to be a real Linux environment. WASM is too restrictive for
  the typical agent workload (running pip-installed packages, shelling
  out to git, writing to a real filesystem).
- It needs to be isolated. Each session gets its own filesystem; one
  session's code can't read another's.
- It needs to be fast to start. Cold-start latency dominates the
  perceived agent step time at low session counts.

**Cloudflare Containers** matches the constraints. Each session gets
a container; the container's filesystem persists for the session's
lifetime; cold start is in the low seconds. The agent worker holds a
handle to the container and `exec`s commands into it.

The sandbox API is small:

```ts
interface Sandbox {
  start(image: string): Promise<void>;
  exec(cmd: string, opts?: { timeout?: number }): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  snapshot(): Promise<string>;  // returns R2 key
  stop(): Promise<void>;
}
```

The same interface is implemented by `LocalSubprocess` (no isolation,
for dev), `LiteBox` (lightweight container), `E2B`, `Daytona`,
`BoxRun`. Picking a different sandbox is an env-var change. Harness
code never knows which one it's talking to.

## R2 for the slow tier

The hot tier is the DO event log. The slow tier is R2. Two things
end up there:

1. **Workspace snapshots.** When a session completes (or hits a
   snapshot trigger — every N events, or every M minutes), the
   sandbox takes a tarball of `/workspace` and writes it to R2.
   Reload from snapshot is the recovery path if a sandbox dies between
   sessions.
2. **Memory-store blobs.** The semantic memory layer chunks documents
   and stores embeddings + raw text in R2. Vector search runs against
   a separate index (D1 + a vector DB adapter); the actual chunk
   bytes live in R2.

R2 is appealing here because it's egress-free across Workers. The
snapshot path doesn't pay for cross-region transit; the memory chunks
read from R2 hit the same DC as the worker that needs them.

## D1 for the control plane

D1 holds the relational state that's *not* per-session:

- The agent definitions catalog (`agents` table).
- The environment specs (`environments` table).
- The session index (`sessions` table — small row per session, the
  full event log is in the DO).
- Vault metadata (the encrypted blob is in KV, the row in D1 indexes
  it).
- Ledger entries for billing (sandbox-minutes per session).

D1 is read-mostly here. Writes happen on session creation and
completion, not per-step. The per-step hot path is entirely in the DO.

## How the pieces talk

```
       client
         │
         │  /v1/sessions, /v1/events, …
         ▼
   ┌───────────┐
   │ openma-   │   service binding
   │   main    │ ───────────────────┐
   │ (Worker)  │                    ▼
   └─┬───┬───┬─┘            ┌───────────────┐
     │   │   │              │  openma-agent │
     │   │   │              │   (Worker)    │
     │   │   │              │  ┌──────────┐ │
     │   │   │              │  │SessionDO │ │
     │   │   │              │  │ + SQLite │ │
     │   │   │              │  └──────────┘ │
     │   │   │              └─┬─────────────┘
     │   │   │                │ container_runtime
     │   │   │                ▼
     │   │   │          ┌───────────────┐
     │   │   │          │ CF Container  │
     │   │   │          │   (sandbox)   │
     │   │   │          └───────────────┘
     ▼   ▼   ▼
    KV   D1   R2
  (vault) (control) (blobs)
```

`openma-main` is the public API surface. `openma-agent` is where the
SessionDOs live and where harness code runs. Each session's DO holds
its own event log; each DO has its own container handle. Storage
bindings (KV, D1, R2) are shared across both Workers.

The split between main and agent matters for two reasons:

1. **Different placement strategies.** Main is a stateless edge worker
   that benefits from Workers Smart Placement. Agent is DO-bound; it
   runs where the DO lives.
2. **Different scaling characteristics.** Main scales with request
   volume. Agent scales with concurrent active sessions. They have
   different cost shapes; running them as separate Workers makes the
   bill legible.

## What this design buys you

- **Crash anywhere, recover from event log.** The brain has no in-memory
  state worth losing.
- **Swap any layer.** Sandbox runtime, harness function, storage backend
  — each is behind an interface. The default works; you replace the
  ones that don't.
- **Multi-tenant by construction.** Per-session DOs and per-tenant
  vaults make isolation a property of the data model, not an audit
  exercise.
- **Cloudflare-native, not Cloudflare-only.** Each Cloudflare-specific
  piece (DO, R2, D1, Containers) has a non-Cloudflare adapter. The
  Postgres + Node deployment uses the same harness, same API, same
  Console — see [the self-host
  guide](/blog/self-host-agent-platform-cloudflare-workers/) for the
  Cloudflare path or the repo's `docker-compose.postgres.yml` for the
  Node path.

## What it doesn't buy you

- **Sub-millisecond first-token latency.** There's a DO hop on the
  request path. Hosted latency is typically within ~50ms of the
  upstream model; for most agent workloads that's invisible.
- **Multi-region session migration.** A DO is pinned to a region. If
  the user moves continents mid-session, the routing follows the DO.
  This is fine for most workloads; some teams have specific
  requirements that need a different design.
- **Trivial Python-only deployment.** Open Managed Agents is
  TypeScript-first. There are language-agnostic clients (the API is
  HTTP), but the harness itself is TS.

## The deliberate parts

The architecture has a handful of choices that look like accidents but
are deliberate:

- **Stateless harness.** Could have stored intermediate model state in
  the DO. The replay-from-events model is more robust and made
  custom harnesses ergonomic.
- **DO per session, not per user.** Could have made the user the unit
  of strong consistency. The session boundary maps to the lifecycle
  better; each session is independently failover-able.
- **Separate Workers for main and agent.** Could have been one Worker.
  The split made the bill legible and let each scale independently.
- **R2 for snapshots and blobs.** Could have used DO storage. R2 is
  cheaper, supports object versioning, and doesn't count against DO
  storage quotas.

If you'd like the side-by-side comparison with Anthropic's hosted
Managed Agents, the [technical
comparison](/blog/anthropic-managed-agents-vs-open-managed-agents/)
post goes through the architectural differences in detail. If you want
to migrate from the closed product, [the migration
guide](/blog/migrate-from-anthropic-managed-agents/) walks through the
practical steps.

## Try it

```bash
# Self-host on Cloudflare
git clone https://github.com/open-ma/open-managed-agents
cd open-managed-agents
pnpm install
npx wrangler login
npx wrangler kv namespace create CONFIG_KV
npx wrangler r2 bucket create openma-blobs
npx wrangler d1 create openma-control
# update wrangler.jsonc with the printed ids, then:
npx wrangler deploy -c apps/main/wrangler.jsonc
npx wrangler deploy -c apps/agent/wrangler.jsonc
```

The full deployment guide is in [the self-host
post](/blog/self-host-agent-platform-cloudflare-workers/). The
architecture above is what you get.
