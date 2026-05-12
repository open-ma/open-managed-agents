---
title: "Why we run on Cloudflare (and how to swap it out)"
description: "Workers + Containers + D1 + R2 = an agent platform with very little ops. The substitution guide for anyone who can't be on Cloudflare."
publishedAt: 2026-05-09
author: openma
tags: ["architecture", "cloudflare"]
---

Default openma deployment is Cloudflare. We pick this stack because it
gets us to "running" in minutes, not weeks:

- **Workers** for the API + Console (no servers to patch)
- **Durable Objects** for SessionDO (per-session state without a database round-trip)
- **Containers** for the sandbox (real Linux, not WASM)
- **D1** for relational state (auth, agents, sessions, ledger)
- **R2** for blobs (workspace snapshots, memory store bytes)
- **KV** for config

That's one cloud account, one `wrangler deploy`, and you're up.

## What if you can't be on Cloudflare

Some teams can't, for legit reasons:

- Compliance (data residency in a specific region not in CF's footprint)
- Cost ceiling on a specific workload
- Existing infra investment (already on AWS, want to stay)

For them: openma's `packages/services` is a backend abstraction layer. Each
"store" — `agents`, `sessions`, `vaults`, `memory`, etc. — has a `cf`
adapter (D1) and a `pg` adapter (Postgres). Choice is per-store via the
`STORE_BACKENDS` env var:

```
STORE_BACKENDS={"agents":"pg","sessions":"cf"}
```

You can move one store at a time. The harness, routes, and Console don't
change.

The sandbox layer has the same shape — `LocalSubprocess`, `LiteBox`,
`E2B`, `Daytona`, `BoxRun` are all swappable for the Cloudflare Sandbox.

## What's tightly coupled

Two things, currently:

1. **WebSockets for live event streams** — we use the Workers WS API. The
   abstraction layer doesn't yet have a generic WS port. Self-host
   deployments fall back to SSE.
2. **DurableObjects for SessionDO** — the per-session "actor" model is
   load-bearing. The Postgres + Node adapter simulates this with a
   row-level advisory lock + in-memory state, which works but isn't as
   tight as DO's strong-coordination model.

Both are on the roadmap to abstract.

## The point

We're Cloudflare-default, not Cloudflare-only. The OSS commitment is that
self-host stays first-class — same harness, same API, same Console. If
you're picking a cloud, just go with the easy path.
