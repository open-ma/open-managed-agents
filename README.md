<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/Tests-501%20passed-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**An open-source implementation of the [Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents), running entirely on Cloudflare.**

Drop-in compatible with Anthropic's API. Deploy your own managed agents runtime with full control over harness logic, tool execution, and infrastructure.

> *"We're opinionated about the shape of interfaces, not what runs behind them."*

---

## Why Open Managed Agents?

- **Full API compatibility** — Works with existing Anthropic SDKs and tooling out of the box
- **Pluggable harness** — Swap the agent loop without touching infrastructure. Write a research agent, a coding agent, or a data analysis agent — all sharing the same platform primitives
- **Secure by design** — Credentials never enter sandboxes. Secrets live in vaults, injected via outbound proxy
- **Zero-config local dev** — `npm run dev` and everything runs locally. No Cloudflare account needed for development
- **Production-grade** — Durable event sourcing, crash recovery, context compaction, rate limiting, and 501 tests

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Config API (Hono)             /v1/agents, sessions...  │  Anthropic-compatible REST
├─────────────────────────────────────────────────────────┤
│  Harness Layer (pluggable)     DefaultHarness           │  ai-sdk + Claude
├─────────────────────────────────────────────────────────┤
│  Runtime Primitives            DO · Containers · KV     │  Cloudflare infra
└─────────────────────────────────────────────────────────┘
```

| Primitive | Cloudflare Service | Purpose |
|---|---|---|
| Session event log | Durable Objects + SQLite | Persistent, per-session event sourcing |
| Code sandbox | Containers | Isolated bash / python / node execution |
| Config storage | KV | Agents, environments, vaults, files, memory |
| File persistence | R2 | Workspace files across container restarts |
| Semantic memory | Workers AI + Vectorize | Embedding-based memory search |

> See [`docs/architecture.md`](docs/architecture.md) for the full meta-harness design philosophy.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v4+
- An [Anthropic API key](https://console.anthropic.com/)

### 1. Clone & Install

```bash
git clone https://github.com/anthropics/open-managed-agents.git
cd open-managed-agents
npm install
```

### 2. Local Development

No Cloudflare account needed — everything runs locally in `.wrangler/state/`.

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars:
#   API_KEY=dev-test-key
#   ANTHROPIC_API_KEY=sk-ant-xxx

npm run dev
# → http://localhost:8787
```

```bash
# Verify
curl localhost:8787/health
# → {"status":"ok"}
```

### 3. Deploy to Cloudflare

> Requires a Cloudflare account with Workers Paid plan (Durable Objects + Containers).

```bash
npx wrangler login

# Create KV namespace
npx wrangler kv namespace create CONFIG_KV
# Paste the ID into wrangler.jsonc

# Create R2 bucket (optional, for persistent workspace)
npx wrangler r2 bucket create managed-agents-workspace

# Set secrets
npx wrangler secret put API_KEY
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npm run deploy
# → https://managed-agents.<your-subdomain>.workers.dev
```

### 4. Verify

```bash
export BASE_URL=https://managed-agents.<your-subdomain>.workers.dev
export API_KEY=<your-api-key>

curl $BASE_URL/health
# → {"status":"ok"}

curl -s $BASE_URL/v1/agents \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Coding Assistant",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [{"type": "agent_toolset_20260401"}]
  }'
```

---

## End-to-End Example

```bash
BASE=https://managed-agents.your-subdomain.workers.dev
KEY=your-api-key

# 1. Create agent
AGENT_ID=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name":"Coder","model":"claude-sonnet-4-6","tools":[{"type":"agent_toolset_20260401"}]}' \
  | jq -r '.id')

# 2. Create environment
ENV_ID=$(curl -s $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name":"dev","config":{"type":"cloud","packages":{"pip":["requests"]}}}' \
  | jq -r '.id')

# 3. Create session
SESSION_ID=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\"}" \
  | jq -r '.id')

# 4. Send a message
curl -s $BASE/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Write a Python script that fetches HN top stories"}]}]}'

# 5. Stream events (SSE)
curl -N $BASE/v1/sessions/$SESSION_ID/events/stream \
  -H "x-api-key: $KEY"
```

---

## API Reference

