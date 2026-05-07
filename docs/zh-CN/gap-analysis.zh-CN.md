# 差距分析：Open Managed Agents 与 Anthropic Managed Agents API

生成日期：2026-04-10

本文档把我们的实现与 Anthropic 官方 Managed Agents API 规格（2026-04-10 抓取）逐 endpoint、逐 field 地对比。

严重等级：

- **CRITICAL**：会破坏与 Anthropic SDK 的兼容性
- **IMPORTANT**：功能缺口，但不会让 SDK 直接挂掉
- **MINOR**：锦上添花的对齐项

---

## 1. 缺失的 Endpoint

### 1.1 Agents API

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `POST /v1/agents` | `POST /v1/agents` | 已实现 | - |
| `POST /v1/agents/{id}`（update） | `PUT /v1/agents/{id}` | **HTTP 方法错误** | CRITICAL |
| `GET /v1/agents/{id}` | `GET /v1/agents/{id}` | 已实现 | - |
| `GET /v1/agents` | `GET /v1/agents` | 已实现 | - |
| `GET /v1/agents/{id}/versions` | `GET /v1/agents/{id}/versions` | 已实现 | - |
| `POST /v1/agents/{id}/archive` | `POST /v1/agents/{id}/archive` | 已实现 | - |

**差距：**

- **CRITICAL**：Anthropic 用 `POST /v1/agents/{id}` 做更新；我们用 `PUT /v1/agents/{id}`。SDK 发 POST 会拿到 404/405。
- **MINOR**：我们多了 `DELETE /v1/agents/{id}` 与 `GET /v1/agents/{id}/versions/{version}`，Anthropic 没文档化。这是扩展，不是差距。

### 1.2 Environments API

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `POST /v1/environments` | `POST /v1/environments` | 已实现 | - |
| `GET /v1/environments` | `GET /v1/environments` | 已实现 | - |
| `GET /v1/environments/{id}` | `GET /v1/environments/{id}` | 已实现 | - |
| `POST /v1/environments/{id}/archive` | `POST /v1/environments/{id}/archive` | 已实现 | - |
| `DELETE /v1/environments/{id}` | `DELETE /v1/environments/{id}` | 已实现 | - |

无缺失 endpoint。我们多了 `PUT /v1/environments/{id}`（update）和 `POST /v1/environments/{id}/build-complete`（内部回调），都是扩展。

### 1.3 Sessions API

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `POST /v1/sessions` | `POST /v1/sessions` | 已实现 | - |
| `GET /v1/sessions/{id}` | `GET /v1/sessions/{id}` | 已实现 | - |
| `POST /v1/sessions/{id}/events` | `POST /v1/sessions/{id}/events` | 已实现 | - |
| `GET /v1/sessions/{id}/events` | `GET /v1/sessions/{id}/events` | 已实现 | - |
| `GET /v1/sessions/{id}/stream` | `GET /v1/sessions/{id}/events/stream` | **路径不一致** | CRITICAL |

**差距：**

- **CRITICAL**：Anthropic 的 SSE 流式 endpoint 是 `GET /v1/sessions/{id}/stream`。我们放在 `GET /v1/sessions/{id}/events/stream`。SDK 会打错路径。我们也通过 `Accept: text/event-stream` 在 `/events` 上提供 SSE，但缺专用的 `/stream` 路径。
- **MINOR**：Anthropic 没文档化 `GET /v1/sessions`（列出 session）、`POST /v1/sessions/{id}`（更新 session）、`POST /v1/sessions/{id}/archive` 或 `DELETE /v1/sessions/{id}`。我们的扩展没问题。

### 1.4 Session Threads（多 Agent）

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `GET /v1/sessions/{id}/threads` | **缺失** | 未实现 | IMPORTANT |
| `GET /v1/sessions/{id}/threads/{thread_id}/stream` | **缺失** | 未实现 | IMPORTANT |
| `GET /v1/sessions/{id}/threads/{thread_id}/events` | **缺失** | 未实现 | IMPORTANT |

**差距：**

