# Gap Analysis: Open Managed Agents vs Anthropic Managed Agents API

Generated: 2026-04-10

This document compares our implementation against Anthropic's official Managed Agents API specification (scraped 2026-04-10) endpoint by endpoint, field by field.

Severity levels:
- **CRITICAL**: Would break compatibility with Anthropic SDKs
- **IMPORTANT**: Feature gap but not SDK-breaking
- **MINOR**: Nice-to-have alignment

---

## 1. Missing Endpoints

### 1.1 Agents API

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `POST /v1/agents` | `POST /v1/agents` | Implemented | - |
| `POST /v1/agents/{id}` (update) | `PUT /v1/agents/{id}` | **Wrong HTTP method** | CRITICAL |
| `GET /v1/agents/{id}` | `GET /v1/agents/{id}` | Implemented | - |
| `GET /v1/agents` | `GET /v1/agents` | Implemented | - |
| `GET /v1/agents/{id}/versions` | `GET /v1/agents/{id}/versions` | Implemented | - |
| `POST /v1/agents/{id}/archive` | `POST /v1/agents/{id}/archive` | Implemented | - |

**Gaps:**

- **CRITICAL**: Anthropic uses `POST /v1/agents/{id}` for updates; we use `PUT /v1/agents/{id}`. SDKs will send POST and get 404/405.
- **MINOR**: We have `DELETE /v1/agents/{id}` and `GET /v1/agents/{id}/versions/{version}` which Anthropic does not document. These are extensions, not gaps.

### 1.2 Environments API

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `POST /v1/environments` | `POST /v1/environments` | Implemented | - |
| `GET /v1/environments` | `GET /v1/environments` | Implemented | - |
| `GET /v1/environments/{id}` | `GET /v1/environments/{id}` | Implemented | - |
| `POST /v1/environments/{id}/archive` | `POST /v1/environments/{id}/archive` | Implemented | - |
| `DELETE /v1/environments/{id}` | `DELETE /v1/environments/{id}` | Implemented | - |

No missing endpoints. We have extra: `PUT /v1/environments/{id}` (update) and `POST /v1/environments/{id}/build-complete` (internal callback). These are extensions.

### 1.3 Sessions API

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `POST /v1/sessions` | `POST /v1/sessions` | Implemented | - |
| `GET /v1/sessions/{id}` | `GET /v1/sessions/{id}` | Implemented | - |
| `POST /v1/sessions/{id}/events` | `POST /v1/sessions/{id}/events` | Implemented | - |
| `GET /v1/sessions/{id}/events` | `GET /v1/sessions/{id}/events` | Implemented | - |
| `GET /v1/sessions/{id}/stream` | `GET /v1/sessions/{id}/events/stream` | **Path mismatch** | CRITICAL |

**Gaps:**

- **CRITICAL**: Anthropic's SSE streaming endpoint is `GET /v1/sessions/{id}/stream`. We serve it at `GET /v1/sessions/{id}/events/stream`. SDKs will hit the wrong path. We also support SSE via `Accept: text/event-stream` on the `/events` path, but the dedicated `/stream` path is missing.
- **MINOR**: Anthropic does not document `GET /v1/sessions` (list sessions), `POST /v1/sessions/{id}` (update session), `POST /v1/sessions/{id}/archive`, or `DELETE /v1/sessions/{id}`. Our extras are fine as extensions.

### 1.4 Session Threads (Multi-Agent)

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `GET /v1/sessions/{id}/threads` | **Missing** | Not implemented | IMPORTANT |
| `GET /v1/sessions/{id}/threads/{thread_id}/stream` | **Missing** | Not implemented | IMPORTANT |
| `GET /v1/sessions/{id}/threads/{thread_id}/events` | **Missing** | Not implemented | IMPORTANT |

**Gaps:**

- **IMPORTANT**: All three thread management endpoints are missing. We have multi-agent delegation via `call_agent_*` tools, but no API endpoints to list threads, stream thread events, or list thread events. Multi-agent is a research preview feature, so this is not SDK-breaking for GA, but blocks multi-agent SDK usage.

