# Open Managed Agents on Cloudflare

An open-source implementation of the [Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents), running entirely on Cloudflare's infrastructure.

Drop-in compatible with Anthropic's API — deploy your own managed agents runtime with full control over harness logic, tool execution, and infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Config API  (Hono)          /v1/agents, sessions…  │  ← Anthropic-compatible REST
├─────────────────────────────────────────────────────┤
│  Harness Layer  (pluggable)  DefaultHarness         │  ← ai-sdk + Claude
├─────────────────────────────────────────────────────┤
│  Runtime Primitives          DO · Containers · KV   │  ← Cloudflare infra
└─────────────────────────────────────────────────────┘
```

| Primitive | Cloudflare Service | Purpose |
|-----------|-------------------|---------|
| Session event log | Durable Object + SQLite | Persistent, per-session event sourcing |
| Code sandbox | Containers | Isolated bash/python/node execution |
| Config storage | KV | Agents, environments, vaults, files, memory |
| File persistence | R2 | Workspace files across container restarts |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v4+
- A Cloudflare account with Workers Paid plan (Durable Objects + Containers require paid)
- An [Anthropic API key](https://console.anthropic.com/)

### 1. Clone & Install

```bash
git clone https://github.com/anthropics/open-managed-agents.git
cd open-managed-agents
npm install
```

### 2. Local Development

No Cloudflare resources needed — `wrangler dev` simulates everything locally.

```bash
# Set up local environment variables
cp .dev.vars.example .dev.vars
# Edit .dev.vars:
#   API_KEY=dev-test-key
#   ANTHROPIC_API_KEY=sk-ant-xxx

# Start local dev server
npm run dev
# → http://localhost:8787
```

That's it. KV, Durable Objects, R2 all run locally in `.wrangler/state/`. Your data never leaves your machine.

```bash
# Verify it works
curl localhost:8787/health                    # → {"status":"ok"}
curl localhost:8787/v1/agents \
  -H "x-api-key: dev-test-key" \
  -H "content-type: application/json" \
  -d '{"name":"Test","model":"claude-sonnet-4-6"}'
```

### 3. Deploy to Cloudflare

```bash
# Login
npx wrangler login

# Create KV namespace
npx wrangler kv namespace create CONFIG_KV
# → { binding = "CONFIG_KV", id = "abc123..." }

# Paste the ID into wrangler.jsonc
# "kv_namespaces": [{ "binding": "CONFIG_KV", "id": "abc123..." }]

# Create R2 bucket (optional, for persistent workspace files)
npx wrangler r2 bucket create managed-agents-workspace

# Set secrets
npx wrangler secret put API_KEY
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npm run deploy
# → https://managed-agents.<your-subdomain>.workers.dev
```

> **Note:** The KV `id` in `wrangler.jsonc` is safe to commit — it's not a secret. Local dev ignores it and uses local storage automatically.

### 4. Verify Deployment

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

## Testing

```bash
npm test          # 501 tests, ~30s
npm run typecheck # zero errors
```

Test suite: 171 unit + 330 integration tests covering API CRUD, cross-resource flows, session harness, event conversion, tools, stress, and edge cases.

## API Reference

All endpoints require the `x-api-key` header. The API is compatible with [Anthropic's Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents).

### Agents

```bash
# Create agent
POST /v1/agents
{ "name": "My Agent", "model": "claude-sonnet-4-6", "system": "...", "tools": [...] }

# List / Get / Update / Delete / Archive
GET    /v1/agents
GET    /v1/agents/:id
PUT    /v1/agents/:id
DELETE /v1/agents/:id
POST   /v1/agents/:id/archive

# Version history
GET    /v1/agents/:id/versions
GET    /v1/agents/:id/versions/:version
```

### Environments

```bash
POST   /v1/environments
{ "name": "prod-env", "config": { "type": "cloud", "packages": { "pip": ["numpy"] } } }

GET    /v1/environments
GET    /v1/environments/:id
PUT    /v1/environments/:id
DELETE /v1/environments/:id
```

### Sessions

```bash
# Create session (binds agent + environment)
POST /v1/sessions
{ "agent": "agent_xxx", "environment_id": "env_xxx", "title": "My session" }

# Send events (user messages, interrupts, etc.)
POST /v1/sessions/:id/events
{ "events": [{ "type": "user.message", "content": [{"type": "text", "text": "Hello"}] }] }

# Get events (JSON or SSE)
GET /v1/sessions/:id/events              # Accept: application/json
GET /v1/sessions/:id/events              # Accept: text/event-stream
GET /v1/sessions/:id/events/stream       # Always SSE