- **IMPORTANT**：三个 thread 管理 endpoint 全缺。我们通过 `call_agent_*` 工具支持多 agent 委派，但没有 API endpoint 列出 thread、流式拉 thread 事件、列出 thread 事件。多 agent 是 research preview 特性，对 GA 不会破坏 SDK，但会拦住多 agent SDK 用法。

### 1.5 Memory API

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `POST /v1/memory_stores` | `POST /v1/memory_stores` | 已实现 | - |
| `GET /v1/memory_stores/{id}` | `GET /v1/memory_stores/{id}` | 已实现 | - |
| `GET /v1/memory_stores` | `GET /v1/memory_stores` | 已实现 | - |
| `POST /v1/memory_stores/{id}/memories` | `POST /v1/memory_stores/{id}/memories` | 已实现 | - |
| `GET /v1/memory_stores/{id}/memories` | `GET /v1/memory_stores/{id}/memories` | 已实现 | - |
| `GET /v1/memory_stores/{id}/memories/{id}` | `GET /v1/memory_stores/{id}/memories/{id}` | 已实现 | - |
| `PATCH /v1/memory_stores/{id}/memories/{id}` | `POST /v1/memory_stores/{id}/memories/{id}` | **HTTP 方法错误** | CRITICAL |
| `DELETE /v1/memory_stores/{id}/memories/{id}` | `DELETE /v1/memory_stores/{id}/memories/{id}` | 已实现 | - |
| `GET .../memory_versions` | `GET .../memory_versions` | 已实现 | - |
| `GET .../memory_versions/{id}` | `GET .../memory_versions/{id}` | 已实现 | - |
| `POST .../memory_versions/{id}/redact` | `POST .../memory_versions/{id}/redact` | 已实现 | - |

**差距：**

- **CRITICAL**：Anthropic 用 `PATCH` 更新 memory；我们用 `POST`。SDK 发 PATCH 会拿到 404/405。

### 1.6 Files API

| Anthropic Endpoint | 我们的 Endpoint | 状态 | 严重度 |
|---|---|---|---|
| `POST /v1/files` | `POST /v1/files` | 已实现（JSON，非 multipart） | IMPORTANT |
| `GET /v1/files` | `GET /v1/files` | 已实现 | - |
| `GET /v1/files/{id}/content` | `GET /v1/files/{id}/content` | 已实现 | - |

**差距：**

- **IMPORTANT**：Anthropic 规定 `POST /v1/files` 走 multipart 表单上传。我们接受 JSON `{filename, content}`。用 multipart 的 SDK 会失败。
- **MINOR**：Anthropic 用 `files-api-2025-04-14` beta header。我们完全不校验 beta header（开源实现可以接受，但值得记录）。

### 1.7 Vaults & Credentials API

- **不在 Anthropic 规格中**：我们的 Vaults 与 Credentials API（`/v1/vaults`、`/v1/vaults/{id}/credentials`）是自定扩展。Anthropic 没有文档化 vault/credential 管理 endpoint。这没问题——是我们做自托管凭据管理的差异化价值。

### 1.8 Skills API

- **Anthropic 规格里不作为单独 endpoint**：Anthropic 把 skills 作为 Agent 配置上的字段，但没有暴露 skills 的专用 CRUD endpoint。我们的 `/v1/skills` 是自定扩展。**不是差距。**

---

## 2. 缺失的字段

### 2.1 Agent 响应字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `type: "agent"` | 缺失 | **响应里不带** | CRITICAL |
| `model`（永远是对象形式 `{id, speed}`） | `model`（字符串或对象） | **接受并返回字符串形式** | CRITICAL |
| `system`（空时为 null） | `system`（空字符串） | 差异 | MINOR |
| `description`（空时为 null） | `description`（undefined） | 差异 | MINOR |
| `skills`（默认空数组） | `skills`（undefined） | 差异 | MINOR |
| `mcp_servers`（默认空数组） | `mcp_servers`（undefined） | 差异 | MINOR |
| `metadata`（默认空对象） | `metadata`（undefined） | 差异 | MINOR |
| `archived_at`（默认 null） | `archived_at`（undefined） | 差异 | MINOR |