### 1.5 Memory API

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `POST /v1/memory_stores` | `POST /v1/memory_stores` | Implemented | - |
| `GET /v1/memory_stores/{id}` | `GET /v1/memory_stores/{id}` | Implemented | - |
| `GET /v1/memory_stores` | `GET /v1/memory_stores` | Implemented | - |
| `POST /v1/memory_stores/{id}/memories` | `POST /v1/memory_stores/{id}/memories` | Implemented | - |
| `GET /v1/memory_stores/{id}/memories` | `GET /v1/memory_stores/{id}/memories` | Implemented | - |
| `GET /v1/memory_stores/{id}/memories/{id}` | `GET /v1/memory_stores/{id}/memories/{id}` | Implemented | - |
| `PATCH /v1/memory_stores/{id}/memories/{id}` | `POST /v1/memory_stores/{id}/memories/{id}` | **Wrong HTTP method** | CRITICAL |
| `DELETE /v1/memory_stores/{id}/memories/{id}` | `DELETE /v1/memory_stores/{id}/memories/{id}` | Implemented | - |
| `GET .../memory_versions` | `GET .../memory_versions` | Implemented | - |
| `GET .../memory_versions/{id}` | `GET .../memory_versions/{id}` | Implemented | - |
| `POST .../memory_versions/{id}/redact` | `POST .../memory_versions/{id}/redact` | Implemented | - |

**Gaps:**

- **CRITICAL**: Anthropic uses `PATCH` for memory updates; we use `POST`. SDKs will send PATCH and get 404/405.

### 1.6 Files API

| Anthropic Endpoint | Our Endpoint | Status | Severity |
|---|---|---|---|
| `POST /v1/files` | `POST /v1/files` | Implemented (JSON, not multipart) | IMPORTANT |
| `GET /v1/files` | `GET /v1/files` | Implemented | - |
| `GET /v1/files/{id}/content` | `GET /v1/files/{id}/content` | Implemented | - |

**Gaps:**

- **IMPORTANT**: Anthropic specifies multipart form upload for `POST /v1/files`. We accept JSON body with `{filename, content}`. SDKs using multipart upload will fail.
- **MINOR**: Anthropic uses `files-api-2025-04-14` beta header. We don't check beta headers at all (which is fine for an open implementation, but worth noting).

### 1.7 Vaults & Credentials API

- **Not in Anthropic's spec**: Our Vaults and Credentials API (`/v1/vaults`, `/v1/vaults/{id}/credentials`) is a custom extension. Anthropic does not document vault/credential management endpoints. This is fine -- it's our value-add for self-hosted credential management.

### 1.8 Skills API

- **Not in Anthropic's spec as separate endpoints**: Anthropic references skills as a field on the Agent config but does not expose dedicated CRUD endpoints for skills. Our `/v1/skills` endpoints are a custom extension. Not a gap.

---

## 2. Missing Fields

### 2.1 Agent Response Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `type: "agent"` | Missing | **Not included in response** | CRITICAL |
| `model` (always object form `{id, speed}`) | `model` (string or object) | **String form accepted and returned** | CRITICAL |
| `system` (null when empty) | `system` (empty string) | Difference | MINOR |
| `description` (null when empty) | `description` (undefined) | Difference | MINOR |
| `skills` (empty array default) | `skills` (undefined) | Difference | MINOR |
| `mcp_servers` (empty array default) | `mcp_servers` (undefined) | Difference | MINOR |
| `metadata` (empty object default) | `metadata` (undefined) | Difference | MINOR |
| `archived_at` (null default) | `archived_at` (undefined) | Difference | MINOR |

**Key Gaps:**

- **CRITICAL**: Anthropic always returns `"type": "agent"` in agent responses. We don't include a `type` field. SDKs may use this for polymorphic deserialization.
- **CRITICAL**: Anthropic normalizes `model` to always be an object `{"id": "...", "speed": "standard"}` in responses, even when a string is provided. We echo back the string form if that's what was given.
- **MINOR**: Anthropic returns `null` for unset nullable fields (`system`, `description`, `archived_at`). We omit them or return empty string.

### 2.2 Agent Update Semantics

| Anthropic Behavior | Our Behavior | Status | Severity |
|---|---|---|---|
| `version` field required in update body (optimistic concurrency) | Not required | **Missing concurrency control** | IMPORTANT |
| Metadata merge: delete key by setting value to `""` | No special merge logic | Missing | MINOR |
| `system`/`description` clearable with `null` | Not supported | Missing | MINOR |
| Array fields clearable with `null` or `[]` | Only `[]` | Missing | MINOR |

- **IMPORTANT**: Anthropic requires `version` in the update body for optimistic concurrency. We don't check it.

