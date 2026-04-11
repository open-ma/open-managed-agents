# Agents Guide

This document covers the core concepts, lifecycle, and configuration of agents in Open Managed Agents.

---

## Core Concepts

Open Managed Agents is built around a **meta-harness** architecture with four key abstractions:

### Agent

An **agent** is a configuration object that defines _what_ an AI assistant can do. It specifies the model, system prompt, available tools, skills, and optional connections to other agents or MCP servers.

Agents are versioned — every update creates a new version. Sessions bind to a specific agent version at creation time.

### Session

A **session** is a running conversation between a user and an agent. It owns an append-only **event log** stored in a Durable Object backed by SQLite. Sessions are the unit of state — agents themselves are stateless configurations.

Sessions can be streamed in real-time via SSE, resumed after crashes, and archived when complete.

### Environment

An **environment** defines the execution sandbox — what packages are installed, what networking is allowed, and what container image to use. Environments are reusable across sessions and agents.

### Vault

A **vault** is a secure credential store. Credentials in vaults are **never exposed to sandboxes** — they're injected via an outbound proxy that intercepts HTTP requests and adds authentication headers transparently.

---

## Agent Lifecycle

```
                    ┌──────────┐
                    │  Create   │  POST /v1/agents
                    └────┬─────┘
                         │
                    ┌────▼─────┐
              ┌────►│  Active   │◄────┐
              │     └────┬─────┘     │
              │          │           │
         ┌────┴───┐ ┌───▼────┐ ┌───┴─────┐
         │ Update  │ │ Archive│ │ Sessions│
         │ (new    │ │        │ │ use it  │
         │ version)│ └───┬────┘ └─────────┘
         └─────────┘     │
                    ┌────▼─────┐
                    │ Archived  │
                    └──────────┘
```

1. **Create** — `POST /v1/agents` with name, model, system prompt, and tools
2. **Use** — Create sessions referencing the agent by ID
3. **Update** — `PUT /v1/agents/:id` creates a new version; existing sessions keep their original version
4. **Archive** — `POST /v1/agents/:id/archive` soft-deletes the agent

---

## Agent Configuration

### Minimal Agent

