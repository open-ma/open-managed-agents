---
title: "Migrating from Anthropic Managed Agents to Open Managed Agents"
description: "Practical migration guide. What stays the same, what changes, and the exact steps to switch your client code, sessions, vaults, and integrations to the open-source platform."
publishedAt: 2026-05-12
author: openma
tags: ["migration", "anthropic", "managed-agents", "guide"]
---

If you're already running on Anthropic's Managed Agents and considering
the move to the open-source equivalent, this is the migration guide.
The good news first: the API surface is identical, so your client code
is the cheapest part of the migration. The work is mostly in
provisioning your own deployment, moving credentials into vaults,
re-creating environments, and validating that the harness behaves the
same on a few representative sessions.

This guide is opinionated: it assumes you want the **hosted** Open
Managed Agents flavor for a smooth first migration, with the option to
self-host later. The order is the same either way.

## TL;DR

1. **Pick a target deployment** — hosted (`openma.dev`) or self-host.
2. **Get a platform API key** — sign in, create one in the Console.
3. **Stash your LLM provider key in a vault** — BYOK is mandatory; the
   platform never bills you for tokens.
4. **Re-create your agents and environments** — same JSON shape, fed to
   `/v1/agents` and `/v1/environments`.
5. **Update client base URL** — one line.
6. **Run a parallel session for a week** — compare outputs against the
   old platform on a representative workload.
7. **Cut over.**

## What stays the same

- **Client code.** Anthropic SDK works against Open Managed Agents — you
  swap the base URL and your existing calls work.
- **Request/response shapes.** Agent definitions, environment specs,
  session events, all match.
- **The `/v1/sessions/{id}/events/stream` SSE format.** Same event
  types, same fields, same ordering guarantees.
- **MCP server URLs.** If you use MCP tools, the URLs go in the agent
  definition the same way.

## What changes

- **Base URL.** `api.anthropic.com/v1/agents` → `openma.dev/v1/agents`
  (hosted) or your self-hosted host.
- **Auth header.** Anthropic uses `x-api-key` for the model key directly;
  Open Managed Agents uses `x-api-key` for the *platform* key, with the
  *model* key stored separately in a vault. The model key never travels
  on the request.
- **Pricing line items.** You'll see two bills now — your model
  provider directly, plus the platform's sandbox compute charge (or
  zero if self-hosted).
- **Vault setup.** The model key, integration tokens, and any
  per-tenant secrets need to be created in a vault before the first
  session can run.
- **Region and data residency.** You pick now. Anthropic's hosted
  service runs where Anthropic decides; Open Managed Agents runs where
  you deploy.

## Step 1 — Pick a deployment target

If you're not sure, start hosted. Self-host is a deeper commitment;
prove the API surface works for your code first.

| | Hosted (openma.dev) | Self-host on Cloudflare | Self-host on Postgres + Node |
|---|---|---|---|
| Time to first session | Minutes | ~30 min initial setup | ~1 hour initial setup |
| Operational burden | None | Low (one `wrangler deploy`) | Medium (Postgres ops) |
| Free tier | $1 trial credit | Free (Workers Paid plan req.) | Free (your infra cost) |
| When | Validating the migration | Long-term, edge-friendly workload | Compliance, on-prem, AWS shop |

The rest of this guide assumes hosted; the steps are the same for
self-host with a different base URL.

## Step 2 — Get a platform key

Sign in at [app.openma.dev](https://app.openma.dev). The first sign-in
creates a tenant for you. Go to **Settings → API keys** and create a
platform key. Stash it as `OPENMA_PLATFORM_KEY` in your secrets
manager.

```bash
export OPENMA_PLATFORM_KEY=opn_live_xxxxxxx
export BASE=https://openma.dev
```

## Step 3 — Move your LLM key into a vault

This is the BYOK setup. The platform forwards your model key to
Anthropic / OpenAI / OpenRouter / whatever; it never sees the token
spend on its own bill.

```bash
curl -X POST $BASE/v1/vaults \
  -H "x-api-key: $OPENMA_PLATFORM_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "anthropic-prod",
    "type": "anthropic",
    "credential": {
      "api_key": "sk-ant-...your existing Anthropic key..."
    }
  }'
# → { "id": "vault_abc123" }
```

The credential is encrypted at rest with the platform's root key (see
[the self-host guide](/blog/self-host-agent-platform-cloudflare-workers/)
for the encryption design). The plaintext never leaves the vault and
never appears in logs.

## Step 4 — Re-create your agents

The agent JSON shape is identical to Anthropic's. Reference the vault
by id where you previously embedded the API key directly.

Old (Anthropic):

```json
{
  "name": "my-agent",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant."
}
```

New (Open Managed Agents):

```json
{
  "name": "my-agent",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "vault_id": "vault_abc123"
}
```

The only addition is `vault_id` — pointing at the vault you just
created. Tools, MCP server URLs, system prompts, all unchanged.

```bash
AID=$(curl -s -X POST $BASE/v1/agents \
  -H "x-api-key: $OPENMA_PLATFORM_KEY" \
  -H "content-type: application/json" \
  -d @agent.json | jq -r .id)
```

## Step 5 — Re-create your environments

Same shape, with one extra field — `sandbox_runtime` — which picks the
sandbox adapter. Hosted defaults to `cloudflare` (real Linux sandbox);
self-host can pick `local-subprocess` for dev or `e2b` etc.