**关键差距：**

- **CRITICAL**：Anthropic 在 agent 响应里始终返回 `"type": "agent"`。我们没带 `type` 字段。SDK 可能用它做多态反序列化。
- **CRITICAL**：Anthropic 把 `model` 在响应里规范化为对象 `{"id": "...", "speed": "standard"}`，即使输入是字符串。我们原样回吐。
- **MINOR**：Anthropic 对未设置的 nullable 字段（`system`、`description`、`archived_at`）返回 `null`。我们要么不带，要么返回空字符串。

### 2.2 Agent 更新语义

| Anthropic 行为 | 我们的行为 | 状态 | 严重度 |
|---|---|---|---|
| 更新 body 必须带 `version`（乐观并发） | 不要求 | **缺并发控制** | IMPORTANT |
| Metadata 合并：把 value 设为 `""` 删除 key | 无特殊合并逻辑 | 缺失 | MINOR |
| `system`/`description` 可用 `null` 清空 | 不支持 | 缺失 | MINOR |
| 数组字段可用 `null` 或 `[]` 清空 | 仅 `[]` | 缺失 | MINOR |

- **IMPORTANT**：Anthropic 要求 update body 带 `version` 做乐观并发。我们不校验。

### 2.3 Session 响应字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `usage`（累计 token 统计） | session 响应里没有 | **缺失** | IMPORTANT |
| `outcome_evaluations` | session 响应里没有 | **缺失** | IMPORTANT |
| `status` 取值：`idle`、`running`、`rescheduled`、`terminated` | `idle`、`running`、`rescheduling`、`terminated`、`processing`、`error` | **取值不同** | CRITICAL |

**关键差距：**

- **CRITICAL**：Anthropic 用 `running`（不是 `processing`）。我们的 `processing` 不会被 SDK 识别。我们还有 `error`，但 Anthropic 不把 error 算 status（错误是 event）。
- **IMPORTANT**：Session GET 响应应包含累计 `usage` 对象，含 `input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`。我们在 DO 里追踪 usage，但没在 session GET 响应里返回。
- **IMPORTANT**：session GET 响应缺 `outcome_evaluations` 数组。

### 2.4 Session 创建字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `resources[].type: "memory_store"` | 已支持 | - |
| `resources[].access` | 存了但 memory 工具未强制 | MINOR |
| `resources[].prompt` | 类型里有但没注入 system prompt | IMPORTANT |

- **IMPORTANT**：Anthropic 在 memory store 资源上的 `prompt` 字段提供 session 专属指令。我们在类型里有，但 harness 没把它注入 system prompt。

### 2.5 Event 字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| 每个事件都有 `id`（如 `sevt_01...`） | `id` 可选，几乎从不设置 | **缺事件 ID** | CRITICAL |
| 每个事件都有 `processed_at` | `processed_at` 可选，几乎从不设置 | **缺时间戳** | CRITICAL |
| `session.error.error`（带 `retry_status` 的类型化对象） | `session.error.error`（纯字符串） | **形态错误** | IMPORTANT |
| `session.status_idle.stop_reason.type` 取值 | 取值不同 | **枚举不同** | CRITICAL |

**关键差距：**

- **CRITICAL**：Anthropic 给每个事件分配 `id`（前缀 `sevt_`）和 `processed_at` 时间戳。我们不生成事件 ID 或时间戳。SDK 用 `event_ids` 做 tool confirmation 路由和重连去重。
- **CRITICAL**：Anthropic 的 `stop_reason.type` 是 `"end_turn"` 或 `"requires_action"`。我们的是 `"user.message_required"`、`"tool_confirmation_required"`、`"custom_tool_result_required"`。SDK 不会认识我们的取值。
- **IMPORTANT**：Anthropic 的 `session.error` 带类型化错误对象，含 `retry_status`。我们是纯字符串。