```json
{
  "name": "Assistant",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

### Full Configuration

```json
{
  "name": "Full-Stack Developer",
  "description": "A coding agent with access to tools, skills, and external services.",
  "model": "claude-sonnet-4-6",
  "system": "You are an expert full-stack developer. Write clean, tested code.",
  "tools": [
    {
      "type": "agent_toolset_20260401",
      "default_config": { "enabled": true },
      "configs": [
        { "name": "web_search", "enabled": false }
      ]
    },
    {
      "type": "custom",
      "name": "deploy",
      "description": "Deploy the application to production",
      "input_schema": {
        "type": "object",
        "properties": {
          "environment": { "type": "string", "enum": ["staging", "production"] }
        },
        "required": ["environment"]
      }
    }
  ],
  "mcp_servers": [
    { "name": "github", "type": "url", "url": "https://mcp.github.com/sse" }
  ],
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ],
  "callable_agents": [
    { "type": "agent", "id": "agent_yyy" }
  ],
  "model_card_id": "mc_xxx",
  "harness": "default",
  "metadata": {
    "team": "platform",
    "owner": "alice"
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Display name for the agent |
| `description` | string | No | Human-readable description |
| `model` | string or object | Yes | Model identifier (e.g. `"claude-sonnet-4-6"`) or `{ id, speed }` |
| `system` | string | Yes | System prompt — defines the agent's behavior and persona |
| `tools` | array | No | Tool configurations (toolsets, custom tools) |
| `mcp_servers` | array | No | External MCP server connections |
| `skills` | array | No | Skill references to mount into the sandbox |
| `callable_agents` | array | No | Other agents this agent can delegate to |
| `model_card_id` | string | No | Reference to a model card for custom provider config |
| `harness` | string | No | Harness implementation to use (default: `"default"`) |
| `metadata` | object | No | Arbitrary key-value metadata |

---

## Tools

### Built-in Toolset

The `agent_toolset_20260401` provides 8 tools designed for general-purpose agent work:

| Tool | Description | Key Behaviors |
|---|---|---|
| **bash** | Execute shell commands | 2min default timeout, 10min max. Auto-backgrounds long-running processes. SIGTERM on timeout. |
| **read** | Read files | Returns file content with line numbers. Handles binary detection. |
| **write** | Write files | Creates parent directories automatically. |
| **edit** | String replacement | Surgical find-and-replace. Fails if `old_str` not found or ambiguous. |
| **glob** | File search | Pattern matching (e.g. `**/*.ts`). Returns sorted file list. |
| **grep** | Content search | Regex search across files. Returns matching lines with context. |
| **web_fetch** | HTTP fetch | GET requests with HTML-to-text extraction. Max 50KB result. |
| **web_search** | Web search | Search via Tavily API. Requires `TAVILY_API_KEY`. |

### Tool Configuration

Enable or disable individual tools:

```json
{
  "type": "agent_toolset_20260401",
  "default_config": { "enabled": false },
  "configs": [
    { "name": "bash", "enabled": true },
    { "name": "read", "enabled": true },
    { "name": "write", "enabled": true },
    { "name": "edit", "enabled": true }
  ]
}
```

Set permission policies:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    {
      "name": "bash",
      "enabled": true,
      "permission_policy": { "type": "always_ask" }
    }
  ]
}
```

### Custom Tools

Define tools with JSON Schema input validation. Custom tools pause the session with `stop_reason: { type: "requires_action", action_type: "custom_tool_result" }` and wait for the client to provide the result:

```json
{
  "type": "custom",
  "name": "send_email",
  "description": "Send an email to a user",
  "input_schema": {
    "type": "object",
    "properties": {
      "to": { "type": "string" },
      "subject": { "type": "string" },
      "body": { "type": "string" }
    },
    "required": ["to", "subject", "body"]
  }
}
```

### Derived Tools

These tools are automatically generated based on session configuration:

| Tool | Generated When | Purpose |
|---|---|---|
| `memory_list` | Memory store attached | List memories in a store |
| `memory_search` | Memory store attached | Semantic search over memories |
| `memory_read` | Memory store attached | Read a specific memory |
| `memory_write` | Memory store attached | Create or update a memory |
| `memory_delete` | Memory store attached | Delete a memory |
| `call_agent_*` | `callable_agents` configured | Delegate work to another agent |
| `mcp_*` | `mcp_servers` configured | Call MCP server tools |

---

## Sessions

### Session Lifecycle

```
  POST /v1/sessions          POST /events            Harness completes
         │                        │                        │
    ┌────▼────┐             ┌─────▼─────┐           ┌─────▼─────┐
    │  idle    │────────────►│  running   │──────────►│   idle     │
    └─────────┘             └─────┬─────┘           └───────────┘
                                  │
                            (on crash)
                                  │
                            ┌─────▼─────┐
                            │   idle     │  + session.error event
                            └───────────┘
```

- **idle** — Waiting for user input
- **running** — Harness is actively processing (model calls, tool execution)
- **rescheduled** — Container is being provisioned; will resume automatically
- **terminated** — Session ended (explicit termination or error)

### Event Types

Sessions communicate through a typed event log. Events fall into four categories:

**User events** (sent by the client):

| Event | Description |
|---|---|
| `user.message` | User sends a message (text, images, documents) |
| `user.interrupt` | User interrupts a running agent |
| `user.tool_confirmation` | User allows or denies a tool call |
| `user.custom_tool_result` | User provides result for a custom tool |
| `user.define_outcome` | User defines success criteria for evaluation |

**Agent events** (emitted by the harness):

| Event | Description |
|---|---|
| `agent.message` | Agent text response |
| `agent.thinking` | Agent thinking/reasoning |
| `agent.tool_use` | Agent calls a built-in tool |
| `agent.tool_result` | Result from a tool execution |
| `agent.custom_tool_use` | Agent calls a custom tool (pauses session) |
| `agent.mcp_tool_use` | Agent calls an MCP server tool |
| `agent.mcp_tool_result` | Result from an MCP tool |

**Session events** (lifecycle signals):

| Event | Description |
|---|---|
| `session.status_running` | Harness started processing |
| `session.status_idle` | Harness finished; includes `stop_reason` |
| `session.status_rescheduled` | Waiting for container provisioning |
| `session.status_terminated` | Session ended |
| `session.error` | Error occurred (may be retryable) |

**Observability events** (spans):

| Event | Description |
|---|---|
| `span.model_request_start` | Model API call started |
| `span.model_request_end` | Model API call completed (includes token usage) |
| `span.outcome_evaluation_start` | Outcome evaluation began |

### Streaming

Sessions support real-time SSE streaming:

```bash
# SSE stream (recommended for real-time UIs)
curl -N https://your-instance/v1/sessions/{id}/events/stream \
  -H "x-api-key: $KEY"

