---
title: "How to Self-Host an Agent Platform on Cloudflare Workers"
description: "End-to-end guide to deploying Open Managed Agents on Cloudflare. Workers + Durable Objects + Containers + R2. Wrangler config, secrets, custom domains, and what to do when each piece breaks."
publishedAt: 2026-05-11
author: openma
tags: ["self-host", "cloudflare", "workers", "durable-objects", "guide"]
---

If you want to run a full agent platform — not a chatbot, but the
managed kind: sessions, sandboxes, tool dispatch, crash recovery,
event log, billing — Cloudflare's primitives are surprisingly close to
what you need out of the box. This guide walks through deploying
[Open Managed Agents](https://github.com/open-ma/open-managed-agents)
on Cloudflare end-to-end: what each Worker does, what each binding is
for, what breaks, and how to debug when something doesn't come up.

By the end you'll have an agent platform running on your own
Cloudflare account, reachable at a custom domain, with a Console UI
and a working `/v1/sessions` endpoint.

## What gets deployed

Open Managed Agents is split across several Workers that talk over
service bindings. The split lets each piece scale independently and
keeps the Durable Object placement clean.

| Worker | Role |
|---|---|
| `openma-main` | Public API — agents, environments, vaults, memory, files, auth |
| `openma-agent` | SessionDO + harness + sandbox per session |
| `openma-integrations` | Linear / Slack / GitHub / Lark adapters |
| `openma-docs` | Docs site (separate from the platform) |
| `openma-web` | Marketing site + blog (this site) |

For a minimum self-host you need the first three. Docs and web are
optional — you can point at the public docs.openma.dev instead.

## Prerequisites

1. **Cloudflare account on the Workers Paid plan.** The free plan
   doesn't include Durable Objects or Containers, both of which are
   load-bearing here. Workers Paid is $5/month minimum.
2. **A custom domain.** You can use a Workers `*.workers.dev` subdomain
   for testing, but Containers + DO bindings need a custom domain in
   production for sane routing.
3. **Wrangler 4.x** installed locally (`npm i -g wrangler` or use the
   pinned dev dependency in the repo).
4. **An Anthropic API key.** Or any OpenAI-compatible key the platform
   forwards as BYOK.

## Step 1 — Clone and install

```bash
git clone https://github.com/open-ma/open-managed-agents
cd open-managed-agents
pnpm install
```

The repo is a pnpm workspace — installing once at the root pulls
dependencies for every Worker.

## Step 2 — Provision the Cloudflare resources

The Workers themselves get created on first deploy, but the bindings
they reference (KV, R2, D1) need to exist first.

```bash
# KV for runtime config (per-tenant settings, feature flags)
npx wrangler kv namespace create CONFIG_KV
# → copy the printed `id` into apps/main/wrangler.jsonc

# R2 for blobs (workspace snapshots, memory chunks, file uploads)
npx wrangler r2 bucket create openma-blobs
# → set in apps/main/wrangler.jsonc as the binding `BLOBS`

# D1 for relational state (auth, agents, sessions index, ledger)
npx wrangler d1 create openma-control
# → copy the printed `database_id` into apps/main/wrangler.jsonc
```

Each `wrangler.jsonc` template in `apps/*/` is annotated with the
binding names — you replace the placeholder ids with the ones from
the commands above. Commit those as part of your deployment branch
(or use the hosted overlay pattern from `openma-hosted/` if you'd
rather keep prod ids out of the OSS tree).

## Step 3 — Run the migration

```bash
npx wrangler d1 migrations apply openma-control
```

This creates the schema for the control plane: `agents`, `sessions`,
`environments`, `vaults`, `model_cards`, `ledger_entries`. The
migrations live in `packages/schema/migrations/` so you can audit
them before applying.

## Step 4 — Set the platform secrets

There are a handful of secrets the platform needs. Set each via
`wrangler secret put`:

```bash
# Encrypts vault contents (LLM keys, integration tokens) at rest.
# This is the root of trust for every encrypted credential — back it
# up in your password manager. Losing it bricks every encrypted secret.
openssl rand -base64 32 | npx wrangler secret put PLATFORM_ROOT_SECRET

# Better Auth session signing key
openssl rand -hex 32 | npx wrangler secret put BETTER_AUTH_SECRET

# Default LLM provider key — only for testing / first-run.
# Real usage should be BYOK from each tenant.
npx wrangler secret put ANTHROPIC_API_KEY
```

`PLATFORM_ROOT_SECRET` is the single most important one. It encrypts
every credential in every vault. **Lose it and every stored API key,
integration token, and credential is unreadable.** Back it up in a
password manager that's separate from your Cloudflare account.

## Step 5 — Deploy

```bash
npx wrangler deploy -c apps/main/wrangler.jsonc
npx wrangler deploy -c apps/integrations/wrangler.jsonc
npx wrangler deploy -c apps/agent/wrangler.jsonc
```

Order matters slightly — the agent worker has a service binding to
main, so main needs to exist first.

After each deploy, wrangler prints the route. Hit `/health` to confirm
the worker is up:

```bash
curl https://your-deploy-url/health
# → {"status":"ok","backends":{"db":"d1 ..."},"version":"..."}
```

## Step 6 — Smoke test the agent loop

The smallest viable test: create an agent, create a session, send a
message, watch events stream back.

```bash
BASE=https://your-deploy-url
KEY=your-platform-api-key  # from the auth flow

AID=$(curl -s -X POST $BASE/v1/agents \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "smoke",
    "model": "claude-sonnet-4-6",
    "system": "Reply with exactly one word.",
    "tools": [{ "type": "bash" }]
  }' | jq -r .id)

SID=$(curl -s -X POST $BASE/v1/sessions \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d "{\"agent_id\":\"$AID\"}" | jq -r .id)

curl -s -X POST $BASE/v1/sessions/$SID/events \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message",
       "content":[{"type":"text","text":"say hi"}]}]}'

# Stream the response
curl -N $BASE/v1/sessions/$SID/events/stream -H "x-api-key: $KEY"
```

If you see an `agent.message` event come back over SSE, the loop is
wired up correctly.

## Step 7 — Bind a custom domain

By default each Worker is on `*.workers.dev`. For production you want
a custom domain so the URLs are stable and the `/v1/` API is at a
predictable host.

In `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "openma.example.com/*", "custom_domain": true }
]
```

Add the DNS record in the Cloudflare dashboard (the `custom_domain`
flag tells wrangler to provision the cert automatically) and redeploy.

## What to do when each piece breaks

**Worker deploys but `/health` returns 500.**
Probably a missing secret. Check the runtime logs (`wrangler tail`)
— the most common cause is `PLATFORM_ROOT_SECRET` not being set, or
a binding id that doesn't match a real resource.

**Session starts but no events come back.**
The agent worker can't reach the model provider. Verify the BYOK key
is set in the vault for your tenant, and that the model id matches
something the provider supports. `wrangler tail openma-agent` will
show the upstream HTTP error.

**Sandbox starts but `bash` tool times out.**
Cloudflare Containers takes a few seconds on cold start. If you're
hitting consistent timeouts, the container probably failed to start
— check for `container_runtime: failed` in the agent worker logs.
The fix is usually a base-image issue; the default `cloudflare-sandbox`
image includes bash + python + node, so a custom image is what to
audit first.

**DO storage limit errors after a while.**
Each SessionDO embeds a SQLite database; the per-DO storage limit is
generous but not infinite. Sessions are designed to be archived after
completion (the `session.completed` event triggers a snapshot to R2 +
DO storage cleanup). If the cleanup isn't running, check the cron
binding in `apps/agent/wrangler.jsonc`.

## What's left

What this guide doesn't cover:

- **Multi-tenancy.** Open Managed Agents supports multiple tenants
  from a single deployment via `tenant_id` scoping. The default
  setup is single-tenant; the multi-tenant story needs an auth
  provider configured (Better Auth + your IdP).
- **Backups.** D1 has automatic backups; R2 has versioning. The
  important thing to script is `PLATFORM_ROOT_SECRET` rotation —
  see [the encryption design notes in the repo](https://github.com/open-ma/open-managed-agents/tree/main/docs).
- **Observability.** Workers Analytics Engine + Logpush is the
  default; the `packages/cf-billing/src/cf-analytics.ts` module
  emits usage events you can query for billing.

## Why Cloudflare specifically

The short version: every primitive Open Managed Agents needs has a
direct Cloudflare equivalent.

- Per-session strong consistency → Durable Objects with embedded
  SQLite.
- Per-step Linux sandbox → Cloudflare Containers.
- Long-lived blob storage → R2.
- Per-tenant config → KV.
- Relational control plane → D1.

There's no Kafka, no Redis, no managed Postgres in the path. One
`wrangler deploy` per Worker brings the whole thing up. For a project
that doesn't want to operate infrastructure as a side quest, that
matters.

If you can't be on Cloudflare — data residency, compliance, existing
AWS commitment — there's a Postgres + Node deployment that uses the
same harness, same API, same Console. See
[the migration guide](/blog/migrate-from-anthropic-managed-agents/)
for how that fits together.

## Try the hosted version first

If you want to validate the API surface before committing to the
self-host work:

```bash
# Hosted, BYOK
curl https://openma.dev/v1/agents \
  -H "x-api-key: YOUR_PLATFORM_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"hello","model":"claude-sonnet-4-6"}'
```

The same call works against your self-hosted deployment with the host
swapped.