### 2.6 Outcome 事件字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `user.define_outcome.rubric`（文本或文件） | `user.define_outcome.outcome.criteria`（字符串数组） | **schema 不同** | IMPORTANT |
| `user.define_outcome.description`（顶层） | `user.define_outcome.outcome.description`（嵌套） | **嵌套不同** | IMPORTANT |
| `span.outcome_evaluation_end.explanation` | 缺失 | 缺失 | MINOR |
| `span.outcome_evaluation_end.usage` | 缺失 | 缺失 | MINOR |
| `span.outcome_evaluation_end.outcome_evaluation_start_id` | 缺失 | 缺失 | MINOR |
| outcome 事件上的 `outcome_id` | 缺失 | 缺失 | IMPORTANT |
| 结果值 `interrupted` | 缺失 | 缺失 | MINOR |

- **IMPORTANT**：Anthropic 的 `user.define_outcome` 顶层用 `rubric`（文本或文件引用）和 `description`。我们的 schema 把这些嵌套在 `outcome` 对象下，并用 `criteria`（字符串数组）取代 `rubric`。这是 schema mismatch。

### 2.7 多 Agent 事件字段

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `session.thread_created.session_thread_id` | `session.thread_created.thread_id` | **字段名不同** | IMPORTANT |
| `session.thread_created.model` | 缺失 | 缺失 | MINOR |
| `agent.thread_message_sent.to_thread_id` | `agent.thread_message_sent.thread_id` | **字段名不同** | IMPORTANT |
| `agent.thread_message_received.from_thread_id` | `agent.thread_message_received.thread_id` | **字段名不同** | IMPORTANT |
| tool confirmation 事件上的 `session_thread_id`（线程路由） | 缺失 | **不支持** | IMPORTANT |

---

## 3. 缺失的事件类型

| Anthropic 事件 | 我们的实现 | 严重度 |
|---|---|---|
| `user.message` | 已实现 | - |
| `user.interrupt` | 已实现 | - |
| `user.custom_tool_result` | 已实现 | - |
| `user.tool_confirmation` | 已实现 | - |
| `user.define_outcome` | 已实现 | - |
| `agent.message` | 已实现 | - |
| `agent.thinking` | 已实现 | - |
| `agent.tool_use` | 已实现 | - |
| `agent.tool_result` | 已实现 | - |
| `agent.mcp_tool_use` | 已实现 | - |
| `agent.mcp_tool_result` | 已实现 | - |
| `agent.custom_tool_use` | 已实现 | - |
| `agent.thread_context_compacted` | 已实现 | - |
| `agent.thread_message_sent` | 已实现 | - |
| `agent.thread_message_received` | 已实现 | - |
| `session.status_running` | 已实现 | - |
| `session.status_idle` | 已实现 | - |
| `session.status_rescheduled` | 已实现（名为 `session.status_rescheduled`） | - |
| `session.status_terminated` | 已实现 | - |
| `session.error` | 已实现 | - |
| `session.outcome_evaluated` | 已实现 | - |
| `session.thread_created` | 已实现（仅类型） | - |
| `session.thread_idle` | 已实现（仅类型） | - |
| `span.model_request_start` | 已实现 | - |
| `span.model_request_end` | 已实现 | - |
| `span.outcome_evaluation_start` | 已实现（仅类型） | - |
| `span.outcome_evaluation_ongoing` | 已实现（仅类型） | - |
| `span.outcome_evaluation_end` | 已实现（仅类型） | - |

所有事件类型在 `types.ts` 中都有定义。类型存在，但其中几种**只是类型，没有被 harness 真正发出**：

- `session.thread_created`、`session.thread_idle` —— 类型已定义，但 session-do 或 default-loop 里没有代码通过正确的 thread 管理把它们发出去
- `session.status_rescheduled` —— 类型已定义，但没有重试/重排逻辑发出它

**严重度：MINOR** —— 类型在；发射逻辑对 research-preview 特性不完整。

---

## 4. 缺失的工具配置

### 4.1 内置工具