### 2.3 Session Response Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `usage` (cumulative token stats) | Not in session response | **Missing** | IMPORTANT |
| `outcome_evaluations` | Not in session response | **Missing** | IMPORTANT |
| `status` values: `idle`, `running`, `rescheduled`, `terminated` | `idle`, `running`, `rescheduling`, `terminated`, `processing`, `error` | **Different values** | CRITICAL |

**Key Gaps:**

- **CRITICAL**: Anthropic uses `running` (not `processing`). Our status `processing` won't match SDK expectations. We also have `error` which Anthropic doesn't list as a status (errors are events, not session status).
- **IMPORTANT**: Session GET response should include cumulative `usage` object with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. We track usage in the DO but don't return it in the session GET response.
- **IMPORTANT**: `outcome_evaluations` array missing from session GET response.

### 2.4 Session Create Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `resources[].type: "memory_store"` | Supported | - |
| `resources[].access` | Stored but not enforced in memory tools | MINOR |
| `resources[].prompt` | Stored in type but not used in system prompt | IMPORTANT |

- **IMPORTANT**: Anthropic's `prompt` field on memory store resources provides session-specific instructions. We store it in the type but our harness doesn't inject it into the system prompt.

### 2.5 Event Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `id` on every event (e.g., `sevt_01...`) | `id` optional, rarely set | **Missing event IDs** | CRITICAL |
| `processed_at` on every event | `processed_at` optional, rarely set | **Missing timestamps** | CRITICAL |
| `session.error.error` (typed object with `retry_status`) | `session.error.error` (plain string) | **Wrong shape** | IMPORTANT |
| `session.status_idle.stop_reason.type` values | Different values | **Different enum** | CRITICAL |

**Key Gaps:**

- **CRITICAL**: Anthropic assigns an `id` (prefixed `sevt_`) and `processed_at` timestamp to every event. We don't generate event IDs or timestamps on events. SDKs use `event_ids` for tool confirmation routing and reconnection dedup.
- **CRITICAL**: Anthropic's `stop_reason.type` is `"end_turn"` or `"requires_action"`. Our types are `"user.message_required"`, `"tool_confirmation_required"`, `"custom_tool_result_required"`. SDKs will not recognize our values.
- **IMPORTANT**: Anthropic's `session.error` has a typed error object with `retry_status`. Ours is a plain string.

### 2.6 Outcome Event Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `user.define_outcome.rubric` (text or file) | `user.define_outcome.outcome.criteria` (string array) | **Different schema** | IMPORTANT |
| `user.define_outcome.description` (top-level) | `user.define_outcome.outcome.description` (nested) | **Different nesting** | IMPORTANT |
| `span.outcome_evaluation_end.explanation` | Missing | Missing | MINOR |
| `span.outcome_evaluation_end.usage` | Missing | Missing | MINOR |
| `span.outcome_evaluation_end.outcome_evaluation_start_id` | Missing | Missing | MINOR |
| `outcome_id` on outcome events | Missing | Missing | IMPORTANT |
| Result value `interrupted` | Missing | Missing | MINOR |

- **IMPORTANT**: Anthropic's `user.define_outcome` uses `rubric` (text or file reference) and `description` at the top level. Our schema nests these under an `outcome` object and uses `criteria` (string array) instead of `rubric`. This is a schema mismatch.

### 2.7 Multi-Agent Event Fields

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `session.thread_created.session_thread_id` | `session.thread_created.thread_id` | **Different field name** | IMPORTANT |
| `session.thread_created.model` | Missing | Missing | MINOR |
| `agent.thread_message_sent.to_thread_id` | `agent.thread_message_sent.thread_id` | **Different field name** | IMPORTANT |
| `agent.thread_message_received.from_thread_id` | `agent.thread_message_received.thread_id` | **Different field name** | IMPORTANT |
| `session_thread_id` on tool confirmation events (thread routing) | Missing | **Not supported** | IMPORTANT |

---

## 3. Missing Event Types