```bash
ENV_ID=$(curl -s -X POST $BASE/v1/environments \
  -H "x-api-key: $OPENMA_PLATFORM_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "prod",
    "config": {
      "type": "cloud",
      "sandbox_runtime": "cloudflare",
      "packages": { "pip": ["requests","pandas"] }
    }
  }' | jq -r .id)
```

If you weren't using environments on the old platform, you can omit
this step — the agent will run with a default ephemeral environment.

## Step 6 — Swap the client base URL

In your client code:

```diff
- const client = new Anthropic({
-   apiKey: process.env.ANTHROPIC_API_KEY,
-   baseURL: "https://api.anthropic.com",
- });
+ const client = new Anthropic({
+   apiKey: process.env.OPENMA_PLATFORM_KEY,
+   baseURL: "https://openma.dev",
+ });
```

Note the `apiKey` is now the platform key, not the model key. The
platform looks up the model key in the vault attached to the agent.

That's the full client-side change. If you wrap the SDK in your own
helper, it's a one-line change in the helper.

## Step 7 — Run a parallel session

Before cutting traffic over, run the same prompt against both
platforms for a week and compare outputs on a representative sample
of your workload. Both stream the same event shape, so a
side-by-side comparison is mechanical:

```ts
const oldEvents: Event[] = [];
const newEvents: Event[] = [];

await Promise.all([
  streamEvents(oldClient, prompt, e => oldEvents.push(e)),
  streamEvents(newClient, prompt, e => newEvents.push(e)),
]);

compareSequences(oldEvents, newEvents);
```

What to look for in the comparison:

- **Tool selection.** Did both agents pick the same tool for the same
  prompt? Differences here are usually harness-level — caching
  strategy, system prompt placement, tool description ordering.
- **Latency.** First-token and total-completion times. Open Managed
  Agents adds a Durable Object hop; hosted latency is typically within
  ~50ms of the upstream model.
- **Cost.** Token counts should match (same model, same prompt, same
  tools). Sandbox compute cost is the new line item — usually a few
  cents per session.

## Step 8 — Cut over

Once parallel testing is clean, cut all traffic to the new base URL.
Keep the old setup live for ~24 hours so you can roll back if
something surfaces in production traffic that didn't show up in the
parallel sample.

## Edge cases

**Custom MCP servers.** They work the same — same URL in the agent
definition. The new platform's network egress allow-list is
permissive by default; if you've configured an allow-list (Console →
Settings → Network), make sure the MCP server's host is on it.

**File uploads.** Both platforms accept multipart uploads to
`/v1/files`. The storage backing differs (Anthropic's blob store vs.
R2 / your S3-compatible store) but the API is identical. Existing file
ids don't carry over — re-upload.

**Webhooks.** If you subscribe to webhooks for `session.completed`
events, the payload shape is the same. The signing key changes (you
generate a new one in the new platform's Console); update your
verification middleware.

**Multi-tenant setups.** If you operate multiple tenants on
Anthropic's platform via a single account, Open Managed Agents
supports the same pattern via per-tenant scoping. Each tenant gets
its own vault and its own API key. The data model is identical.

## When migration doesn't make sense

It's worth being honest:

- If your workload is fully inside Anthropic's pricing sweet spot and
  you don't need BYOK, self-host, or workspace integrations, the
  migration is pure overhead.
- If you've never hit a wall with the closed product's harness, the
  ability to write your own probably isn't worth the migration cost.
- If you're a single-developer hobby project, the hosted Anthropic
  experience is hard to beat for time-to-running.

The migration pays off when one of these is true: cost dominates and
BYOK changes the math; you have a compliance constraint on data
residency; you need a custom harness; you want to ship workspace
integrations like Linear/Slack/GitHub agent membership without
building them yourself; you want the option to self-host without
rewriting clients.

## What you get on the other side

- **Same API.** Your client code didn't change.
- **Same crash-recovery semantics.** Sessions resume after worker
  restarts, same as before.
- **Lower or unbundled bill.** You see the model bill yourself; you
  pay only for sandbox compute on the platform side.
- **Source code you can read.** When something behaves unexpectedly,
  you can look. When you need a fix, you can ship it as a PR.
- **A self-host option that's actually finished.** If the day comes
  that you need to move to your own infra, the migration is
  `docker compose up`, not a rewrite.

See [the side-by-side technical
comparison](/blog/anthropic-managed-agents-vs-open-managed-agents/) for
the architectural differences, and the [open-source alternatives
landscape](/blog/open-source-alternatives-to-anthropic-managed-agents-2026/)
for context on where this sits in the broader space.

## Get started

```bash
# Hosted — fastest path
export OPENMA_PLATFORM_KEY=opn_live_xxxxxxx
curl https://openma.dev/v1/agents \
  -H "x-api-key: $OPENMA_PLATFORM_KEY" \
  -d '{"name":"hello","model":"claude-sonnet-4-6","vault_id":"..."}'

# Self-host — same call against your deployment
docker compose up -d
curl http://localhost:8787/v1/agents \
  -H "x-api-key: $LOCAL_PLATFORM_KEY" \
  -d '{"name":"hello","model":"claude-sonnet-4-6"}'
```