| Anthropic 工具 | 我们的实现 | 状态 | 严重度 |
|---|---|---|---|
| `bash` | 已实现 | 完整 | - |
| `read` | 已实现 | 完整 | - |
| `write` | 已实现 | 完整 | - |
| `edit` | 已实现 | 完整 | - |
| `glob` | 已实现 | 完整 | - |
| `grep` | 已实现 | 完整 | - |
| `web_fetch` | 已实现 | 完整 | - |
| `web_search` | 已实现 | 完整 | - |

8 个内置工具全部实现。

### 4.2 Memory 工具

| Anthropic 工具 | 我们的工具 | 状态 | 严重度 |
|---|---|---|---|
| `memory_list` | `memory_list` | 已实现 | - |
| `memory_search` | `memory_search` | 已实现 | - |
| `memory_read` | `memory_read` | 已实现 | - |
| `memory_write` | `memory_write` | 已实现 | - |
| `memory_edit` | **缺失** | 未实现 | IMPORTANT |
| `memory_delete` | `memory_delete` | 已实现 | - |

- **IMPORTANT**：Anthropic 规定一个 `memory_edit` 工具（修改已有 memory）。我们有 `memory_write` 做 path upsert，但**没有专用的、按 ID 对已有 memory 做局部更新的 `memory_edit` 工具**。

### 4.3 权限策略

| Anthropic 特性 | 我们的实现 | 状态 | 严重度 |
|---|---|---|---|
| 工具集 config 里的 per-tool `permission_policy` | 已实现 | 在 `configs[].permission_policy` 支持 | - |
| `always_allow` 策略 | 已实现 | - |
| `always_ask` 策略 | 已实现（剥掉 execute 函数） | - |

权限策略实现得很好。

### 4.4 MCP server 配置

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `mcp_servers[].name` | 已支持 | - |
| `mcp_servers[].type` | 已支持 | - |
| `mcp_servers[].url` | 已支持 | - |

MCP server 配置已实现。

### 4.5 Skills 配置

| Anthropic 字段 | 我们的字段 | 状态 | 严重度 |
|---|---|---|---|
| `skills[].skill_id` | 已支持 | - |
| `skills[].type` | 已支持 | - |
| `skills[].version` | 已支持 | - |

Agent 上的 skills 配置可用。我们额外提供完整的 Skills CRUD API，是扩展。

---

## 5. 行为差异

### 5.1 流式 endpoint 路径

- **Anthropic**：`GET /v1/sessions/{id}/stream`
- **我们**：`GET /v1/sessions/{id}/events/stream`（也支持在 `/events` 上的 `Accept: text/event-stream`）
- **严重度**：CRITICAL —— SDK 会连错路径

### 5.2 Agent 更新方法

- **Anthropic**：`POST /v1/agents/{id}`
- **我们**：`PUT /v1/agents/{id}`
- **严重度**：CRITICAL —— SDK 发 POST，拿到 404

### 5.3 Memory 更新方法

- **Anthropic**：`PATCH /v1/memory_stores/{id}/memories/{id}`
- **我们**：`POST /v1/memory_stores/{id}/memories/{id}`
- **严重度**：CRITICAL —— SDK 发 PATCH，拿到 404

### 5.4 Session 状态取值

- **Anthropic**：`idle`、`running`、`rescheduled`、`terminated`
- **我们**：`idle`、`running`、`rescheduling`、`terminated`、`processing`、`error`
- **严重度**：CRITICAL —— `processing` 应为 `running`；`error` 不是合法状态

### 5.5 Stop reason 类型

- **Anthropic**：`end_turn`、`requires_action`
- **我们**：`user.message_required`、`tool_confirmation_required`、`custom_tool_result_required`
- **严重度**：CRITICAL —— SDK 检查 `end_turn` / `requires_action`

### 5.6 事件 ID 生成

- **Anthropic**：每个事件都有唯一 `id`（前缀 `sevt_`）和 `processed_at`
- **我们**：事件有可选 `id` 和 `processed_at`，但从不填充
- **严重度**：CRITICAL —— SDK 用事件 ID 做 tool confirmation 路由（`stop_reason` 里的 `event_ids`）和重连去重