# JSON polling
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: application/json"

# Content negotiation
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: text/event-stream"
```

### Crash Recovery

The event log enables automatic crash recovery:

1. Harness crashes mid-execution
2. SessionDO catches the error, emits `session.error`, returns to `idle`
3. Next `user.message` creates a fresh harness instance
4. New harness reads the full event log, rebuilds context, and continues

No data is lost because events are durably written to SQLite **before** being broadcast.

---

## Environments

Environments define the sandbox where tools execute:

```json
{
  "name": "data-science",
  "config": {
    "type": "cloud",
    "packages": {
      "pip": ["numpy", "pandas", "matplotlib", "scikit-learn"],
      "apt": ["ffmpeg"]
    },
    "networking": {
      "type": "unrestricted"
    }
  }
}
```

### Package Managers

| Manager | Field | Example |
|---|---|---|
| Python (pip) | `packages.pip` | `["numpy", "pandas"]` |
| Node.js (npm) | `packages.npm` | `["lodash", "express"]` |
| System (apt) | `packages.apt` | `["ffmpeg", "imagemagick"]` |
| Rust (cargo) | `packages.cargo` | `["ripgrep"]` |
| Ruby (gem) | `packages.gem` | `["rails"]` |
| Go | `packages.go` | `["golang.org/x/tools/..."]` |

### Networking

```json
{
  "networking": {
    "type": "limited",
    "allowed_hosts": ["api.github.com", "registry.npmjs.org"],
    "allow_mcp_servers": true,
    "allow_package_managers": true
  }
}
```

### Environment Status

Environments go through a build process:

- **building** — Container image is being prepared with requested packages
- **ready** — Environment is available for use
- **error** — Build failed (check logs)

---

## Vaults & Credentials

Vaults provide secure credential management with a key design principle: **credentials never enter the sandbox**.

```bash
# Create a vault
curl -s $BASE/v1/vaults \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "production-secrets"}'

# Add a GitHub token
curl -s $BASE/v1/vaults/$VAULT_ID/credentials \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "display_name": "GitHub Token",
    "auth": {
      "type": "static_bearer",
      "mcp_server_url": "https://api.github.com",
      "token": "ghp_xxx"
    }
  }'
```

### Credential Types

| Type | Use Case | Injection Method |
|---|---|---|
| `static_bearer` | API tokens (GitHub, etc.) | `Authorization: Bearer` header on matching URLs |
| `mcp_oauth` | OAuth-authenticated MCP servers | Token refresh + injection via outbound proxy |
| `command_secret` | CLI tools (wrangler, aws) | Environment variable injection for matching commands |

### How It Works

1. Session is created with `vault_ids`
2. Sandbox makes an HTTP request (e.g., to `api.github.com`)
3. Outbound proxy intercepts the request
4. Proxy matches the URL against vault credentials
5. Proxy injects the appropriate auth header
6. Request reaches the external service with credentials
7. Sandbox never sees the raw token

---

## Memory Stores

Memory stores provide persistent, semantic memory across sessions:

```bash
# Create a memory store
curl -s $BASE/v1/memory_stores \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "project-knowledge", "description": "Learnings about the codebase"}'

# Attach to a session via resources
curl -s $BASE/v1/sessions/$SESSION_ID/resources \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"type": "memory_store", "memory_store_id": "ms_xxx"}'
```

When a memory store is attached, the agent automatically gets `memory_*` tools for reading, writing, searching, and deleting memories. Searches use embedding-based semantic similarity via Workers AI + Vectorize.

Memory items are versioned — every write creates a new version, enabling audit trails.

---

## Multi-Agent Delegation

Agents can delegate work to other agents using `callable_agents`:

```json
{
  "name": "Lead Developer",
  "model": "claude-sonnet-4-6",
  "system": "You are a lead developer. Delegate research to the researcher agent.",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "callable_agents": [
    { "type": "agent", "id": "agent_researcher" }
  ]
}
```

This generates a `call_agent_researcher` tool. When invoked, the platform:

1. Creates a child session for the target agent
2. Forwards the message
3. Waits for the child to reach `idle`
4. Returns the child's response to the parent

---

## Custom Harness

The default harness (`DefaultHarness`) handles most use cases, but you can replace it entirely:

```typescript
import type { HarnessInterface, HarnessContext } from "./harness/interface";
import { generateText } from "ai";
import { resolveModel } from "./harness/provider";