# Session management
GET    /v1/sessions
GET    /v1/sessions/:id
POST   /v1/sessions/:id                  # Update title/metadata
DELETE /v1/sessions/:id
POST   /v1/sessions/:id/archive

# Session resources
POST   /v1/sessions/:id/resources
GET    /v1/sessions/:id/resources
DELETE /v1/sessions/:id/resources/:resId
```

### Vaults & Credentials

```bash
POST   /v1/vaults                         # Create vault
POST   /v1/vaults/:id/credentials         # Add credential
GET    /v1/vaults/:id/credentials         # List (secrets stripped)
```

### Memory Stores

```bash
POST   /v1/memory_stores                  # Create store
POST   /v1/memory_stores/:id/memories     # Create/update memory
GET    /v1/memory_stores/:id/memories     # List memories
GET    /v1/memory_stores/:id/memories/:id # Get with content
GET    /v1/memory_stores/:id/memory_versions  # Version history
```

### Files

```bash
POST   /v1/files                          # Upload file
GET    /v1/files/:id/content              # Download file
```

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

# 4. Send message
curl -s $BASE/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Write a Python script that fetches HN top stories"}]}]}'

# 5. Stream events
curl -N $BASE/v1/sessions/$SESSION_ID/events/stream \
  -H "x-api-key: $KEY"
```

## Built-in Tools

The `agent_toolset_20260401` provides:

| Tool | Description |
|------|-------------|
| `bash` | Execute commands in the sandbox |
| `read` | Read files from sandbox filesystem |
| `write` | Write/create files (auto-creates directories) |
| `edit` | Surgical string replacement in files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `web_fetch` | HTTP GET with content extraction |
| `web_search` | Web search via Tavily API |

Selectively enable/disable tools:

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

## Custom Harness

Replace the default agent loop with your own:

```typescript
// src/my-harness.ts
import type { HarnessInterface, HarnessContext } from "./harness/interface";

export class MyHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime } = ctx;

    // Your custom logic here
    runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "Custom response" }],
    });
  }
}

// src/index.ts — register it
import { registerHarness } from "./harness/registry";
import { MyHarness } from "./my-harness";
registerHarness("my-harness", () => new MyHarness());
```

Create agents with your harness:

```json
{ "name": "Custom Agent", "model": "claude-sonnet-4-6", "harness": "my-harness" }
```

## Project Structure

```
src/
├── index.ts                    # Entry point, route registration
├── env.ts                      # Environment bindings interface
├── auth.ts                     # API key authentication
├── rate-limit.ts               # Sliding window rate limiter
├── types.ts                    # Core type definitions
├── id.ts                       # ID generation (nanoid)
├── outbound.ts                 # Credential injection for MCP
├── harness/
│   ├── interface.ts            # HarnessInterface contract
│   ├── registry.ts             # Harness factory registry
│   ├── default-loop.ts         # Default harness (ai-sdk)
│   ├── tools.ts                # Tool definitions
│   ├── provider.ts             # Model resolution
│   ├── skills.ts               # Skill registry
│   ├── compaction.ts           # Context window management
│   └── outcome-evaluator.ts    # Outcome satisfaction
├── runtime/
│   ├── session-do.ts           # Session Durable Object
│   ├── history.ts              # Event-to-message conversion
│   └── sandbox.ts              # Sandbox executor
└── routes/
    ├── agents.ts               # /v1/agents
    ├── environments.ts         # /v1/environments
    ├── sessions.ts             # /v1/sessions
    ├── vaults.ts               # /v1/vaults
    ├── files.ts                # /v1/files
    └── memory.ts               # /v1/memory_stores
```

## Configuration Reference

### wrangler.jsonc

| Setting | Required | Description |
|---------|----------|-------------|
| `kv_namespaces[0].id` | For deploy | KV namespace ID. Local dev uses local storage regardless. |
| `r2_buckets[0].bucket_name` | No | R2 bucket for persistent workspace files |
| `containers[0].max_instances` | No | Max concurrent sandbox containers (default: 10) |
| `containers[0].instance_type` | No | Container size: `lite` or `standard` |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEY` | Yes | Authentication key for API access |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `ANTHROPIC_BASE_URL` | No | Custom endpoint (for proxies or compatible APIs) |
| `TAVILY_API_KEY` | No | Tavily API key for web search tool |
| `RATE_LIMIT_WRITE` | No | Write requests/min (default: 60) |
| `RATE_LIMIT_READ` | No | Read requests/min (default: 600) |

## License

MIT