### 5.7 Model 规范化

- **Anthropic**：响应里 model 始终是 `{"id": "...", "speed": "standard"}` 对象，即使输入是字符串
- **我们**：原样返回（输入啥就返回啥）
- **严重度**：CRITICAL —— SDK 期望永远把 model 反序列化为对象

### 5.8 文件上传格式

- **Anthropic**：multipart 表单上传
- **我们**：JSON body 上传 `{filename, content}`
- **严重度**：IMPORTANT —— SDK 用 multipart，我们的 endpoint 解析不了

### 5.9 Outcome schema 差异

- **Anthropic**：`user.define_outcome` 顶层有 `description`、`rubric`（text/file）、`max_iterations`
- **我们**：嵌套在 `outcome` 对象下，包含 `description`、`criteria[]`、`max_iterations`
- **严重度**：IMPORTANT —— 不同结构破坏 SDK 序列化

### 5.10 Memory upsert 行为

- **Anthropic**：`POST /memories` 默认按路径 upsert（不存在则创建，存在则替换）
- **我们**：`POST /memories` 总是创建新 memory（除非用 precondition 否则不按路径 upsert）
- **严重度**：IMPORTANT —— Anthropic 默认就是 upsert-by-path

### 5.11 Beta header

- **Anthropic**：所有请求需要 `anthropic-beta: managed-agents-2026-04-01`
- **我们**：完全不校验 beta header
- **严重度**：MINOR —— 开源实现不需要门控，但为兼容性可校验

### 5.12 分页

- **Anthropic**：列表 endpoint 有标准分页
- **我们**：基本的 `limit` / `order` 支持，事件用 `after_seq`
- **严重度**：MINOR —— 可用，但 cursor 格式可能不同

### 5.13 响应对象上的 `type` 字段

- **Anthropic**：agent 响应里返回 `"type": "agent"`（其它资源类型可能也有）
- **我们**：所有响应对象都没有 `type` 鉴别字段
- **严重度**：CRITICAL（针对 SDK 的多态反序列化）

---

## 6. 优先级总结

### CRITICAL（11 项 —— 会破坏 Anthropic SDK 兼容性）

1. Agent 更新用 PUT 而非 POST
2. Memory 更新用 POST 而非 PATCH
3. SSE 流路径是 `/events/stream` 而非 `/stream`
4. agent 响应（以及可能其它响应）缺 `type` 字段
5. 响应里 model 没有规范化为对象
6. session 状态 `processing` 应改为 `running`
7. Stop reason 类型不匹配（`end_turn` / `requires_action`）
8. 事件 ID（`sevt_*`）与 `processed_at` 从不填充
9. `stop_reason.event_ids` 没填（依赖事件 ID）
10. `user.define_outcome` 事件 schema 不同
11. 响应对象缺 `type` 鉴别字段

### IMPORTANT（9 项 —— 功能缺口）

1. 缺 session threads endpoint（list、stream、list events）
2. 缺 `memory_edit` 工具
3. session GET 响应缺 `usage`
4. session GET 响应缺 `outcome_evaluations`
5. tool 事件缺 `session_thread_id`（线程路由）
6. memory store 资源 `prompt` 没注入 system prompt
7. agent 更新缺乐观并发（`version` 字段）
8. 文件上传应支持 multipart 表单
9. `session.error` 的 error 字段应为类型化对象，非字符串

### MINOR（12 项 —— 对齐打磨）

1. 未设置字段 null vs undefined
2. 空列表 `[]` vs undefined
3. 未设置字符串空字符串 vs null
4. Metadata 「设为 `""` 删除 key」语义
5. `system` / `description` 用 `null` 清空
6. 数组字段用 `null` 清空
7. Beta header 校验
8. 分页 cursor 格式
9. outcome 事件缺 `outcome_id`
10. `span.outcome_evaluation_end` 缺 `explanation` 与 `usage`
11. 缺 `interrupted` outcome 结果值
12. `rescheduling` vs `rescheduled` 状态名