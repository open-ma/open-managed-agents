---
title: "Anthropic Managed Agents vs Open Managed Agents: A Technical Comparison"
description: "Side-by-side technical comparison of Anthropic's Managed Agents and the open-source Open Managed Agents project. API surface, runtime model, sandbox, billing, and where each one actually fits."
publishedAt: 2026-05-09
author: openma
tags: ["comparison", "anthropic", "managed-agents", "architecture"]
---

If you're shopping for an agent platform that handles the boring parts —
sessions, sandboxes, tool dispatch, crash recovery — there are now two
serious options that look almost the same on the outside: **Anthropic's
Managed Agents** (proprietary, hosted-only) and **Open Managed Agents**
(Apache 2.0, self-hostable). Both expose `/v1/agents` and `/v1/sessions`,
both stream events back over SSE, both run code in an isolated sandbox.
What differs is what's underneath, who owns the runtime, and how the bill
looks at the end of the month.

This post walks through the technical differences in the order you'd hit
them while wiring up an integration.

## API surface

The shape is the same on purpose.

Both expose four resources:

| Resource | Purpose |
|---|---|
| `/v1/agents` | Definition of an agent — name, model, system prompt, tools |
| `/v1/environments` | Sandbox spec — base image, packages, env vars |
| `/v1/sessions` | A running invocation — agent + environment + event log |
| `/v1/sessions/{id}/events` | The event log — append messages, stream output |

Request/response bodies match field-by-field. The SSE event types
(`agent.message`, `tool.call`, `tool.result`, `session.completed`) are
identical. **If your client code already speaks Anthropic's Managed
Agents, switching to Open Managed Agents is a base-URL swap.**

```diff
- const client = new Anthropic({ baseURL: "https://api.anthropic.com" });
+ const client = new Anthropic({ baseURL: "https://openma.dev" });
```

Or, self-hosted:

```diff
- const client = new Anthropic({ baseURL: "https://api.anthropic.com" });
+ const client = new Anthropic({ baseURL: "http://localhost:8787" });
```

This isn't a coincidence — keeping the surfaces parallel is an explicit
design rule. When the upstream API gets a new field, the open
implementation aims to ship it in the same release window.

## Runtime model: who owns the loop

This is the biggest structural difference.

**Anthropic's Managed Agents** owns the agent loop end-to-end. You define
an agent, hit `/sessions`, send a message, and watch events stream back.
The decisions inside the loop — how to engineer the context window, when
to trigger prompt caching, when to compact, how to retry a failed tool
call — are made by Anthropic's harness, which you don't see and can't
modify.

**Open Managed Agents** splits this in two:

```
┌─────────────────────────────────────────────────────────┐
│  Harness (the brain — your code or the default)         │
│  - Reads events, builds context, calls the model        │
│  - Decides HOW: caching, compaction, tool delivery      │
│  - Stateless: crash → rebuild from event log → resume   │
├─────────────────────────────────────────────────────────┤
│  Meta-Harness (the platform)                            │
│  - Prepares WHAT is available: tools, skills, history   │
│  - Manages lifecycle: sandbox, events, WebSocket        │
│  - Crash recovery, credential isolation, usage tracking │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (Cloudflare or Postgres + Node)         │
└─────────────────────────────────────────────────────────┘
```

The platform prepares _what_ is available; the harness decides _how_ to
deliver it to the model. There's a sensible default harness, but it's
just code in `apps/agent/` that you can fork. If you want a different
context-engineering strategy — e.g., aggressive recency bias, custom
caching breakpoints, RAG over a domain corpus — you write that as a
harness function and the platform runs it.

For most teams the default is fine. The escape hatch matters when it
matters.

## Sandbox runtime

Both platforms run model-generated code in an isolated sandbox. The
implementations differ, and so do the trade-offs.

**Anthropic's Managed Agents** runs sandboxes on Anthropic-managed
infrastructure. Implementation details aren't documented; effectively
it's a black box with quotas.

**Open Managed Agents** ships several sandbox adapters, picked per
environment via env config:

| Adapter | What it is | When to pick |
|---|---|---|
| `cloudflare-sandbox` | Cloudflare Containers, real Linux VM | Default on Cloudflare deployment |
| `local-subprocess` | A subprocess on the host (no isolation) | Local dev only — fast, zero overhead |
| `litebox` | Lightweight container, minimal startup | High-throughput workloads |
| `e2b` | E2B managed sandbox | Already paying for E2B |
| `daytona` | Daytona workspace | Need full IDE-like environment |
| `boxrun` | BoxRun execution | Compliance-driven custom sandbox |

The sandbox API is uniform: `start`, `exec`, `read_file`, `write_file`,
`stop`. You can swap adapters by changing `SANDBOX_RUNTIME=cloudflare`
to `SANDBOX_RUNTIME=e2b` — no code change, no harness change.

## Crash recovery

Both platforms claim crash recovery. The mechanisms differ.