| Anthropic Event | Our Implementation | Severity |
|---|---|---|
| `user.message` | Implemented | - |
| `user.interrupt` | Implemented | - |
| `user.custom_tool_result` | Implemented | - |
| `user.tool_confirmation` | Implemented | - |
| `user.define_outcome` | Implemented | - |
| `agent.message` | Implemented | - |
| `agent.thinking` | Implemented | - |
| `agent.tool_use` | Implemented | - |
| `agent.tool_result` | Implemented | - |
| `agent.mcp_tool_use` | Implemented | - |
| `agent.mcp_tool_result` | Implemented | - |
| `agent.custom_tool_use` | Implemented | - |
| `agent.thread_context_compacted` | Implemented | - |
| `agent.thread_message_sent` | Implemented | - |
| `agent.thread_message_received` | Implemented | - |
| `session.status_running` | Implemented | - |
| `session.status_idle` | Implemented | - |
| `session.status_rescheduled` | Implemented (as `session.status_rescheduled`) | - |
| `session.status_terminated` | Implemented | - |
| `session.error` | Implemented | - |
| `session.outcome_evaluated` | Implemented | - |
| `session.thread_created` | Implemented (type only) | - |
| `session.thread_idle` | Implemented (type only) | - |
| `span.model_request_start` | Implemented | - |
| `span.model_request_end` | Implemented | - |
| `span.outcome_evaluation_start` | Implemented (type only) | - |
| `span.outcome_evaluation_ongoing` | Implemented (type only) | - |
| `span.outcome_evaluation_end` | Implemented (type only) | - |

All event types are defined in our `types.ts`. The types exist but several are only defined, not actively emitted by the harness:
- `session.thread_created`, `session.thread_idle` — types defined but no code in session-do or default-loop emits them via proper thread management
- `session.status_rescheduled` — type defined but no retry/reschedule logic emits it

**Severity: MINOR** — The types exist; the emission logic is incomplete for research-preview features.

---

## 4. Missing Tool Configurations

### 4.1 Built-in Tools

| Anthropic Tool | Our Implementation | Status | Severity |
|---|---|---|---|
| `bash` | Implemented | Full | - |
| `read` | Implemented | Full | - |
| `write` | Implemented | Full | - |
| `edit` | Implemented | Full | - |
| `glob` | Implemented | Full | - |
| `grep` | Implemented | Full | - |
| `web_fetch` | Implemented | Full | - |
| `web_search` | Implemented | Full | - |

All eight built-in tools are implemented.

### 4.2 Memory Tools

| Anthropic Tool | Our Tool | Status | Severity |
|---|---|---|---|
| `memory_list` | `memory_list` | Implemented | - |
| `memory_search` | `memory_search` | Implemented | - |
| `memory_read` | `memory_read` | Implemented | - |
| `memory_write` | `memory_write` | Implemented | - |
| `memory_edit` | **Missing** | Not implemented | IMPORTANT |
| `memory_delete` | `memory_delete` | Implemented | - |

- **IMPORTANT**: Anthropic specifies a `memory_edit` tool (modify an existing memory). We have `memory_write` which does upsert-by-path, but no dedicated `memory_edit` tool that works on an existing memory by ID with partial content updates.

### 4.3 Permission Policies

| Anthropic Feature | Our Implementation | Status | Severity |
|---|---|---|---|
| Per-tool `permission_policy` in toolset configs | Implemented | Supported in `configs[].permission_policy` | - |
| `always_allow` policy | Implemented | - |
| `always_ask` policy | Implemented (strips execute function) | - |

Permission policies are well-implemented.

### 4.4 MCP Server Configuration

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `mcp_servers[].name` | Supported | - |
| `mcp_servers[].type` | Supported | - |
| `mcp_servers[].url` | Supported | - |

MCP server configuration is implemented.

### 4.5 Skills Configuration

| Anthropic Field | Our Field | Status | Severity |
|---|---|---|---|
| `skills[].skill_id` | Supported | - |
| `skills[].type` | Supported | - |
| `skills[].version` | Supported | - |

Skills are configured on agents. We additionally have a full Skills CRUD API which is an extension.

---

## 5. Behavior Differences

### 5.1 Streaming Endpoint Path

- **Anthropic**: `GET /v1/sessions/{id}/stream`
- **Ours**: `GET /v1/sessions/{id}/events/stream` (also `Accept: text/event-stream` on `/events`)
- **Severity**: CRITICAL — SDK will connect to wrong path

### 5.2 Agent Update Method

- **Anthropic**: `POST /v1/agents/{id}`
- **Ours**: `PUT /v1/agents/{id}`
- **Severity**: CRITICAL — SDK sends POST, gets 404

### 5.3 Memory Update Method

- **Anthropic**: `PATCH /v1/memory_stores/{id}/memories/{id}`
- **Ours**: `POST /v1/memory_stores/{id}/memories/{id}`
- **Severity**: CRITICAL — SDK sends PATCH, gets 404

### 5.4 Session Status Values

