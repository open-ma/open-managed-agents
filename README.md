<p align="center">
  <img src="logo.svg" alt="openma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/Tests-passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**An open-source meta-harness for AI agents.**

Write a harness. Deploy. The platform runs it — with sessions, sandboxes, tools, memory, vaults, and crash recovery out of the box.

📖 **Full documentation:** [docs.openma.dev](https://docs.openma.dev)

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

**Same SDK.** Same `/v1/agents` / `/v1/sessions` API. Same Console UI. Same
crash-recovery semantics. Switch between them by changing env vars, not code.

---

## Quick start: self-host (Docker)

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
cp .env.example .env
$EDITOR .env   # set ANTHROPIC_API_KEY + BETTER_AUTH_SECRET (openssl rand -hex 32)

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
  -d '{"name":"hello","model":"claude-sonnet-4-6","tools":[{"type":"bash"}]}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AID\"}" | jq -r .id)

curl -s -X POST localhost:8787/v1/sessions/$SID/events -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

Full self-host guide (sandbox modes, Postgres, BoxRun, vault sidecar,
Console UI, operator gotchas): **[docs.openma.dev/self-host](https://docs.openma.dev/self-host)**

---

## Quick start: Cloudflare deploy

Requires [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (for Durable Objects + Containers).

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
pnpm install

# Local dev (no CF account needed) — wrangler dev with simulators
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars   # ANTHROPIC_API_KEY=...
pnpm dev
# API   → http://localhost:8787
# Console → http://localhost:5173

# Deploy
npx wrangler login
npx wrangler kv namespace create CONFIG_KV   # paste id into wrangler.jsonc
npx wrangler secret put API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
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

### 4. Create Your First Agent

```bash
BASE=http://localhost:8787  # or your deployed URL
KEY=dev-test-key

# Create an agent
AGENT_ID=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r '.id')

# Create an environment (sandbox with packages)
ENV_ID=$(curl -s $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "dev",
    "config": {
      "type": "cloud",
      "packages": { "pip": ["requests", "pandas"] }
    }
  }' | jq -r '.id')

# Start a session
SESSION_ID=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\"}" \
  | jq -r '.id')

# Send a message
curl -s $BASE/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{ "type": "text", "text": "Write a Python script that fetches HN top stories" }]
    }]
  }'

# Stream events (SSE)
curl -N $BASE/v1/sessions/$SESSION_ID/events/stream \
  -H "x-api-key: $KEY"
```

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
│  Infrastructure (Cloudflare)                             │
│  - Durable Objects + SQLite — session event log         │
│  - Containers — isolated code execution                 │
│  - KV + R2 — config, files, credentials                 │
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

Compatible with the [Anthropic Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents). Same endpoints, same event types, works with existing SDKs.

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
<summary><strong>Memory Stores</strong> — persistent storage; Anthropic Managed Agents Memory contract</summary>

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
| `web_search` | Web search via Tavily API |

Derived tools are auto-generated based on session config:

| Tool | Source |
|---|---|
| `call_agent_*` | Callable Agents (multi-agent delegation) |
| `mcp_*` | MCP Servers |

(Memory Stores do **not** add bespoke tools — agents access them as filesystem
mounts at `/mnt/memory/<store_name>/` via the standard file tools above.)

---

## Integrations

Publish an agent into a third-party tool and have it act as a real teammate there — assigned, mentioned, replied to like any other user.

### Linear

Make an agent a member of your Linear workspace with its own identity, avatar, and `@autocomplete` slot. The agent appears in the assignee dropdown, gets pinged on `@mentions`, and pushes status back to issues it's working on.

Two ways to drive the publish flow:

```bash
# (1) Console — for humans clicking through a wizard
Integrations → Linear → Publish agent

# (2) CLI — for agents driving openma on a user's behalf
oma linear publish <agent-id> --env <env-id>          # → returns Linear App config + form token
oma linear submit <form-token> --client-id … --client-secret …   # ↑ once Linear gives you OAuth credentials
oma linear list                                       # verify the workspace
oma linear pubs <installation-id>                     # verify the agent shows status=live
oma linear update <pub-id> --caps issue.read,comment.write,…   # tighten capabilities
oma linear unpublish <pub-id>                         # tear down
```

The full agent-side playbook (when to ask the human, how to offer browser automation, exactly what to paste into Linear's form) lives at [`skills/openma/integrations-linear.md`](skills/openma/integrations-linear.md).

How it works:

| Piece | What it does |
|---|---|
| **Per-agent App** | Each agent registers as its own Linear OAuth App so identity is isolated |
| **Inbound webhook** | Linear events (assigned, mentioned, commented) become user messages on a session |
| **Outbound MCP** | The agent talks back through `mcp.linear.app` with its own bearer, so writes are attributed to the persona |
| **Capability gate** | Per-publication allowlist (issues / comments / labels / assignment / triage) limits what the agent can do |

The Linear integration ships in three packages: `packages/linear/` (provider logic), `packages/integrations-core/` (provider-neutral persistence types), `packages/integrations-adapters-cf/` (D1 implementation). Adding a second integration (Slack, GitHub, …) is a matter of writing a new provider against the same interfaces.

---

## Project Structure

```
open-managed-agents/
├── apps/
│   ├── main/              # API worker — Hono routes, auth, rate limiting
│   ├── agent/             # Agent worker — SessionDO + harness + sandbox
│   ├── integrations/      # Integrations gateway — Linear OAuth + webhooks
│   └── console/           # Web dashboard — React + Vite + Tailwind v4
├── packages/
│   ├── cli/               # `oma` CLI — agent / session / integration commands
│   ├── shared/            # Shared types & utilities
│   ├── linear/            # Linear provider (publish flows, webhook signing)
│   ├── integrations-core/ # Provider-neutral types, persistence interfaces
│   ├── integrations-adapters-cf/ # D1 / KV / Workers adapter
│   └── integrations-ui/   # React pages mounted by the Console
├── test/                  # Unit + integration tests
└── scripts/               # Deployment scripts
```

---

## Configuration

| Variable | Required | Description |
|---|---|---|
| `API_KEY` | Yes | Authentication key for API access |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `ANTHROPIC_BASE_URL` | No | Custom endpoint (proxies, compatible APIs) |
| `TAVILY_API_KEY` | No | Tavily API key for `web_search` tool |

---

## Testing

```bash
npm test          # unit + integration suite
npm run typecheck # zero errors
```

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
