<p align="center">
  <img src="logo.svg" alt="openma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/Tests-passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
  <img src="https://img.shields.io/badge/OpenAI-Agents%20API%20%2B%20SDK-412991" alt="OpenAI Agents API and SDK support" />
</p>

# Open Managed Agents

**Open-source, self-hosted alternative to Claude Managed Agents and OpenAI Agents API.**

🌐 **[openma.dev](https://openma.dev)** · 📖 **[docs.openma.dev](https://docs.openma.dev)** · 💬 **[github.com/openma-ai/open-managed-agents](https://github.com/openma-ai/open-managed-agents)**

OpenMA runs agents with durable sessions, sandboxed tools, memory, encrypted credentials, and crash recovery. Use the Claude Managed Agents API on Cloudflare or Node, or the official OpenAI SDK with the Node server's `/openai/v1` endpoint. Bring your own model keys and deploy on your own infrastructure.

Use Open Managed Agents when you want:

- A self-hosted Claude Managed Agents API implementation.
- OpenAI Agents API support with durable sessions, function continuation, and subagent controls on Node.
- An open-source, self-hosted Claude Tag-style workflow with BYOK model credentials.
- MCP, private tools, encrypted vaults, and durable sessions under your own deployment boundary.

Compare: [Claude Tag alternative](https://openma.dev/claude-tag-alternative/) · [Open-source Claude Tag](https://openma.dev/claude-tag-open-source/) · [Self-hosted Claude Tag](https://openma.dev/self-hosted-claude-tag/)

---

## Two ways to run OMA

The same harness, business logic, and event-log model run on both. Pick the
one that matches your hosting story:

| | **Self-host (Node)** | **Cloudflare** |
|---|---|---|
| Where it lives | Your VPS / Mac / Docker host / fly.io / your k8s | Cloudflare Workers + DO + Containers |
| Storage | SQLite or Postgres + local FS | D1 + KV + R2 |
| Sandbox | LocalSubprocess / LiteBox / Daytona / E2B / BoxRun | Cloudflare Sandbox (Containers) |
| Time to running | `docker compose up` (~2 min) | wrangler deploy (~10 min once configured) |
| Best for | OSS users, on-prem, no CF account, data-resident deploys | Edge scale, no host management, already on CF |

Both hosts expose the Claude-compatible `/v1/agents` and `/v1/sessions` API
and Console UI. The OpenAI Agents API adapter is currently mounted on the
Node host at `/openai/v1`.

---

## OpenAI Agents API quickstart (Node)

[Start a Node server with Docker](#quick-start-self-host-docker), create an
OpenMA API key, and configure a model in your deployment. Then install the
supported OpenAI SDK version:

```bash
npm install openai@7.15.0
```

Point the client at your OpenMA server:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: "http://localhost:8787/openai/v1",
});

const session = await client.beta.agents.sessions.create({
  agent: { model: "your-configured-model", instructions: "Be concise." },
  environment: { type: "none" },
  input: "Hello",
});
console.log(session.id);
```

Sessions support text, function calls that wait for your application's result,
and subagents. Set `agent.multi_agent.enabled: true` to let the main agent
delegate subtasks. You can send input, wait, interrupt, close, and resume each
child. Children keep separate conversations and share the parent's files;
they cannot create more children.

The OpenAI API currently runs on Node. Advanced environment and plugin settings,
plus some MCP and model options, are not supported yet. Check the
[supported features and limits](docs/openai-agents-compatibility-status.md)
before migrating an existing application. See the
[adapter guide](packages/openai-agents-compat/README.md) for configuration details.

---

## Quick start: self-host (Docker)

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# Two secrets are required before first boot — both generated locally:
#   BETTER_AUTH_SECRET   — signs Console sessions
#   PLATFORM_ROOT_SECRET — encrypts credentials, model-card API keys, integration tokens at rest
#                          (lose it and every encrypted row is unreadable — back it up)
$EDITOR .env
# BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
#
# Optional: ANTHROPIC_API_KEY lets the first agent run without a Model Card.
# In production, add a Model Card per tenant from the Console instead.

# SQLite + LocalSubprocess sandbox (default — fastest path)
docker compose up -d

# Or Postgres backend
# docker compose -f docker-compose.postgres.yml up -d

curl localhost:8787/health
# → {"status":"ok","backends":{"db":"sqlite ..."}, ...}

open http://localhost:8787   # Console UI on the same port
```

Smoke test the harness end-to-end:

```bash
AID=$(curl -s -X POST localhost:8787/v1/agents -H 'content-type: application/json' \
  -d '{"name":"hello","model":"claude-sonnet-4-6","tools":[{"type":"agent_toolset_20260401"}]}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\"}" | jq -r .id)

curl -s -X POST localhost:8787/v1/sessions/$SID/events -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

Full self-host guide (sandbox modes, Postgres, BoxRun, vault sidecar,
Console UI, operator gotchas): **[docs.openma.dev/self-host/overview](https://docs.openma.dev/self-host/overview/)**

---

## Quick start: Cloudflare deploy

Requires [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (for Durable Objects + Containers).

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
pnpm install

# Local dev (no CF account needed) — wrangler dev with simulators
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars
# Same two-secret setup as Docker — PLATFORM_ROOT_SECRET is required to start
pnpm dev
# API   → http://localhost:8787
# Console → http://localhost:5173

# Deploy
npx wrangler login
npx wrangler kv namespace create CONFIG_KV   # paste id into wrangler.jsonc

# Required secrets (paste each when prompted)
npx wrangler secret put BETTER_AUTH_SECRET    # openssl rand -hex 32
npx wrangler secret put PLATFORM_ROOT_SECRET  # openssl rand -base64 32 — back this up
npx wrangler secret put API_KEY               # initial bootstrap key for the REST API

# Optional — only if you want a tenant-less default LLM (otherwise add a Model Card in the Console)
# npx wrangler secret put ANTHROPIC_API_KEY

npm run deploy
# → https://openma.dev (or https://managed-agents.<your-subdomain>.workers.dev for a personal deploy)
```

What gets deployed:

| Component | What it does |
|---|---|
| **Main Worker** | API routes — agents, sessions, environments, vaults, memory, files |
| **Agent Worker** | SessionDO + harness + sandbox per environment |
| **KV Namespace** | Config storage for agents, environments, credentials |
| **R2 Bucket** | Workspace file persistence across container restarts |

### Create your first agent

The smoke test above works against any deployment. For the Console-driven flow (Model Cards, vaults, integrations) see **[docs.openma.dev/quickstart](https://docs.openma.dev/quickstart)**. The minimal API equivalent:

```bash
BASE=http://localhost:8787   # or your deployed URL
KEY=dev-test-key             # whatever you set as API_KEY

AGENT=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r .id)

SESSION=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" | jq -r .id)

# Send a turn AND stream the reply token-by-token in one shot
curl -N -X POST $BASE/v1/sessions/$SESSION/messages \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"content":"Write a Python script that fetches HN top stories"}'
```

For long-lived sessions use `GET /v1/sessions/$SESSION/events/stream` — replays history on connect, never closes.

---

## Architecture

A **meta-harness** is not an agent — it's the platform that runs agents. It defines stable interfaces for everything an agent needs, and stays out of the way of the agent loop:

```
┌─────────────────────────────────────────────────────────┐
│  Harness (the brain — your code)                        │
│  - Reads events, builds context, calls the model        │
│  - Decides HOW: caching, compaction, tool delivery      │
│  - Stateless: crash → rebuild from event log → resume   │
├─────────────────────────────────────────────────────────┤
│  Meta-Harness (the platform — SessionDO)                │
│  - Prepares WHAT is available: tools, skills, history   │
│  - Manages lifecycle: sandbox, events, WebSocket        │
│  - Crash recovery, credential isolation, usage tracking │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (Cloudflare or Node self-host)          │
│  - Event log: Durable-Object SQLite (CF) or SQLite/Pg   │
│  - Sandbox: CF Containers / subprocess / LiteBox / E2B  │
│  - Storage: KV + R2 (CF) or local FS (self-host)        │
└─────────────────────────────────────────────────────────┘
```

**The platform prepares _what_ is available. The harness decides _how_ to deliver it to the model.**

| Platform manages | Harness decides |
|---|---|
| Event log persistence (SQLite) | Context engineering (filtering, ordering) |
| Sandbox lifecycle (containers) | Caching strategy (cache breakpoints) |
| Tool registration (built-in + MCP) | Compaction strategy (when to compress) |
| WebSocket broadcast | Retry strategy (backoff, transient detection) |
| Crash recovery | Stop conditions (max steps, completion signals) |
| Credential isolation (vaults) | System prompt construction |
| Memory (vector search) | Tool delivery (all at once vs. progressive) |

---

## Write a Harness

The default harness works out of the box. When you need custom behavior — different caching, compaction, context engineering — write your own:

```typescript
// my-harness.ts
import { defineHarness, generateText, stepCountIs } from "@open-managed-agents/sdk";

export default defineHarness({
  name: "research",

  async run(ctx) {
    let messages = ctx.runtime.history.getMessages();

    // Your context engineering
    messages = keepOnly(messages, ["web_search", "web_fetch"]);

    // Your caching strategy
    markLastN(messages, 3, { cacheControl: "ephemeral" });

    // Your loop — tools, sandbox, broadcast are platform-provided
    const result = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages,
      tools: ctx.tools,
      stopWhen: stepCountIs(50),
      onStepFinish: async ({ text }) => {
        if (text) ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text }],
        });
      },
    });

    await ctx.runtime.reportUsage?.(result.usage.inputTokens, result.usage.outputTokens);
  },
});
```

Deploy it:

```bash
oma deploy --harness my-harness.ts --agent agent_abc123
```

The harness is bundled into the agent worker at build time. Your code runs in the same isolate as SessionDO — direct access to the event log, sandbox, and WebSocket broadcast. No RPC, no serialization boundary.

---

## API

The endpoints below expose the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents) at `/v1`.
The Node host also supports the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)
at `/openai/v1`; see the [OpenAI SDK quickstart](#openai-agents-api-quickstart-node)
for its separate resource and event contract.

<details>
<summary><strong>Agents</strong> — Create and manage agent configurations</summary>

```http
POST   /v1/agents                          # Create agent
GET    /v1/agents                          # List agents
GET    /v1/agents/:id                      # Get agent
PUT    /v1/agents/:id                      # Update agent
DELETE /v1/agents/:id                      # Delete agent
POST   /v1/agents/:id/archive             # Archive agent
GET    /v1/agents/:id/versions            # Version history
GET    /v1/agents/:id/versions/:version   # Get specific version
```

</details>

<details>
<summary><strong>Environments</strong> — Sandbox execution environments</summary>

```http
POST   /v1/environments                   # Create environment
GET    /v1/environments                   # List environments
GET    /v1/environments/:id               # Get environment
PUT    /v1/environments/:id               # Update environment
DELETE /v1/environments/:id               # Delete environment
```

</details>

<details>
<summary><strong>Sessions</strong> — Run agent conversations</summary>

```http
POST   /v1/sessions                        # Create session
GET    /v1/sessions                        # List sessions
GET    /v1/sessions/:id                    # Get session
POST   /v1/sessions/:id                    # Update session
DELETE /v1/sessions/:id                    # Delete session
POST   /v1/sessions/:id/archive           # Archive session

POST   /v1/sessions/:id/events            # Send events (user messages)
GET    /v1/sessions/:id/events             # Get events (JSON or SSE)
GET    /v1/sessions/:id/events/stream      # SSE stream

POST   /v1/sessions/:id/resources          # Attach resource
GET    /v1/sessions/:id/resources          # List resources
DELETE /v1/sessions/:id/resources/:resId   # Remove resource
```

</details>

<details>
<summary><strong>Vaults</strong> — Secure credential storage</summary>

```http
POST   /v1/vaults                          # Create vault
POST   /v1/vaults/:id/credentials          # Add credential
GET    /v1/vaults/:id/credentials          # List (secrets stripped)
```

</details>

<details>
<summary><strong>Memory Stores</strong> — persistent storage; Claude Managed Agents Memory contract</summary>

When attached to a session, each store is mounted into the sandbox at
`/mnt/memory/<store_name>/`. The agent reads and writes it with the
**standard file tools** (bash/read/write/edit/glob/grep) — there are no
bespoke `memory_*` tools.

R2 holds the bytes-of-truth (key `<store_id>/<memory_path>`); D1 holds the
index + audit, kept eventually consistent via R2 Event Notifications →
Cloudflare Queue → Consumer.

```http
POST   /v1/memory_stores                                        # Create store
GET    /v1/memory_stores                                        # List stores
GET    /v1/memory_stores/:id                                    # Retrieve store
POST   /v1/memory_stores/:id/archive                            # Archive (one-way)
DELETE /v1/memory_stores/:id                                    # Delete store + memories + versions

POST   /v1/memory_stores/:id/memories                           # Create/upsert memory {path, content, precondition?}
GET    /v1/memory_stores/:id/memories?path_prefix=&depth=N      # List memories (metadata)
GET    /v1/memory_stores/:id/memories/:mid                      # Retrieve memory (with content)
POST   /v1/memory_stores/:id/memories/:mid                      # Update memory {path?, content?, precondition?}
DELETE /v1/memory_stores/:id/memories/:mid                      # Delete memory

GET    /v1/memory_stores/:id/memory_versions?memory_id=         # Audit history (newest first)
GET    /v1/memory_stores/:id/memory_versions/:ver_id            # Single version (with snapshot content)
POST   /v1/memory_stores/:id/memory_versions/:ver_id/redact     # Redact prior version (refuses live head)
```

CAS via `precondition: { type: "content_sha256", content_sha256 }`. 100KB
cap per memory. 30-day version retention with the most-recent version per
memory always preserved. Rollback = retrieve a version and write its
content as a new memory revision (no special endpoint).

CLI:
```bash
oma memory stores create "User Preferences"
oma memory write <store-id> /preferences/formatting.md --content "Always use tabs."
oma memory ls <store-id> --prefix /preferences/
oma memory versions <store-id> --memory-id <mem-id>
```

</details>

<details>
<summary><strong>Files & Skills</strong></summary>

```http
POST   /v1/files                           # Upload file
GET    /v1/files/:id/content               # Download file
POST   /v1/skills                          # Create skill
GET    /v1/skills                          # List skills
```

</details>

---

## Built-in Tools

The `agent_toolset_20260401` provides:

| Tool | Description |
|---|---|
| `bash` | Execute commands in the sandbox |
| `read` | Read files from sandbox filesystem |
| `write` | Write/create files (auto-creates directories) |
| `edit` | Surgical string replacement in files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `web_fetch` | URL → markdown via Workers AI; auto-summarized when `agent.aux_model` is set, raw saved to `/workspace/.web/` |
| `web_search` | Web search via Tavily API (requires `TAVILY_API_KEY`) |
| `schedule` / `cancel_schedule` / `list_schedules` | Cron-style self-wakeup for long-running agents |
| `browser` (opt-in) | Headless browser session — navigate, click, screenshot. Opt-in via `tools: [{ name: "browser", enabled: true }]` so the default-tool list nudges agents toward cheaper `web_fetch` |

Derived tools are auto-generated based on session config:

| Tool | Source |
|---|---|
| `call_agent_*` | Callable Agents (multi-agent delegation) |
| `mcp__<server>__<tool>` | MCP Servers (double underscore is the actual separator) |

(Memory Stores do **not** add bespoke tools — agents access them as filesystem
mounts at `/mnt/memory/<store_name>/` via the standard file tools above.)

---

## MCP servers

OMA registers any [Model Context Protocol](https://modelcontextprotocol.io) server attached to an agent. Each upstream tool surfaces to the model as `mcp__<server>__<tool>` (double underscore — copy the name exactly). Up to 20 servers per agent.

| Transport | When to use | How |
|---|---|---|
| HTTP / SSE | Hosted MCP servers (Linear, GitHub Copilot, Notion, …) | `{"type":"url","url":"https://mcp.linear.app/mcp"}` |
| stdio | npm / PyPI MCP packages with no hosted endpoint | `{"type":"stdio","command":"uvx","args":[...],"port":8765}` — OMA spawns inside the sandbox container, talks to `127.0.0.1:port/sse` |

Credentials never enter the sandbox; the outbound resolver matches by host and injects at forward time.

| Auth mode | Configured as | Refresh |
|---|---|---|
| none | no `authorization_token`, no matching vault credential | n/a |
| inline bearer | `"authorization_token": "..."` on the server entry | no |
| vault static bearer | session vault has a `static_bearer` credential whose `mcp_server_url` matches | no |
| vault OAuth | session vault has an `mcp_oauth` credential (with `refresh_token` + `token_endpoint`) | yes — on 401 **and 403** (Airtable/Asana/Sentry use 403 for expired tokens), CAS-writes new token to D1, retries once |

```bash
# Servers attach to the agent (not the session)
curl -X PUT $BASE/v1/agents/$AGENT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"mcp_servers":[{"name":"linear","type":"url","url":"https://mcp.linear.app/mcp"}]}'

# Bind an OAuth credential via Vault
oma connect linear --vault $VAULT_ID
```

Tool discovery is bounded at 15 s per server; one bad server logs and skips, the rest stay live. Full design: [docs.openma.dev/build/vault-and-mcp](https://docs.openma.dev/build/vault-and-mcp/).

---

## Skills

A skill is a `SKILL.md` plus reference files (templates, schemas, examples). At session start the platform mounts everything under `/home/user/.skills/{name}/` in the sandbox **and inlines the SKILL.md body directly into the system prompt** — no lazy read, no follow-up `read` tool call. Format is compatible with Anthropic's [Claude Code skills](https://github.com/anthropics/skills).

Create a skill (JSON; files inlined):

```http
POST /v1/skills
{
  "files": [
    { "filename": "SKILL.md", "content": "---\nname: invoice-parser\ndescription: Parse supplier invoices.\n---\n\n# Steps\n1. ..." },
    { "filename": "schema.json", "content": "{...}" }
  ]
}
```

For large skills with binaries: `POST /v1/skills/upload` multipart with `file=<my-skill.zip>`.

Attach to an agent with the **object form** — a bare string array silently does not bind:

```json
{ "skills": [{ "skill_id": "skill_abc123", "type": "custom" }] }
```

The agent's system prompt then receives, at session start:

```text
<source name="skill:skill_abc123">
<skill name="invoice-parser">
{full SKILL.md body}
</skill>
</source>
```

and the files appear at `/home/user/.skills/invoice-parser/SKILL.md` etc.

Four built-in skills ship ready to attach (no upload): `xlsx`, `pdf`, `docx`, `pptx`. Reference them with `{"skill_id":"builtin_pdf","type":"anthropic"}`.

---

## Vaults & outbound credentials

**Tools never see your tokens.** When a sandbox makes an HTTP request, an outbound resolver — `oma-vault` sidecar on self-host (mockttp HTTPS proxy with a trusted self-signed CA), the agent worker's `outboundByHost` interceptor on Cloudflare — matches the request hostname against the session's vaults, **strips any inbound `Authorization`/`x-api-key`/`x-goog-api-key`**, injects the real credential, and forwards. A prompt-injected agent has nothing to leak; `env | grep TOKEN` returns nothing inside the sandbox.

```bash
# Create a vault and add a static bearer bound to api.github.com
VID=$(curl -sX POST $BASE/v1/vaults -H "x-api-key: $KEY" \
  -d '{"name":"github-prod"}' | jq -r .id)

curl -sX POST $BASE/v1/vaults/$VID/credentials -H "x-api-key: $KEY" -d '{
  "display_name": "gh-pat",
  "auth": {
    "type": "static_bearer",
    "token": "ghp_xxx",
    "mcp_server_url": "https://api.github.com"
  }
}'

# Bind on session create
curl -sX POST $BASE/v1/sessions -H "x-api-key: $KEY" \
  -d "{\"agent\":\"$AGENT\",\"vault_ids\":[\"$VID\"]}"

# Inside the sandbox: curl https://api.github.com/user → 200, Authorization injected at the network layer
```

Three credential types share one resolver:

| Type | Match by | Refresh |
|---|---|---|
| `static_bearer` | request host matches `mcp_server_url` | never |
| `mcp_oauth` | request host matches `mcp_server_url` | on 401 / 403 via `token_endpoint`, CAS-writes new token to D1 |
| `cap_cli` | sandbox CLI invocations match `cli_id` in the cap registry (`gh`, `glab`, `aws`, …) | per-CLI |

Max 20 credentials per vault. Each forward emits a structured `op:"mcp_proxy.forward"` log. Full design: [`docs/mcp-credential-architecture.md`](docs/mcp-credential-architecture.md), [docs.openma.dev/build/vault-and-mcp](https://docs.openma.dev/build/vault-and-mcp/).

---

## Integrations

Publish an agent into a third-party tool and have it act as a real teammate there — assigned, mentioned, replied to like any other user.

### Linear

Make an agent a member of your Linear workspace with its own identity, avatar, and `@autocomplete` slot. The agent appears in the assignee dropdown, gets pinged on `@mentions`, replies in the Agent panel, and pushes status back to issues it's working on.

Two install kinds:

| Kind | When to pick | Setup |
|---|---|---|
| **`personal_token`** (PAT) | Single workspace, fastest path, no OAuth App | `oma linear install-pat --workspace <slug> --pat <linear-pat>` |
| **`dedicated`** (OAuth App) | Multi-workspace, proper bot identity, OAuth refresh | Console **Integrations → Linear → Publish agent** (wizard issues per-publication callback + webhook URLs to paste into your own Linear OAuth App at `linear.app/settings/api`) |

The full agent-side playbook (when to ask the human, how to offer browser automation, exactly what to paste into Linear's form) lives at [`skills/openma/integrations-linear.md`](skills/openma/integrations-linear.md).

PAT-mode autopilot — let the bot pick up unassigned issues by label/state/project:

```bash
oma linear rules create <pub-id> --label triage --state Backlog --project "Inbox"
oma linear rules list <pub-id>
oma linear rules delete <rule-id>
```

Inspect / manage:

```bash
oma linear list                                       # workspaces
oma linear pubs <installation-id>                     # publications (status=live, persona, caps)
oma linear get <pub-id>                               # single publication
oma linear update <pub-id> --caps issue.read,comment.write,issue.update,…
oma linear unpublish <pub-id>
```

How it works:

| Piece | What it does |
|---|---|
| **Per-publication identity** | `dedicated` registers a per-agent Linear OAuth App; `personal_token` shares the human's PAT (no App registered) |
| **Inbound webhook** | Linear events become user messages on a session — assigned, `@mention`, comment-mention, new comment in an active thread, **Agent panel** (`agentSessionCreated` / `agentSessionPrompted`, `commentReply` for threaded continuation) |
| **Outbound MCP** | The agent talks back through `mcp.linear.app/mcp` with its own bearer (PAT or OAuth-refreshed), so writes are attributed to the persona |
| **Capability gate** | Per-publication allowlist (issues / comments / labels / assignment / triage) limits what the agent can do |

The Linear integration ships in `packages/linear/` (provider logic, webhook signing, MCP wiring) with thin CF wrappers in `apps/integrations/src/routes/linear/publications.ts`.

### GitHub

Give an agent its own GitHub App with a real bot identity — assignable on issues, requestable as a reviewer on PRs, posts comments under its own `@<slug>[bot]` handle. Each agent is a separate App on github.com (per-publication, not a shared marketplace bot), so credentials and audit trails stay isolated.

```bash
# (1) Console — humans clicking through a wizard
Integrations → GitHub → Publish agent

# (2) CLI — agents driving openma on a user's behalf
oma github bind <agent-id> --env <env-id>       # → opens one-click GitHub App Manifest flow
oma github handoff <form-token>                 # alt: 7-day URL for an org admin to complete
oma github list
oma github pubs <installation-id>
oma github update <pub-id> --caps pr.read,pr.review.write,issue.comment.write,…
oma github unpublish <pub-id>
```

`bind` returns a `manifestStartUrl`; opening it auto-POSTs an App manifest to `github.com/settings/apps/new` with redirect URL + webhook URL + recommended permissions baked in. After confirming, GitHub redirects through to "Install on org" and the publication flips to `live`. Manual fallback: `oma github submit <form-token> --app-id … --private-key-file … --webhook-secret …` if you registered the App by hand.

**Engagement is label-based.** On install OMA auto-creates a label (default: lowercased persona name) in every selected repo. Add the label to any issue/PR to engage the bot for every subsequent activity on that thread; remove the label to mute. `@<slug>[bot]` mention in body or comment is the fallback path (GitHub's `@` autocomplete excludes Bot accounts, so it's plain-text).

How it works:

| Piece | What it does |
|---|---|
| **Per-publication App** | Each agent registers its own GitHub App via Manifest flow; credentials stored encrypted per-publication |
| **Inbound webhook** | `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment` become user messages on a session (one per `<repo>#<num>`) |
| **Outbound MCP** | Agent talks to GitHub's hosted MCP at `api.githubcopilot.com/mcp/` with the installation token; same token also injected as `GITHUB_TOKEN` for sandbox `gh` / `git` |
| **Token rotation** | 1-hour installation token auto-refreshed via App JWT on every webhook dispatch |
| **Capability gate** | Per-publication allowlist; destructive ops (`pr.merge`, `repo.branch.delete`, `workflow.dispatch`, `release.create`, `*.delete`) require explicit opt-in |

The GitHub integration ships in `packages/github/` with thin CF wrappers in `apps/integrations/src/routes/github/`.

### Slack

Publish an agent into a Slack workspace as a dedicated bot — `@mention`able in channels, replies in threads, joins DMs, hosts the AI assistant pane. Per-channel sessions: one running session per `(publication, channel)`, with all events in that channel converging on the same session id.

```bash
# (1) Console — humans clicking through a wizard
Integrations → Slack → Publish agent   # ↑ opens api.slack.com with a pre-filled manifest

# (2) CLI — agents driving openma on a user's behalf
oma slack publish <agent-id> --env <env-id>    # → returns manifestLaunchUrl + formToken (60 min TTL)
oma slack submit <form-token> --client-id … --client-secret … --signing-secret …
oma slack handoff <form-token>                 # alt: 7-day shareable URL for a workspace admin
oma slack list
oma slack pubs <installation-id>
oma slack update <pub-id> --caps message.write,thread.reply,reaction.add,…
oma slack unpublish <pub-id>
```

The full agent-side playbook (manifest-flow caveats, `GATEWAY_ORIGIN` HTTPS requirement, what to paste where, MCP toggle probe) lives at [`skills/openma/integrations-slack.md`](skills/openma/integrations-slack.md).

How it works:

| Piece | What it does |
|---|---|
| **Per-publication App** | Each agent registers as its own dedicated Slack App via the "Create from manifest" URL flow — own client id, signing secret, bot user; no shared marketplace App |
| **Inbound webhook** | `app_mention` / DM / thread reply → `direct_invocation` signal; top-level channel post → debounced `channel_scan_armed` (90 s window); reactions on bot-authored messages → `reaction_on_bot_message`; `member_joined`/`member_left_channel` for the bot → `joined_channel` / `session_closed`; `channel_archive` / `channel_unarchive` → close / reopen |
| **Dual-token outbound** | OAuth v2 yields both bot (`xoxb-`) and user (`xoxp-`) tokens. The `xoxp-` vault binds to `mcp.slack.com/mcp` for typed `mcp__slack__*` tools (search, history, canvases); the `xoxb-` vault binds to `slack.com/api` for `chat.postMessage`, reactions, etc. Bot replies default to in-thread |
| **Capability gate** | Per-publication allowlist (`message.read/write/update/delete`, `thread.reply`, `reaction.add/remove`, `user.read`, `search.read`, `canvas.write`) |
| **Resumable install** | Publication-first — the row exists from minute one with callback + webhook URLs baked into the manifest. Mid-flow failures stay resumable from Console (`pending_setup` → `credentials_filled` → `awaiting_install` → `live`) |

The Slack integration ships in `packages/slack/` with thin CF wrappers in `apps/integrations/src/routes/slack/`.

**Operator setup:** the integrations gateway needs `GATEWAY_ORIGIN` pointing at a publicly-reachable HTTPS host — Slack verifies both the OAuth redirect URL and the Events Request URL before letting an install complete.

---

## Project Structure

```
open-managed-agents/
├── apps/
│   ├── main/              # API worker (Cloudflare) — Hono routes, auth, rate limiting
│   ├── main-node/         # API worker (Node self-host) — same routes on Hono/Node
│   ├── agent/             # Agent worker — SessionDO + harness + sandbox
│   ├── integrations/      # Integrations gateway — Linear / GitHub / Slack OAuth + webhooks
│   ├── oma-vault/         # Vault sidecar — outbound auth-header injection (per-host secrets)
│   ├── console/           # Web dashboard — React + Vite + Tailwind v4
│   ├── docs/              # Docs site (Astro Starlight) — published to docs.openma.dev
│   └── web/               # Marketing site (Astro) — published to openma.dev
├── packages/
│   ├── cli/                       # `oma` CLI — agent / session / integration commands
│   ├── sdk/                       # Harness SDK — defineHarness, generateText helpers
│   ├── api-types/                 # Shared TypeScript types (config schemas, events)
│   ├── http-routes/               # Public REST route definitions (shared by main + main-node)
│   ├── session-runtime/           # Harness runtime — event log, broadcast, recovery
│   ├── sandbox/                   # Sandbox adapters (subprocess / litebox / daytona / e2b / boxrun)
│   ├── credentials-store/         # Encrypted credentials (AES-GCM under PLATFORM_ROOT_SECRET)
│   ├── model-cards-store/         # Encrypted model-card API keys
│   ├── vaults-store/              # Vault definitions + outbound auth wiring
│   ├── linear/  github/  slack/   # Provider logic (OAuth, webhook signing, MCP wiring)
│   ├── integrations-core/         # Provider-neutral persistence interfaces
│   └── integrations-adapters-{cf,node}/  # D1 / KV / Workers + Postgres / FS implementations
├── docs/                  # Internal design RFCs (not the user-facing site)
├── test/                  # Unit + integration tests
└── scripts/               # Deployment + maintenance scripts
```

---

## Configuration

The variables that gate boot and at-rest safety:

| Variable | Required | Description |
|---|---|---|
| `PLATFORM_ROOT_SECRET` | **Yes** | AES-GCM key for `credentials.auth`, `model_cards.api_key_cipher`, and integration tokens. Workers refuse to start without it. **Back this up** — losing it makes every encrypted row unreadable. Generate with `openssl rand -base64 32`. |
| `BETTER_AUTH_SECRET` | **Yes** (prod) | better-auth session signing key. Sessions don't survive restart if missing. Generate with `openssl rand -hex 32`. |
| `API_KEY` | Yes | Bootstrap key for the REST API in dev / first-run. Once the Console is up, prefer per-tenant API keys minted from there. |
| `INTEGRATIONS_INTERNAL_SECRET` | Yes (if `apps/integrations` runs) | Shared secret between `apps/main` and `apps/integrations`. |
| `ANTHROPIC_API_KEY` | No | Fallback LLM credential used when a tenant has not added a Model Card. **In production, add a Model Card per tenant from the Console** — the key is encrypted at rest under `PLATFORM_ROOT_SECRET`, scoped to the tenant, and rotatable without redeploy. |
| `ANTHROPIC_BASE_URL` | No | Override for Anthropic-compatible proxies. |
| `PUBLIC_BASE_URL` | No (dev) / Yes (prod) | Cookie domain + OAuth redirect base. Defaults to `*` trusted-origins — only safe for local dev. |
| `SANDBOX_PROVIDER` | No | `subprocess` (default, no isolation), `litebox` (Firecracker), `daytona`, `e2b`, or `boxrun`. Use an isolated backend for untrusted agents. |
| `TAVILY_API_KEY` | No | Backend for the `web_search` built-in tool. |

Full list (integrations OAuth credentials, Postgres URL, sandbox tunables, memory-bucket config, Google sign-in, etc.) — see **[docs.openma.dev/reference/configuration](https://docs.openma.dev/reference/configuration/)** and `.env.example` / `.dev.vars.example`.

---

## Model Cards

Per-tenant LLM credentials. An agent references one by setting `agent.model = "<model_id>"` — the worker looks up the card and signs the outbound request with its api_key, base_url, and headers. This is the canonical replacement for the global `ANTHROPIC_API_KEY` env var.

Providers are Pi provider ids. The four legacy tags remain migration aliases:

| provider | Pi protocol / use |
|---|---|---|
| `anthropic` (`ant`) | Pi Anthropic Messages; Claude on `api.anthropic.com` |
| `openai` (`oai`) | Pi OpenAI Responses/Completions |
| Any Pi built-in id | `deepseek`, `openrouter`, `google`, `minimax`, etc.; Pi owns model metadata and wire behavior |
| Custom id | Requires `base_url` and `pi_config.api`; compatible aliases still map to Anthropic/OpenAI protocols |

Add one from **Console → Model Cards**, or via CLI:

```bash
oma models create \
  --model-id claude-prod \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --api-key sk-ant-...
oma models list
```

REST: `POST /v1/oma/model_cards`, `GET /v1/oma/model_cards`, `POST /v1/oma/model_cards/:id` (rotate), `DELETE /v1/oma/model_cards/:id`. Create runs a bounded live probe for the legacy Anthropic/OpenAI protocols; other Pi providers return an explicit skipped probe result and are validated when their runtime request is exercised.

There are two model catalogs. Official `GET /v1/models` lists this tenant's
executable Model Cards in the Managed Agents shape, with capabilities and token
limits projected from Pi. OMA `POST /v1/oma/models/list {provider}` lists Pi's
built-in catalog while configuring a card and does not require a provider key;
the old `api_key` field remains optional for 0.x Anthropic/OpenAI live discovery.

Agent request controls are versioned with the Agent and inherited by Sessions:
`model.effort` maps to Pi thinking levels (Pi normalizes unsupported levels),
`model.speed=fast` maps to Anthropic fast mode or OpenAI priority tier, and
`model.inference_geo` is preserved in the official API but is not currently a
runtime routing input. These controls are not Model Card `pi_config` fields.

Keys are AES-256-GCM-encrypted at rest under `PLATFORM_ROOT_SECRET` (label `model.cards.keys`); list responses surface only the last-4 preview. Rotate by POSTing a new `api_key` — no redeploy, no key versioning (re-run the backfill script if you rotate `PLATFORM_ROOT_SECRET` itself).

---

## Testing

```bash
npm test          # unit + integration suite
npm run typecheck # zero errors
pnpm run test:openai-agents      # OpenAI SDK, HTTP and session behavior
pnpm run test:openai-agents:node # Node execution and subagents
pnpm run test:e2e:openai-agents # Production Node E2E with the official SDK
```

See the [OpenAI compatibility report](docs/openai-agents-compatibility-status.md)
and [upstream test audit](docs/openai-agents-upstream-test-audit.md) for the
tested SDK version, coverage and known limits.

---

## Documentation

The user-facing docs site lives at [`apps/docs`](apps/docs/) (Astro Starlight) and is published to **[docs.openma.dev](https://docs.openma.dev)**.

```bash
pnpm dev:docs       # local preview at http://localhost:4321
pnpm build:docs     # static build into apps/docs/dist/
pnpm deploy:docs    # build + wrangler deploy (Cloudflare Worker static assets)
```

The `docs/` folder at the repo root contains **internal design RFCs** — not the user-facing site.

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Run tests (`npm test && npm run typecheck`)
4. Commit your changes
5. Open a Pull Request

---

## License

[Apache 2.0](LICENSE)
