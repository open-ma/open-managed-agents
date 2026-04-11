# Anthropic Managed Agents - Complete API Reference

Extracted from https://platform.claude.com/docs/en/managed-agents/ on 2026-04-10.

> **Beta**: All Managed Agents endpoints require the `managed-agents-2026-04-01` beta header.
> Research preview features additionally require `managed-agents-2026-04-01-research-preview`.
> The SDK sets these automatically.

---

## Table of Contents

1. [Overview & Core Concepts](#1-overview--core-concepts)
2. [Rate Limits](#2-rate-limits)
3. [Agents API](#3-agents-api)
4. [Environments API](#4-environments-api)
5. [Sessions API](#5-sessions-api)
6. [Events & Streaming API](#6-events--streaming-api)
7. [Tools](#7-tools)
8. [Multi-Agent Orchestration](#8-multi-agent-orchestration)
9. [Memory API](#9-memory-api)
10. [Outcomes (Define Outcomes)](#10-outcomes-define-outcomes)
11. [Cloud Container Reference](#11-cloud-container-reference)
12. [Files API (used by Outcomes)](#12-files-api-used-by-outcomes)

---

## 1. Overview & Core Concepts

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Agent** | The model, system prompt, tools, MCP servers, and skills |
| **Environment** | A configured container template (packages, network access) |
| **Session** | A running agent instance within an environment, performing a specific task and generating outputs |
| **Events** | Messages exchanged between your application and the agent (user turns, tool results, status updates) |

### How It Works

1. **Create an agent** - Define model, system prompt, tools, MCP servers, skills. Create once, reference by ID.
2. **Create an environment** - Configure cloud container with packages, network access rules, mounted files.
3. **Start a session** - Launch referencing agent and environment.
4. **Send events and stream responses** - User messages as events; Claude streams back via SSE.
5. **Steer or interrupt** - Send additional user events mid-execution.

### When to Use

- Long-running execution (minutes or hours, multiple tool calls)
- Cloud infrastructure (secure containers with packages and network)
- Minimal infrastructure (no custom agent loop/sandbox needed)
- Stateful sessions (persistent file systems and conversation history)

### Required Headers

| Header | Value |
|--------|-------|
| `x-api-key` | Your API key |
| `anthropic-version` | `2023-06-01` |
| `anthropic-beta` | `managed-agents-2026-04-01` |
| `content-type` | `application/json` |

For research preview features (outcomes, multiagent, memory):
| `anthropic-beta` | `managed-agents-2026-04-01-research-preview` |

### Branding Guidelines

**Allowed:**
- "Claude Agent" (preferred for dropdown menus)
- "Claude" (when within a menu already labeled "Agents")
- "{YourAgentName} Powered by Claude"

**Not permitted:**
- "Claude Code" or "Claude Code Agent"
- "Claude Cowork" or "Claude Cowork Agent"
- Claude Code-branded ASCII art or visual elements

---

## 2. Rate Limits

| Operation | Limit |
|-----------|-------|
| Create endpoints (agents, sessions, environments, etc.) | 60 requests per minute |
| Read endpoints (retrieve, list, stream, etc.) | 600 requests per minute |

Organization-level spend limits and tier-based rate limits also apply.

---

## 3. Agents API

### Agent Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable name |
| `model` | string or object | Yes | Claude model ID. All Claude 4.5+ models supported. Object form: `{"id": "claude-opus-4-6", "speed": "fast"}` |
| `system` | string | No | System prompt defining behavior/persona |
| `tools` | array | No | Tools available to agent. Combines pre-built agent tools, MCP tools, custom tools |
| `mcp_servers` | array | No | MCP servers for standardized third-party capabilities |
| `skills` | array | No | Skills for domain-specific context with progressive disclosure |
| `callable_agents` | array | No | Other agents this agent can invoke (multi-agent). Research preview |
| `description` | string | No | Description of what the agent does |
| `metadata` | object | No | Arbitrary key-value pairs for tracking |

### Agent Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Agent ID (e.g., `agent_01HqR2k7vXbZ9mNpL3wYcT8f`) |
| `type` | string | Always `"agent"` |
| `name` | string | Agent name |
| `model` | object | `{"id": "claude-sonnet-4-6", "speed": "standard"}` |
| `system` | string or null | System prompt |
| `description` | string or null | Description |
| `tools` | array | Configured tools |
| `skills` | array | Configured skills |
| `mcp_servers` | array | Configured MCP servers |
| `metadata` | object | Metadata key-value pairs |
| `version` | integer | Starts at 1, increments on update |
| `created_at` | string (ISO-8601) | Creation timestamp |
| `updated_at` | string (ISO-8601) | Last update timestamp |
| `archived_at` | string or null | Archive timestamp |

### Create Agent

```
POST /v1/agents
```

**Request Body:**
```json
{
  "name": "Coding Assistant",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful coding agent.",
  "tools": [{"type": "agent_toolset_20260401"}]
}
```

**Response:**
```json
{
  "id": "agent_01HqR2k7vXbZ9mNpL3wYcT8f",
  "type": "agent",
  "name": "Coding Assistant",
  "model": {"id": "claude-sonnet-4-6", "speed": "standard"},
  "system": "You are a helpful coding agent.",
  "description": null,
  "tools": [
    {
      "type": "agent_toolset_20260401",
      "default_config": {
        "permission_policy": {"type": "always_allow"}
      }
    }
  ],
  "skills": [],
  "mcp_servers": [],
  "metadata": {},
  "version": 1,
  "created_at": "2026-04-03T18:24:10.412Z",
  "updated_at": "2026-04-03T18:24:10.412Z",
  "archived_at": null
}
```

**Fast mode (Claude Opus 4.6):**
```json
{"id": "claude-opus-4-6", "speed": "fast"}
```

### Update Agent

```
POST /v1/agents/{agent_id}
```

**Request Body (partial update):**
```json
{
  "version": 1,
  "system": "You are a helpful coding agent. Always write tests."
}
```

**Update Semantics:**
- Omitted fields are preserved
- Scalar fields (`model`, `system`, `name`, etc.) are replaced. `system` and `description` can be cleared with `null`. `model` and `name` cannot be cleared.
- Array fields (`tools`, `mcp_servers`, `skills`, `callable_agents`) are fully replaced. Clear with `null` or `[]`.
- Metadata is merged at key level. Keys you provide are added/updated. Omitted keys preserved. Delete a key by setting value to `""`.
- No-op detection: if update produces no change, no new version is created.

### List Agent Versions

```
GET /v1/agents/{agent_id}/versions
```

**Response:** Paginated list of agent version objects with `version` and `updated_at`.

### Archive Agent

```
POST /v1/agents/{agent_id}/archive
```

Makes agent read-only. New sessions cannot reference it. Existing sessions continue. Response sets `archived_at`.

### Agent Lifecycle

| Operation | Behavior |
|-----------|----------|
| Update | Generates a new agent version |
| List versions | Fetch full version history |
| Archive | Read-only. No new sessions, existing continue |

---

## 4. Environments API

### Create Environment

```
POST /v1/environments
```

**Request Body:**
```json
{
  "name": "python-dev",
  "config": {
    "type": "cloud",
    "networking": {"type": "unrestricted"}
  }
}
```

The `name` must be unique within your organization and workspace.

### Environment Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"cloud"` |
| `packages` | object | Pre-installed packages by manager |
| `networking` | object | Network access configuration |

### Packages Configuration

| Field | Package Manager | Example |
|-------|----------------|---------|
| `apt` | System packages (apt-get) | `"ffmpeg"` |
| `cargo` | Rust (cargo) | `"ripgrep@14.0.0"` |
| `gem` | Ruby (gem) | `"rails:7.1.0"` |
| `go` | Go modules | `"golang.org/x/tools/cmd/goimports@latest"` |
| `npm` | Node.js (npm) | `"express@4.18.0"` |
| `pip` | Python (pip) | `"pandas==2.2.0"` |

When multiple package managers are specified, they run in alphabetical order (apt, cargo, gem, go, npm, pip). Optionally pin specific versions; default is latest.

**Example:**
```json
{
  "type": "cloud",
  "packages": {
    "pip": ["pandas", "numpy", "scikit-learn"],
    "npm": ["express"]
  },
  "networking": {"type": "unrestricted"}
}
```

### Networking Configuration

| Mode | Description |
|------|-------------|
| `unrestricted` | Full outbound network access (except safety blocklist). **Default.** |
| `limited` | Restricts container network to `allowed_hosts` list |

**Limited networking fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"limited"` |
| `allowed_hosts` | string[] | Domains the container can reach (must be HTTPS-prefixed) |
| `allow_mcp_servers` | boolean | Permit outbound access to configured MCP server endpoints. Default `false` |
| `allow_package_managers` | boolean | Permit outbound access to public package registries. Default `false` |

**Example:**
```json
{
  "type": "cloud",
  "networking": {
    "type": "limited",
    "allowed_hosts": ["api.example.com"],
    "allow_mcp_servers": true,
    "allow_package_managers": true
  }
}
```

> Note: The `networking` field does not impact the `web_search` or `web_fetch` tools' allowed domains.

### Use Environment in Session

```
POST /v1/sessions
```

```json
{
  "agent": "{agent_id}",
  "environment_id": "{environment_id}"
}
```

### List Environments

```
GET /v1/environments
```

### Retrieve Environment

```
GET /v1/environments/{environment_id}
```

### Archive Environment

```
POST /v1/environments/{environment_id}/archive
```

Read-only. Existing sessions continue.

### Delete Environment

```
DELETE /v1/environments/{environment_id}
```

Only if no sessions reference it.

### Environment Lifecycle

- Environments persist until explicitly archived or deleted
- Multiple sessions can reference the same environment
- Each session gets its own container instance (no shared file system)
- Environments are not versioned

---

## 5. Sessions API

### Create Session

```
POST /v1/sessions
```

**Request Body:**
```json
{
  "agent": "{agent_id}",
  "environment_id": "{environment_id}",
  "title": "Quickstart session"
}
```

**Session Create Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent ID |
| `environment_id` | string | Yes | Environment ID |
| `title` | string | No | Human-readable title |
| `resources` | array | No | Attached resources (e.g., memory stores) |

**Response includes:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Session ID (e.g., `sesn_01...`) |
| `status` | string | `idle`, `running`, `rescheduled`, `terminated` |
| `usage` | object | Cumulative token statistics |
| `outcome_evaluations` | array | Outcome evaluation results (if outcomes used) |

### Retrieve Session

```
GET /v1/sessions/{session_id}
```

### Session Usage Object

```json
{
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 3200,
    "cache_creation_input_tokens": 2000,
    "cache_read_input_tokens": 20000
  }
}
```

- `input_tokens`: uncached input tokens
- `output_tokens`: total output tokens across all model calls
- `cache_creation_input_tokens` / `cache_read_input_tokens`: prompt caching (5-minute TTL)

---

## 6. Events & Streaming API

### Event Types

Events follow `{domain}.{action}` naming convention. Every event includes `processed_at` (timestamp, null if queued).

#### User Events (sent by you)

| Type | Description |
|------|-------------|
| `user.message` | User message with text content |
| `user.interrupt` | Stop agent mid-execution |
| `user.custom_tool_result` | Response to a custom tool call |
| `user.tool_confirmation` | Approve or deny tool call when permission policy requires confirmation |
| `user.define_outcome` | Define an outcome for the agent (research preview) |

#### Agent Events (received)

| Type | Description |
|------|-------------|
| `agent.message` | Agent response containing text content blocks |
| `agent.thinking` | Agent thinking content (separate from messages) |
| `agent.tool_use` | Agent invoked a pre-built agent tool |
| `agent.tool_result` | Result of a pre-built agent tool execution |
| `agent.mcp_tool_use` | Agent invoked an MCP server tool |
| `agent.mcp_tool_result` | Result of an MCP tool execution |
| `agent.custom_tool_use` | Agent invoked a custom tool. Respond with `user.custom_tool_result` |
| `agent.thread_context_compacted` | Conversation history was compacted to fit context window |
| `agent.thread_message_sent` | Agent sent message to another multiagent thread |
| `agent.thread_message_received` | Agent received message from another multiagent thread |

#### Session Events (received)

| Type | Description |
|------|-------------|
| `session.status_running` | Agent is actively processing |
| `session.status_idle` | Agent finished, waiting for input. Includes `stop_reason` |
| `session.status_rescheduled` | Transient error, session retrying automatically |
| `session.status_terminated` | Session ended due to unrecoverable error |
| `session.error` | Error occurred. Includes typed `error` object with `retry_status` |
| `session.outcome_evaluated` | Outcome evaluation reached terminal status |
| `session.thread_created` | Coordinator spawned new multiagent thread |
| `session.thread_idle` | A multiagent thread finished its current work |

#### Span Events (received, observability)

| Type | Description |
|------|-------------|
| `span.model_request_start` | Model inference call started |
| `span.model_request_end` | Model inference call completed. Includes `model_usage` with token counts |
| `span.outcome_evaluation_start` | Outcome evaluation started |
| `span.outcome_evaluation_ongoing` | Heartbeat during outcome evaluation |
| `span.outcome_evaluation_end` | Outcome evaluation completed |

### Send Events

```
POST /v1/sessions/{session_id}/events
```

**Request Body:**
```json
{
  "events": [
    {
      "type": "user.message",
      "content": [
        {"type": "text", "text": "Create a Python script..."}
      ]
    }
  ]
}
```

**Interrupt + redirect:**
```json
{
  "events": [
    {"type": "user.interrupt"},
    {
      "type": "user.message",
      "content": [
        {"type": "text", "text": "Instead, focus on fixing the bug in line 42."}
      ]
    }
  ]
}
```

### Stream Events (SSE)

```
GET /v1/sessions/{session_id}/stream
```

Headers: `Accept: text/event-stream`

Returns Server-Sent Events. Only events emitted after stream is opened are delivered. Open stream before sending events to avoid race condition.

### List Past Events

```
GET /v1/sessions/{session_id}/events
```

Returns paginated list of all session events.

### Stop Reason Types

The `session.status_idle` event includes a `stop_reason`:

| Stop Reason Type | Description |
|-----------------|-------------|
| `end_turn` | Agent naturally completed its work |
| `requires_action` | Agent needs client action. Contains `event_ids` array |

**`requires_action` structure:**
```json
{
  "type": "session.status_idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["sevt_01..."]
  }
}
```

### Custom Tool Call Flow

1. Session emits `agent.custom_tool_use` event (tool name + input)
2. Session pauses with `session.status_idle` + `stop_reason: requires_action`
3. You execute tool and send `user.custom_tool_result`:

```json
{
  "events": [
    {
      "type": "user.custom_tool_result",
      "custom_tool_use_id": "{event_id}",
      "content": [{"type": "text", "text": "{result}"}]
    }
  ]
}
```

4. Session resumes to `running`

### Tool Confirmation Flow

1. Session emits `agent.tool_use` or `agent.mcp_tool_use`
2. Session pauses with `session.status_idle` + `stop_reason: requires_action`
3. Send `user.tool_confirmation`:

```json
{
  "events": [
    {
      "type": "user.tool_confirmation",
      "tool_use_id": "{event_id}",
      "result": "allow"
    }
  ]
}
```

Or deny:
```json
{
  "type": "user.tool_confirmation",
  "tool_use_id": "{event_id}",
  "result": "deny",
  "deny_message": "Reason for denial"
}
```

4. Session resumes to `running`

### Reconnection Pattern

1. Open a new SSE stream
2. List full history to seed seen event IDs
3. Tail live stream while skipping already-seen events

---

## 7. Tools

### Available Built-in Tools

| Tool | Name | Description |
|------|------|-------------|
| Bash | `bash` | Execute bash commands in a shell session |
| Read | `read` | Read a file from the local filesystem |
| Write | `write` | Write a file to the local filesystem |
| Edit | `edit` | Perform string replacement in a file |
| Glob | `glob` | Fast file pattern matching using glob patterns |
| Grep | `grep` | Text search using regex patterns |
| Web fetch | `web_fetch` | Fetch content from a URL |
| Web search | `web_search` | Search the web for information |

All are enabled by default when `agent_toolset_20260401` is included.

### Agent Toolset Configuration

**Full toolset:**
```json
{
  "type": "agent_toolset_20260401"
}
```

**With per-tool config overrides:**
```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    {"name": "web_fetch", "enabled": false},
    {"name": "web_search", "enabled": false}
  ]
}
```

**Enable only specific tools (default off):**
```json
{
  "type": "agent_toolset_20260401",
  "default_config": {"enabled": false},
  "configs": [
    {"name": "bash", "enabled": true},
    {"name": "read", "enabled": true},
    {"name": "write", "enabled": true}
  ]
}
```

### Toolset Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"agent_toolset_20260401"` |
| `default_config` | object | Default config applied to all tools |
| `default_config.enabled` | boolean | Enable/disable all tools by default |
| `default_config.permission_policy` | object | Default permission policy |
| `configs` | array | Per-tool configuration overrides |
| `configs[].name` | string | Tool name (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`) |
| `configs[].enabled` | boolean | Enable/disable this specific tool |

### Custom Tools

```json
{
  "type": "custom",
  "name": "get_weather",
  "description": "Get current weather for a location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {"type": "string", "description": "City name"}
    },
    "required": ["location"]
  }
}
```

**Custom Tool Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `"custom"` |
| `name` | string | Yes | Tool name |
| `description` | string | Yes | What the tool does (aim for 3-4+ sentences) |
| `input_schema` | object | Yes | JSON Schema for tool input |

**Best practices:**
- Provide extremely detailed descriptions (most important factor)
- Consolidate related operations into fewer tools (use `action` parameter)
- Use meaningful namespacing in tool names (e.g., `db_query`, `storage_read`)
- Return only high-signal information in tool responses

---

## 8. Multi-Agent Orchestration

> Research Preview feature. Requires access request.

### How It Works

- All agents share the same container and filesystem
- Each agent runs in its own session **thread** (context-isolated event stream with own history)
- Coordinator operates in the **primary thread** (same as session-level event stream)
- Additional threads spawned at runtime when coordinator delegates
- Threads are persistent (follow-ups retain previous turns)
- Each agent uses its own configuration (model, system, tools, MCP servers, skills)
- Tools and context are NOT shared between agents
- Only one level of delegation: coordinator can call agents, but those agents cannot call further agents

### Callable Agents Configuration

```json
{
  "callable_agents": [
    {"type": "agent", "id": "{agent_id}", "version": 1},
    {"type": "agent", "id": "{agent_id}", "version": 2}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"agent"` |
| `id` | string | ID of an existing agent |
| `version` | integer | Agent version to use |

### Session Threads

**List threads:**
```
GET /v1/sessions/{session_id}/threads
```

Thread object fields:
- `session_thread_id`
- `agent_name`
- `status`
- `model`

**Stream thread events:**
```
GET /v1/sessions/{session_id}/threads/{thread_id}/stream
```

**List thread events:**
```
GET /v1/sessions/{session_id}/threads/{thread_id}/events
```

### Multiagent Event Types

| Type | Description |
|------|-------------|
| `session.thread_created` | Coordinator spawned a new thread. Includes `session_thread_id` and `model` |
| `session.thread_idle` | An agent thread finished its current work |
| `agent.thread_message_sent` | Agent sent message to another thread. Includes `to_thread_id` and `content` |
| `agent.thread_message_received` | Agent received message from another thread. Includes `from_thread_id` and `content` |

### Thread Routing for Tool Permissions and Custom Tools

When a callable_agent thread needs permission or a custom tool result:
- Request surfaces on the **session stream** with a `session_thread_id` field
- Include the same `session_thread_id` when posting your response
- If `session_thread_id` is present: event from subagent thread (echo it on reply)
- If `session_thread_id` is absent: event from primary thread (reply without it)
- Match on `tool_use_id` to pair requests with responses

**Example with thread routing:**
```json
{
  "type": "user.tool_confirmation",
  "tool_use_id": "{event_id}",
  "result": "allow",
  "session_thread_id": "{thread_id}"
}
```

---

## 9. Memory API

> Research Preview feature. Requires access request.

### Overview

- **Memory store**: workspace-scoped collection of text documents
- **Memory**: individual document in a store (capped at **100KB / ~25K tokens**)
- **Memory version**: immutable audit record of each mutation (`memver_...`)
- Agent automatically checks stores before starting and writes learnings when done
- Maximum **8 memory stores** per session

### Create Memory Store

```
POST /v1/memory_stores
```

**Request Body:**
```json
{
  "name": "User Preferences",
  "description": "Per-user preferences and project context."
}
```

**Response includes:**
- `id` (e.g., `memstore_01Hx...`)

### Write/Create a Memory

```
POST /v1/memory_stores/{store_id}/memories
```

**Request Body:**
```json
{
  "path": "/formatting_standards.md",
  "content": "All reports use GAAP formatting. Dates are ISO-8601..."
}
```

Upsert by path: creates if not exists, replaces if exists.

**Safe write (create-only guard):**
```json
{
  "path": "/preferences/formatting.md",
  "content": "Always use 2-space indentation.",
  "precondition": {"type": "not_exists"}
}
```

Returns `409 memory_precondition_failed` if memory already exists at path.

### Read a Memory

```
GET /v1/memory_stores/{store_id}/memories/{memory_id}
```

Returns full content.

### List Memories

```
GET /v1/memory_stores/{store_id}/memories?path_prefix=/
```

Returns metadata only (not content). Use `path_prefix` with trailing slash for directory-scoped lists.

**Memory object fields:**
- `path`
- `size_bytes`
- `content_sha256`

### Update a Memory

```
PATCH /v1/memory_stores/{store_id}/memories/{memory_id}
```

**Request Body:**
```json
{
  "path": "/archive/2026_q1_formatting.md"
}
```

Can change `content`, `path` (rename), or both. Renaming onto an occupied path returns `409 conflict`.

**Safe content edit (optimistic concurrency):**
```json
{
  "content": "CORRECTED: Always use 2-space indentation.",
  "precondition": {"type": "content_sha256", "content_sha256": "{sha256_hash}"}
}
```

Returns `409 memory_precondition_failed` on hash mismatch.

### Delete a Memory

```
DELETE /v1/memory_stores/{store_id}/memories/{memory_id}
```

Optionally pass `expected_content_sha256` for conditional delete.

### Attach Memory Store to Session

```
POST /v1/sessions
```

```json
{
  "agent": "{agent_id}",
  "environment_id": "{environment_id}",
  "resources": [
    {
      "type": "memory_store",
      "memory_store_id": "{store_id}",
      "access": "read_write",
      "prompt": "User preferences and project context. Check before starting any task."
    }
  ]
}
```

**Resource fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"memory_store"` |
| `memory_store_id` | string | Store ID |
| `access` | string | `"read_write"` (default) or `"read_only"` |
| `prompt` | string | Session-specific instructions for using this store (max 4,096 characters) |

### Memory Tools (auto-attached when memory stores are present)

| Tool | Description |
|------|-------------|
| `memory_list` | List memories, optionally filtered by path prefix |
| `memory_search` | Full-text search across memory contents |
| `memory_read` | Read a memory's contents |
| `memory_write` | Create or overwrite a memory at a path |
| `memory_edit` | Modify an existing memory |
| `memory_delete` | Remove a memory |

### Memory Versions (Audit)

Every mutation creates an immutable memory version (`memver_...`).

**Version operations:**
- First `write`: `operation: "created"`
- `update` (content/path change): `operation: "modified"`
- `delete`: `operation: "deleted"`

#### List Versions

```
GET /v1/memory_stores/{store_id}/memory_versions?memory_id={mem_id}
```

Paginated, newest-first. Filter by:
- `memory_id`
- `operation` (`created`, `modified`, `deleted`)
- `session_id`
- `api_key_id`
- `created_at_gte` / `created_at_lte` time range

List response does NOT include `content` body.

#### Retrieve a Version

```
GET /v1/memory_stores/{store_id}/memory_versions/{version_id}
```

Returns full content body.

#### Redact a Version

```
POST /v1/memory_stores/{store_id}/memory_versions/{version_id}/redact
```

Scrubs content while preserving audit trail. Hard clears: `content`, `content_sha256`, `content_size_bytes`, `path`. Preserves: actor, timestamps, all other fields.

### Precondition Types

| Type | Fields | Description |
|------|--------|-------------|
| `not_exists` | `type` only | Fail if memory already exists at path |
| `content_sha256` | `type`, `content_sha256` | Fail if stored hash doesn't match |

---

## 10. Outcomes (Define Outcomes)

> Research Preview feature. Requires access request.
> Requires beta header: `managed-agents-2026-04-01-research-preview`

### Overview

- Elevates a session from conversation to work
- Define what end result should look like and how to measure quality
- Harness provisions a separate **grader** (separate context window)
- Grader returns per-criterion breakdown
- Feedback loops back to agent for iteration

### Rubric

Required. Markdown document describing per-criterion scoring. Structure as explicit, gradeable criteria.

**Upload via Files API:**

```
POST /v1/files
```

Requires beta header: `files-api-2025-04-14`

### user.define_outcome Event

```json
{
  "type": "user.define_outcome",
  "description": "Build a DCF model for Costco in .xlsx",
  "rubric": {"type": "text", "content": "# DCF Model Rubric\n..."},
  "max_iterations": 5
}
```

Or with file:
```json
{
  "rubric": {"type": "file", "file_id": "file_01..."}
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `"user.define_outcome"` |
| `description` | string | Yes | What to build |
| `rubric` | object | Yes | Rubric as text or file reference |
| `rubric.type` | string | Yes | `"text"` or `"file"` |
| `rubric.content` | string | Yes (if text) | Inline rubric content |
| `rubric.file_id` | string | Yes (if file) | File API file ID |
| `max_iterations` | integer | No | Default 3, max 20 |

Only one outcome at a time. Chain outcomes by sending new `user.define_outcome` after previous completes.

### Outcome Events

#### span.outcome_evaluation_start

```json
{
  "type": "span.outcome_evaluation_start",
  "id": "sevt_01def...",
  "outcome_id": "outc_01a...",
  "iteration": 0,
  "processed_at": "2026-03-25T14:01:45Z"
}
```

- `iteration`: 0-indexed. 0 = first evaluation, 1 = re-evaluation after first revision.

#### span.outcome_evaluation_ongoing

```json
{
  "type": "span.outcome_evaluation_ongoing",
  "id": "sevt_01ghi...",
  "outcome_id": "outc_01a...",
  "processed_at": "2026-03-25T14:02:10Z"
}
```

Heartbeat while grader runs. Grader reasoning is opaque.

#### span.outcome_evaluation_end

```json
{
  "type": "span.outcome_evaluation_end",
  "id": "sevt_01jkl...",
  "outcome_evaluation_start_id": "sevt_01def...",
  "outcome_id": "outc_01a...",
  "result": "satisfied",
  "explanation": "All 12 criteria met...",
  "iteration": 0,
  "usage": {
    "input_tokens": 2400,
    "output_tokens": 350,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 1800
  },
  "processed_at": "2026-03-25T14:03:00Z"
}
```

**Result values:**

| Result | Next |
|--------|------|
| `satisfied` | Session transitions to `idle` |
| `needs_revision` | Agent starts a new iteration cycle |
| `max_iterations_reached` | No further evaluation. Agent may run one final revision before `idle` |
| `failed` | Session transitions to `idle`. Rubric doesn't match task |
| `interrupted` | Only emitted if `outcome_evaluation_start` already fired before interrupt |

### Check Outcome Status

```
GET /v1/sessions/{session_id}
```

Read `outcome_evaluations[].result`:
```json
{
  "outcome_evaluations": [
    {
      "outcome_id": "outc_01a...",
      "result": "satisfied"
    }
  ]
}
```

### Retrieving Deliverables

Agent writes output files to `/mnt/session/outputs/` inside container.

**List files:**
```
GET /v1/files?scope_id={session_id}
```

Requires beta header: `files-api-2025-04-14,managed-agents-2026-04-01-research-preview`

**Download file:**
```
GET /v1/files/{file_id}/content
```

---

## 11. Cloud Container Reference

### Programming Languages

| Language | Version | Package Manager |
|----------|---------|-----------------|
| Python | 3.12+ | pip, uv |
| Node.js | 20+ | npm, yarn, pnpm |
| Go | 1.22+ | go modules |
| Rust | 1.77+ | cargo |
| Java | 21+ | maven, gradle |
| Ruby | 3.3+ | bundler, gem |
| PHP | 8.3+ | composer |
| C/C++ | GCC 13+ | make, cmake |

### Databases

| Database | Description |
|----------|-------------|
| SQLite | Pre-installed, available immediately |
| PostgreSQL client | `psql` client for connecting to external databases |
| Redis client | `redis-cli` for connecting to external instances |

> Database servers (PostgreSQL, Redis, etc.) are NOT running by default. Container includes client tools only. SQLite is fully available.

### System Tools

- `git` - Version control
- `curl`, `wget` - HTTP clients
- `jq` - JSON processing
- `tar`, `zip`, `unzip` - Archive tools
- `ssh`, `scp` - Remote access (requires network enabled)
- `tmux`, `screen` - Terminal multiplexers

### Development Tools

- `make`, `cmake` - Build systems
- `docker` - Container management (limited availability)
- `ripgrep` (`rg`) - Fast file search
- `tree` - Directory visualization
- `htop` - Process monitoring

### Text Processing

- `sed`, `awk`, `grep` - Stream editors
- `vim`, `nano` - Text editors
- `diff`, `patch` - File comparison

### Container Specifications

| Property | Value |
|----------|-------|
| Operating system | Ubuntu 22.04 LTS |
| Architecture | x86_64 (amd64) |
| Memory | Up to 8 GB |
| Disk space | Up to 10 GB |
| Network | Disabled by default (enable in environment config) |

---

## 12. Files API (used by Outcomes)

Requires beta header: `files-api-2025-04-14`

### Upload File

```
POST /v1/files
```

Multipart form upload. Used for rubric files in outcomes.

### List Files

```
GET /v1/files?scope_id={session_id}
```

### Download File

```
GET /v1/files/{file_id}/content
```

---

## Complete API Endpoint Summary

### Agents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/agents` | Create agent |
| POST | `/v1/agents/{id}` | Update agent |
| GET | `/v1/agents/{id}` | Retrieve agent |
| GET | `/v1/agents` | List agents |
| GET | `/v1/agents/{id}/versions` | List agent versions |
| POST | `/v1/agents/{id}/archive` | Archive agent |

### Environments

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/environments` | Create environment |
| GET | `/v1/environments` | List environments |
| GET | `/v1/environments/{id}` | Retrieve environment |
| POST | `/v1/environments/{id}/archive` | Archive environment |
| DELETE | `/v1/environments/{id}` | Delete environment |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/sessions` | Create session |
| GET | `/v1/sessions/{id}` | Retrieve session |

### Session Events

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/sessions/{id}/events` | Send events |
| GET | `/v1/sessions/{id}/events` | List past events |
| GET | `/v1/sessions/{id}/stream` | Stream events (SSE) |

### Session Threads (Multiagent)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/sessions/{id}/threads` | List threads |
| GET | `/v1/sessions/{id}/threads/{thread_id}/stream` | Stream thread events |
| GET | `/v1/sessions/{id}/threads/{thread_id}/events` | List thread events |

### Memory Stores

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/memory_stores` | Create memory store |
| GET | `/v1/memory_stores/{id}` | Retrieve memory store |
| GET | `/v1/memory_stores` | List memory stores |

### Memories

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/memory_stores/{store_id}/memories` | Write/create memory (upsert by path) |
| GET | `/v1/memory_stores/{store_id}/memories` | List memories |
| GET | `/v1/memory_stores/{store_id}/memories/{mem_id}` | Retrieve memory |
| PATCH | `/v1/memory_stores/{store_id}/memories/{mem_id}` | Update memory |
| DELETE | `/v1/memory_stores/{store_id}/memories/{mem_id}` | Delete memory |

### Memory Versions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/memory_stores/{store_id}/memory_versions` | List versions |
| GET | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}` | Retrieve version |
| POST | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}/redact` | Redact version |

### Files

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/files` | Upload file |
| GET | `/v1/files` | List files |
| GET | `/v1/files/{id}/content` | Download file |

---

## ID Prefixes

| Resource | Prefix | Example |
|----------|--------|---------|
| Agent | `agent_` | `agent_01HqR2k7vXbZ9mNpL3wYcT8f` |
| Environment | (varies) | - |
| Session | `sesn_` | `sesn_01...` |
| Session Event | `sevt_` | `sevt_01def...` |
| Memory Store | `memstore_` | `memstore_01Hx...` |
| Memory | `mem_` | `mem_...` |
| Memory Version | `memver_` | `memver_...` |
| Outcome | `outc_` | `outc_01a...` |
| File | `file_` | `file_01...` |
| Session Thread | (varies) | - |