**Anthropic's** is opaque — sessions are durable; if the process holding
your session crashes, it resumes elsewhere. You don't know how.

**Open Managed Agents** uses an event-sourced model that's worth
understanding: every input and output is appended to a per-session event
log (Durable Object SQLite or Postgres). The harness itself is
**stateless** — when a session resumes, the platform replays events and
the harness rebuilds context deterministically. There's no in-memory
state to lose, because there's no in-memory state in the first place.
The same property is what makes the harness swappable: any harness that
can rebuild from an event log can pick up where another left off.

## Storage and data residency

**Anthropic's Managed Agents** stores session data in Anthropic's
chosen regions. Region selection is limited; data residency for
regulated industries is a coordination problem.

**Open Managed Agents** stores wherever you deploy:

- **Cloudflare deployment:** Durable Object SQLite (per-session log) +
  R2 (workspace blobs) + KV (config) + D1 (control plane). Region is
  Cloudflare's edge — you can pin to specific regions with a paid
  enterprise plan, or run via Workers Smart Placement.
- **Self-hosted:** Postgres for the event log + your S3-compatible
  store of choice for blobs. Single tenant per database, your
  region, your encryption keys.

If your compliance team has opinions about where session bytes live,
the self-host story is the answer.

## LLM key handling — BYOK

**Anthropic's Managed Agents** is locked to Anthropic models. Your bill
is one combined line item: tokens + platform fees.

**Open Managed Agents** is BYOK by default — you supply the LLM key and
the platform never touches it for billing. Supported providers include
Anthropic, OpenAI, OpenRouter, and any OpenAI-compatible gateway. Keys
are stored encrypted at rest (AES-GCM, with the master key in your
deployment's secret store) and forwarded directly to the model
provider — the platform itself only sees usage metadata.

This means two things:

1. You can mix providers — one agent on `claude-sonnet-4-6`, another on
   `gpt-5`, depending on what fits the task.
2. **You see the model bill yourself.** The platform charges only for
   sandbox compute and platform features (memory, vaults, integrations)
   — not for tokens. Hosted self-hosters pay for the LLM directly to
   their provider; pure self-hosters pay for nothing on the platform
   side at all.

## Pricing

| | Open Managed Agents (self-host) | Open Managed Agents (hosted) | Anthropic Managed Agents |
|---|---|---|---|
| Platform fee | $0 | Subscription, $0–$100/mo | Bundled in token markup |
| LLM tokens | You pay provider directly | You pay provider directly (BYOK) | Anthropic-rated, no BYOK |
| Sandbox compute | Whatever your infra costs | $0.005/min cloud sandbox | Bundled |
| Free tier | Unlimited | $1 trial credit + unlimited localRuntime | Limited |

The structural difference: self-hosting Open Managed Agents removes the
platform-fee line entirely. The hosted version unbundles tokens from
platform — you control the model bill independently.

## Custom tools and integrations

Both support tool definitions in the request, plus MCP (Model Context
Protocol) for external tools.

**Anthropic's** ships a curated set of first-party tools. MCP is
supported; you point at an MCP server URL and the platform invokes it.

**Open Managed Agents** ships the same curated set plus **first-class
integration adapters** — Linear, Slack, GitHub, Lark — that make the
agent a real workspace member: assigned to issues, mentioned in
threads, replying like a regular user. Integration credentials are
stored in per-tenant vaults (the same encryption story as LLM keys).
The integration adapters are also Apache 2.0, so you can fork them for
private workspaces.

## When each one fits

**Pick Anthropic's Managed Agents when:**

- You want zero infrastructure decisions.
- Anthropic's pricing model fits your usage shape.
- Vendor lock-in is fine — you trust Anthropic's roadmap.
- You don't need to inspect or modify the agent loop.

**Pick Open Managed Agents (hosted) when:**

- You want BYOK so you control the model bill.
- You want the option to self-host later without rewriting clients.
- You want to swap models or providers per agent.
- You want first-class workspace integrations.

**Pick Open Managed Agents (self-host) when:**

- You have a compliance constraint on data residency.
- Token volume makes hosted economics unattractive.
- You want to fork the harness for custom logic.
- You already operate Cloudflare, Postgres, or Kubernetes and adding
  another service is cheap.

## What's not different

A lot, deliberately.

Both are managed agent platforms. Both crash-recover. Both stream
events. Both isolate code in sandboxes. Both have a Console for
operators. Both speak the same API.

The differences live in the layers below the API — runtime ownership,
sandbox choice, key handling, billing model, deployment target. If
those layers don't matter for your use case, the choice is between two
similar products.

If those layers _do_ matter, the open implementation is the only one
that lets you change them.

## Try it

```bash
git clone https://github.com/open-ma/open-managed-agents
cd open-managed-agents
cp .env.example .env  # set ANTHROPIC_API_KEY
docker compose up -d
curl localhost:8787/v1/agents \
  -d '{"name":"hello","model":"claude-sonnet-4-6"}'
```

The same API your existing client speaks. Same loop. Different owner.
