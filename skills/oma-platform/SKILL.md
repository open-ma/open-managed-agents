---
name: oma-platform
description: >
  Reference skill for the openma managed agents platform API. Use this skill whenever
  the agent needs to interact with the openma API: creating agents, managing sessions,
  configuring model cards, managing vaults/credentials, installing skills, or generating
  API keys. Also use when the agent needs to understand the platform's data model or
  perform any CRUD operation on openma resources.
---

# openma Platform API Reference

You are operating on the openma managed agents platform. This skill teaches you how
to use the platform API to manage resources.

## Authentication

All API calls require one of:
- `x-api-key` header (for CLI/SDK access)
- Session cookie (for console access, automatic)

## Core Resources

### Agents

Agents are the primary resource. Each agent has a model, system prompt, tools, and optional skills.

```
POST   /v1/agents                    Create agent
GET    /v1/agents                    List agents
GET    /v1/agents/:id                Get agent
POST   /v1/agents/:id                Update agent
DELETE /v1/agents/:id                Delete agent
POST   /v1/agents/:id/archive        Archive agent
GET    /v1/agents/:id/versions       List versions
```

**Create agent body:**
```json
{
  "name": "My Agent",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant that...",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "description": "One-line description",
  "skills": [{ "type": "custom", "skill_id": "skill_xxx", "version": "latest" }],
  "mcp_servers": [{ "name": "github", "type": "mcp", "url": "https://api.githubcopilot.com/mcp/" }],
  "model_card_id": "mdl-xxx"
}
```

### Sessions

Sessions are conversations with agents. They run in sandboxed environments.

```
POST   /v1/sessions                  Create session
GET    /v1/sessions                  List sessions
GET    /v1/sessions/:id              Get session (includes live status)
POST   /v1/sessions/:id/events       Send user events
GET    /v1/sessions/:id/events       Get events (JSON or SSE)
GET    /v1/sessions/:id/stream       SSE event stream
DELETE /v1/sessions/:id              Delete session
```

**Create session body:**
```json
{
  "agent": "agent-xxx",
  "environment_id": "env-xxx",
  "title": "My conversation",
  "vault_ids": ["vlt-xxx"],
  "resources": [
    { "type": "github_repository", "url": "https://github.com/org/repo", "authorization_token": "ghp_..." },
    { "type": "env_secret", "name": "MY_TOKEN", "value": "secret" }
  ]
}
```

**Send message:**
```json
POST /v1/sessions/:id/events
{
  "events": [{
    "type": "user.message",
    "content": [{ "type": "text", "text": "Hello" }]
  }]
}
```

### Environments

Sandboxed execution environments for agents.

```
POST   /v1/environments              Create environment
GET    /v1/environments              List environments
GET    /v1/environments/:id          Get environment
PUT    /v1/environments/:id          Update (triggers rebuild if config changed)
DELETE /v1/environments/:id          Delete environment
```

For most cases, use the `sandbox-default` environment. Custom environments with extra
packages trigger a build via GitHub Actions.

### Model Cards

Model cards configure API credentials for different LLM providers.

```
POST   /v1/model_cards               Create model card
GET    /v1/model_cards               List model cards
GET    /v1/model_cards/:id           Get model card
POST   /v1/model_cards/:id           Update model card
DELETE /v1/model_cards/:id           Delete model card
```

**Provider types:**
- `ant` — Anthropic official API (Claude models)
- `ant-compatible` — Third-party Anthropic-compatible proxy
- `oai` — OpenAI official API (GPT, o-series models)
- `oai-compatible` — Third-party OpenAI-compatible API (DeepSeek, Groq, etc.)

**Create model card body:**
```json
{
  "name": "My Claude Key",
  "provider": "ant",
  "model_id": "claude-sonnet-4-6",
  "api_key": "sk-ant-...",
  "base_url": "https://proxy.example.com/v1",
  "custom_headers": { "X-Project": "my-project" },
  "is_default": true
}
```

### Credential Vaults

Vaults store credentials for MCP servers and CLI tools.

```
POST   /v1/vaults                    Create vault
GET    /v1/vaults                    List vaults
GET    /v1/vaults/:id               Get vault
DELETE /v1/vaults/:id               Delete vault
POST   /v1/vaults/:id/credentials   Add credential
GET    /v1/vaults/:id/credentials   List credentials
```

**Credential types:**
- `mcp_oauth` — OAuth tokens for MCP servers (auto-managed)
- `static_bearer` — Static bearer tokens
- `command_secret` — Environment variables for CLI tools

### Skills

Skills give agents domain expertise via SKILL.md files.

```
POST   /v1/skills                    Create skill
GET    /v1/skills                    List skills (custom + built-in)
GET    /v1/skills/:id               Get skill
DELETE /v1/skills/:id               Delete skill
POST   /v1/skills/:id/versions      Create new version
```

**Install from ClawHub:**
```
GET    /v1/clawhub/search?q=xxx     Search ClawHub registry
POST   /v1/clawhub/install          Install skill from ClawHub
       Body: { "slug": "skill-name" }
```

### API Keys

Programmatic access keys for CLI/SDK.

```
POST   /v1/api_keys                  Create API key (returns key once)
GET    /v1/api_keys                  List API keys (prefix only)
DELETE /v1/api_keys/:id             Revoke API key
```

### Files

```
POST   /v1/files                     Upload file
GET    /v1/files                     List files
GET    /v1/files/:id/content         Download file content
```

### Memory Stores

Persistent memory for agents with semantic search.

```
POST   /v1/memory_stores             Create store
GET    /v1/memory_stores             List stores
POST   /v1/memory_stores/:id/memories  Write memory
GET    /v1/memory_stores/:id/memories  List memories
```

## Common Workflows

### Quick start: create and run an agent
1. Create a model card (if none exists): `POST /v1/model_cards`
2. Create an agent: `POST /v1/agents`
3. Get or create an environment: `GET /v1/environments` or `POST /v1/environments`
4. Create a session: `POST /v1/sessions`
5. Send a message: `POST /v1/sessions/:id/events`
6. Stream responses: `GET /v1/sessions/:id/stream` (SSE)

### Connect an MCP server
1. Create a vault: `POST /v1/vaults`
2. Start OAuth: `GET /v1/oauth/authorize?mcp_server_url=...&vault_id=...`
3. Attach vault to session: include `vault_ids` in session creation