- **Anthropic**: `idle`, `running`, `rescheduled`, `terminated`
- **Ours**: `idle`, `running`, `rescheduling`, `terminated`, `processing`, `error`
- **Severity**: CRITICAL — `processing` should be `running`; `error` is not a valid status

### 5.5 Stop Reason Types

- **Anthropic**: `end_turn`, `requires_action`
- **Ours**: `user.message_required`, `tool_confirmation_required`, `custom_tool_result_required`
- **Severity**: CRITICAL — SDKs check for `end_turn`/`requires_action`

### 5.6 Event ID Generation

- **Anthropic**: Every event gets a unique `id` (prefix `sevt_`) and `processed_at` timestamp
- **Ours**: Events have optional `id` and `processed_at` fields but they are never populated
- **Severity**: CRITICAL — SDKs use event IDs for tool confirmation routing (`event_ids` in `stop_reason`) and reconnection deduplication

### 5.7 Model Normalization

- **Anthropic**: Model is always returned as `{"id": "...", "speed": "standard"}` object even when provided as string
- **Ours**: Model is returned in whatever form it was provided (string or object)
- **Severity**: CRITICAL — SDKs expect to always deserialize model as an object

### 5.8 File Upload Format

- **Anthropic**: Multipart form upload
- **Ours**: JSON body upload `{filename, content}`
- **Severity**: IMPORTANT — SDKs will use multipart, which our endpoint won't parse correctly

### 5.9 Outcome Schema Differences

- **Anthropic**: `user.define_outcome` has `description`, `rubric` (text/file), `max_iterations` at top level
- **Ours**: Nested under `outcome` object with `description`, `criteria[]`, `max_iterations`
- **Severity**: IMPORTANT — Different structure breaks SDK serialization

### 5.10 Memory Upsert Behavior

- **Anthropic**: `POST /memories` does upsert by path (creates if not exists, replaces if exists)
- **Ours**: `POST /memories` always creates a new memory (does not upsert by path unless precondition is used)
- **Severity**: IMPORTANT — Anthropic's behavior is upsert-by-path by default

### 5.11 Beta Headers

- **Anthropic**: Requires `anthropic-beta: managed-agents-2026-04-01` on all requests
- **Ours**: No beta header checking
- **Severity**: MINOR — Our open implementation doesn't need gating, but could validate for compatibility

### 5.12 Pagination

- **Anthropic**: Standard pagination across list endpoints
- **Ours**: Basic `limit`/`order` support, `after_seq` for events
- **Severity**: MINOR — Functional but may differ in cursor format

### 5.13 `type` Field on Response Objects

- **Anthropic**: Returns `"type": "agent"` on agent responses (likely similar for other resources)
- **Ours**: No `type` discriminator field on any response objects
- **Severity**: CRITICAL for polymorphic SDK deserialization

---

## 6. Priority Summary

### CRITICAL (11 items — would break Anthropic SDK compatibility)

1. Agent update uses PUT instead of POST
2. Memory update uses POST instead of PATCH
3. SSE stream path is `/events/stream` not `/stream`
4. Missing `type` field on agent (and likely other) responses
5. Model not normalized to object form in responses
6. Session status `processing` should be `running`
7. Stop reason types don't match (`end_turn`/`requires_action`)
8. Event IDs (`sevt_*`) and `processed_at` never populated
9. `stop_reason.event_ids` not populated (depends on event IDs)
10. Different `user.define_outcome` event schema
11. Response objects missing `type` discriminator field

### IMPORTANT (9 items — feature gaps)

1. Missing session threads endpoints (list, stream, list events)
2. Missing `memory_edit` tool
3. Missing `usage` in session GET response
4. Missing `outcome_evaluations` in session GET response
5. Missing `session_thread_id` on tool events for thread routing
6. Missing memory store resource `prompt` injection into system prompt
7. Missing optimistic concurrency (`version` field) on agent update
8. File upload should accept multipart form data
9. `session.error` error field should be typed object, not string

### MINOR (12 items — alignment polish)

1. Null vs undefined for unset fields
2. Empty array vs undefined for empty lists
3. Empty string vs null for unset strings
4. Metadata merge-delete semantics (set to `""` to delete key)
5. `system`/`description` clearable with `null`
6. Array fields clearable with `null`
7. Beta header validation
8. Pagination cursor format
9. Missing `outcome_id` on outcome events
10. Missing `explanation` and `usage` on `span.outcome_evaluation_end`
11. Missing `interrupted` outcome result value
12. `rescheduling` vs `rescheduled` status name