All endpoints require the `x-api-key` header. The API is compatible with [Anthropic's Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents).

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

**Create agent:**

```json
{
  "name": "My Agent",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

</details>

<details>
<summary><strong>Environments</strong> — Configure sandbox execution environments</summary>

```http
POST   /v1/environments                   # Create environment
GET    /v1/environments                   # List environments
GET    /v1/environments/:id               # Get environment
PUT    /v1/environments/:id               # Update environment
DELETE /v1/environments/:id               # Delete environment
```

**Create environment:**

```json
{
  "name": "prod-env",
  "config": {
    "type": "cloud",
    "packages": { "pip": ["numpy", "pandas"], "npm": ["lodash"] }
  }
}
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

# Events
POST   /v1/sessions/:id/events            # Send events (user messages)
GET    /v1/sessions/:id/events             # Get events (JSON or SSE)
GET    /v1/sessions/:id/events/stream      # SSE stream

# Resources
POST   /v1/sessions/:id/resources          # Attach resource
GET    /v1/sessions/:id/resources          # List resources
DELETE /v1/sessions/:id/resources/:resId   # Remove resource
```

**Create session:**

```json
{
  "agent": "agent_xxx",
  "environment_id": "env_xxx",
  "title": "My session"
}
```

**Send message:**

```json
{
  "events": [{
    "type": "user.message",
    "content": [{ "type": "text", "text": "Hello!" }]
  }]
}
```

</details>

<details>
<summary><strong>Vaults & Credentials</strong> — Secure secret management</summary>

```http
POST   /v1/vaults                          # Create vault
POST   /v1/vaults/:id/credentials          # Add credential
GET    /v1/vaults/:id/credentials          # List (secrets stripped)
```

</details>

<details>
<summary><strong>Memory Stores</strong> — Persistent semantic memory</summary>

```http
POST   /v1/memory_stores                   # Create store
POST   /v1/memory_stores/:id/memories      # Create/update memory
GET    /v1/memory_stores/:id/memories      # List memories
GET    /v1/memory_stores/:id/memories/:mid # Get memory
GET    /v1/memory_stores/:id/memory_versions  # Version history
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

The `agent_toolset_20260401` provides a standard set of tools for agent interaction:

| Tool | Description |
|---|---|
| `bash` | Execute commands in the sandbox |
| `read` | Read files from sandbox filesystem |
| `write` | Write/create files (auto-creates directories) |
| `edit` | Surgical string replacement in files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `web_fetch` | HTTP GET with content extraction |
| `web_search` | Web search via Tavily API |

**Selective tool configuration:**

```json
{
  "tools": [{
    "type": "agent_toolset_20260401",
    "default_config": { "enabled": false },
    "configs": [
      { "name": "bash", "enabled": true },
      { "name": "read", "enabled": true }
    ]
  }]
}
```

**Derived tools** are auto-generated based on session config:

| Tool | Source |
|---|---|
| `memory_*` | Memory Stores — `list`, `search`, `read`, `write`, `delete` |
| `call_agent_*` | Callable Agents — multi-agent delegation |
| `mcp_*` | MCP Servers — custom protocol handlers |

---

## Custom Harness

Replace the default agent loop with your own strategy:

```typescript
import type { HarnessInterface, HarnessContext } from "./harness/interface";

export class ResearchHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const messages = ctx.runtime.history.getMessages();

    // Your custom context engineering, model calls, tool execution
    const result = await generateText({
      model: resolveModel(ctx.agent.model, ctx.env.ANTHROPIC_API_KEY),
      messages: myCustomTransform(messages),
      tools: ctx.tools,
      maxSteps: 50,
    });
  }
}
```

Register and use it:

```typescript
registerHarness("research", () => new ResearchHarness());
```

```json
{ "name": "Research Agent", "model": "claude-sonnet-4-6", "harness": "research" }
```

> The platform handles tools, skills, sandbox, history, and crash recovery. Your harness only decides **how** to use them.

---

## Project Structure

```
open-managed-agents/
├── apps/
│   ├── main/                     # Config API worker (Hono routes)
│   │   └── src/
│   │       ├── index.ts          # Entry point, route registration
│   │       ├── auth.ts           # API key authentication
│   │       ├── rate-limit.ts     # Sliding window rate limiter
│   │       └── routes/           # /v1/agents, sessions, environments...
│   ├── agent/                    # Agent worker (SessionDO + harness)
│   │   └── src/
│   │       ├── harness/          # Pluggable agent loop
│   │       │   ├── interface.ts  # HarnessInterface contract
│   │       │   ├── default-loop.ts  # Default harness (ai-sdk)
│   │       │   ├── tools.ts      # Built-in tool definitions
│   │       │   ├── provider.ts   # Model resolution
│   │       │   ├── compaction.ts # Context window management
│   │       │   └── skills.ts     # Skill registry
│   │       └── runtime/
│   │           ├── session-do.ts # Session Durable Object
│   │           ├── history.ts    # Event-to-message conversion
│   │           └── sandbox.ts    # Sandbox executor
│   └── console/                  # React SPA dashboard
├── packages/
│   └── shared/                   # Shared types & utilities
├── test/                         # 171 unit + 330 integration tests
├── docs/                         # Architecture & design documents
└── scripts/                      # Deployment scripts
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `API_KEY` | Yes | Authentication key for API access |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `ANTHROPIC_BASE_URL` | No | Custom endpoint (proxies, compatible APIs) |
| `TAVILY_API_KEY` | No | Tavily API key for `web_search` tool |
| `RATE_LIMIT_WRITE` | No | Write requests/min (default: 60) |
| `RATE_LIMIT_READ` | No | Read requests/min (default: 600) |

### Cloudflare Bindings (wrangler.jsonc)

| Binding | Required | Description |
|---|---|---|
| `CONFIG_KV` | For deploy | KV namespace for config storage |
| `WORKSPACE_BUCKET` | No | R2 bucket for persistent workspace files |
| `containers[].max_instances` | No | Max concurrent sandbox containers (default: 10) |

---

## Testing

```bash
npm test          # 501 tests, ~30s
npm run typecheck # zero errors
```

Coverage: API CRUD, cross-resource flows, session harness, event conversion, tool execution, stress tests, and edge cases.

---

## Documentation

| Document | Description |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Meta-harness design philosophy and key interfaces |
| [`AGENTS.md`](AGENTS.md) | Agent concepts, lifecycle, and configuration guide |
| [`docs/gap-analysis.md`](docs/gap-analysis.md) | Compatibility gaps vs Anthropic's API |
| [`docs/github-pr-flow.md`](docs/github-pr-flow.md) | GitHub integration and PR workflow |
| [`docs/agent-im-design.md`](docs/agent-im-design.md) | Inter-agent communication design |

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Run tests (`npm test && npm run typecheck`)
4. Commit your changes
5. Open a Pull Request

---

## License

[MIT](LICENSE)