export class DataAnalysisHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, env, runtime } = ctx;

    // 1. Read conversation history
    const messages = runtime.history.getMessages();

    // 2. Custom context engineering
    //    (e.g., preserve DataFrame outputs, aggressive text compaction)
    const optimized = this.compactForDataWork(messages);

    // 3. Call the model with your strategy
    const result = await generateText({
      model: resolveModel(agent.model, env.ANTHROPIC_API_KEY),
      system: agent.system,
      messages: optimized,
      tools: ctx.tools,      // Pre-built by the platform
      maxSteps: 100,         // Data work needs more steps
    });

    // 4. Broadcast results
    for (const step of result.steps) {
      for (const content of step.content) {
        runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: content.text }],
        });
      }
    }
  }
}
```

Register it:

```typescript
import { registerHarness } from "./harness/registry";
registerHarness("data-analysis", () => new DataAnalysisHarness());
```

Use it:

```json
{ "name": "Data Analyst", "model": "claude-sonnet-4-6", "harness": "data-analysis" }
```

The platform handles everything else — tool construction, skill mounting, sandbox lifecycle, event persistence, crash recovery, and WebSocket broadcasting.

---

## Skills

Skills are reusable prompt fragments and files that get mounted into the sandbox and injected into the system prompt:

```bash
# Create a skill
curl -s $BASE/v1/skills \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "code-review",
    "type": "prompt",
    "content": "When reviewing code, check for: security vulnerabilities, performance issues, error handling gaps, and test coverage."
  }'
```

Attach skills to an agent:

```json
{
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ]
}
```

When a session starts, skills are:
1. Resolved from KV storage
2. Mounted as files in the sandbox (`/home/user/.skills/`)
3. Injected into the system prompt as additional context

---

## Model Configuration

### Direct Model Reference

```json
{ "model": "claude-sonnet-4-6" }
```

### Model with Speed Setting

```json
{ "model": { "id": "claude-sonnet-4-6", "speed": "fast" } }
```

### Model Cards

For custom providers or API configurations, use model cards:

```bash
curl -s $BASE/v1/model_cards \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "GPT-4o via proxy",
    "provider": "openai",
    "model_id": "gpt-4o",
    "base_url": "https://my-proxy.example.com/v1"
  }'
```

Reference in agent config:

```json
{ "model_card_id": "mc_xxx" }
```

Supported providers: `anthropic`, `openai`, `custom`.

---

## Session Resources

Attach external resources to a session at runtime:

### Files

```json
{
  "type": "file",
  "file_id": "file_xxx",
  "mount_path": "/home/user/data/input.csv"
}
```

### GitHub Repositories

```json
{
  "type": "github_repository",
  "repo_url": "https://github.com/owner/repo",
  "checkout": { "type": "branch", "name": "main" },
  "credential_id": "cred_xxx",
  "access": "read_write"
}
```

### Memory Stores

```json
{
  "type": "memory_store",
  "memory_store_id": "ms_xxx"
}
```

---

## Outcome Evaluation

Define success criteria and let the platform evaluate whether the agent achieved them:

```json
{
  "events": [{
    "type": "user.define_outcome",
    "description": "The test suite should pass with 100% coverage",
    "rubric": "1. All tests pass (npm test exits 0)\n2. Coverage report shows 100%\n3. No skipped tests",
    "max_iterations": 5
  }]
}
```

The platform will:
1. Run the agent
2. Evaluate the outcome against the rubric
3. If `needs_revision`, provide feedback and re-run
4. Repeat until `satisfied` or `max_iterations_reached`

Events emitted: `span.outcome_evaluation_start`, `session.outcome_evaluated`.
