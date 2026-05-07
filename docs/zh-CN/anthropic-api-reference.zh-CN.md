# Anthropic Managed Agents —— 完整 API 参考

提取自 https://platform.claude.com/docs/en/managed-agents/，时间 2026-04-10。

> **Beta**：所有 Managed Agents endpoint 都需要 `managed-agents-2026-04-01` beta header。
> Research preview 特性还需要 `managed-agents-2026-04-01-research-preview`。
> SDK 会自动设置这些 header。

---

## 目录

1. [概览与核心概念](#1-概览与核心概念)
2. [限流](#2-限流)
3. [Agents API](#3-agents-api)
4. [Environments API](#4-environments-api)
5. [Sessions API](#5-sessions-api)
6. [Events 与 Streaming API](#6-events-与-streaming-api)
7. [Tools](#7-tools)
8. [多 Agent 编排](#8-多-agent-编排)
9. [Memory API](#9-memory-api)
10. [Outcomes（Define Outcomes）](#10-outcomesdefine-outcomes)
11. [Cloud Container 参考](#11-cloud-container-参考)
12. [Files API（Outcomes 用）](#12-files-apioutcomes-用)

---

## 1. 概览与核心概念

### 核心概念

| 概念 | 描述 |
|---------|-------------|
| **Agent** | 模型、system prompt、tools、MCP servers、skills |
| **Environment** | 一个配好的容器模板（包、网络访问） |
| **Session** | environment 内的 agent 实例，执行特定任务并产出结果 |
| **Events** | 你的应用与 agent 之间交换的消息（user 回合、tool 结果、状态更新） |

### 工作流程

1. **创建 agent** —— 定义模型、system prompt、tools、MCP servers、skills。一次创建，按 ID 引用。
2. **创建 environment** —— 配置 cloud container（包、网络访问规则、挂载文件）。
3. **启动 session** —— 引用 agent 与 environment。
4. **发事件并 stream 响应** —— user 消息作为事件；Claude 通过 SSE 流回。
5. **steer 或 interrupt** —— 在执行中途发额外的 user 事件。

### 何时使用

- 长时运行（数分钟到数小时，多次工具调用）
- 云基础设施（带包与网络的安全容器）
- 最少基础设施（不需要自建 agent 循环/沙箱）
- 状态化 session（持久文件系统与对话历史）

### 必需 Header

| Header | 值 |
|--------|-------|
| `x-api-key` | 你的 API key |
| `anthropic-version` | `2023-06-01` |
| `anthropic-beta` | `managed-agents-2026-04-01` |
| `content-type` | `application/json` |

Research preview 特性（outcomes、multiagent、memory）：

| `anthropic-beta` | `managed-agents-2026-04-01-research-preview` |

### 品牌指南

**允许：**

- 「Claude Agent」（下拉菜单首选）
- 「Claude」（菜单已经标 "Agents" 时）
- 「{YourAgentName} Powered by Claude」

**不允许：**

- 「Claude Code」或「Claude Code Agent」
- 「Claude Cowork」或「Claude Cowork Agent」
- Claude Code 品牌的 ASCII art 或视觉元素

---

## 2. 限流

| 操作 | 限制 |
|-----------|-------|
| 创建类 endpoint（agents、sessions、environments 等） | 每分钟 60 次 |
| 读类 endpoint（retrieve、list、stream 等） | 每分钟 600 次 |

组织级支出上限和按 tier 的限流也适用。

---

## 3. Agents API

### Agent 配置字段

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | 人类可读名 |
| `model` | string 或 object | 是 | Claude 模型 ID。所有 Claude 4.5+ 模型支持。对象形式：`{"id": "claude-opus-4-6", "speed": "fast"}` |
| `system` | string | 否 | 定义行为/人格的 system prompt |
| `tools` | array | 否 | agent 可用的工具，组合预置 agent tool、MCP tool、custom tool |
| `mcp_servers` | array | 否 | 第三方能力的标准化 MCP server |
| `skills` | array | 否 | 域特定上下文的 skills，渐进披露 |
| `callable_agents` | array | 否 | 本 agent 可调用的其它 agent（多 agent）。Research preview |
| `description` | string | 否 | agent 描述 |
| `metadata` | object | 否 | 任意 KV 用于追踪 |

### Agent 响应字段

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `id` | string | Agent ID（如 `agent_01HqR2k7vXbZ9mNpL3wYcT8f`） |
| `type` | string | 始终 `"agent"` |
| `name` | string | agent 名 |
| `model` | object | `{"id": "claude-sonnet-4-6", "speed": "standard"}` |
| `system` | string 或 null | system prompt |
| `description` | string 或 null | 描述 |
| `tools` | array | 已配置的 tools |
| `skills` | array | 已配置的 skills |
| `mcp_servers` | array | 已配置的 MCP server |
| `metadata` | object | metadata KV |
| `version` | integer | 从 1 开始，更新时递增 |
| `created_at` | string（ISO-8601） | 创建时间 |
| `updated_at` | string（ISO-8601） | 上次更新时间 |
| `archived_at` | string 或 null | 归档时间 |

### 创建 Agent

```
POST /v1/agents
```

**Request Body：**

```json
{
  "name": "Coding Assistant",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful coding agent.",
  "tools": [{"type": "agent_toolset_20260401"}]
}
```

**Response：**

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

**Fast 模式（Claude Opus 4.6）：**

```json
{"id": "claude-opus-4-6", "speed": "fast"}
```

### 更新 Agent

```
POST /v1/agents/{agent_id}
```

**Request Body（局部更新）：**

```json
{
  "version": 1,
  "system": "You are a helpful coding agent. Always write tests."
}
```

**更新语义：**

- 省略字段保留
- 标量字段（`model`、`system`、`name` 等）替换。`system`、`description` 可用 `null` 清空。`model`、`name` 不可清空。
- 数组字段（`tools`、`mcp_servers`、`skills`、`callable_agents`）整体替换。用 `null` 或 `[]` 清空。
- Metadata 按 key 合并。提供的 key 添加/更新；省略的 key 保留；把 value 设为 `""` 删除该 key。
- No-op 检测：若更新无任何变化，**不会**生成新版本。

### 列出 Agent 版本

```
GET /v1/agents/{agent_id}/versions
```

**Response：**分页的 agent 版本对象列表，含 `version` 与 `updated_at`。

### 归档 Agent

```
POST /v1/agents/{agent_id}/archive
```

把 agent 设为只读。新 session 不能引用它，已存在 session 继续。响应里 `archived_at` 被设置。

### Agent 生命周期

| 操作 | 行为 |
|-----------|----------|
| Update | 生成新 agent 版本 |
| List versions | 拉取完整版本历史 |
| Archive | 只读。无新 session，已存在 session 继续 |

---

## 4. Environments API

### 创建 Environment

```
POST /v1/environments
```

**Request Body：**

```json
{
  "name": "python-dev",
  "config": {
    "type": "cloud",
    "networking": {"type": "unrestricted"}
  }
}
```

`name` 必须在你的组织 + workspace 内唯一。

### Environment Config 字段

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `type` | string | 始终 `"cloud"` |
| `packages` | object | 按管理器分组的预装包 |
| `networking` | object | 网络访问配置 |

### Packages 配置

| 字段 | 包管理器 | 例 |
|-------|----------------|---------|
| `apt` | 系统包（apt-get） | `"ffmpeg"` |
| `cargo` | Rust（cargo） | `"ripgrep@14.0.0"` |
| `gem` | Ruby（gem） | `"rails:7.1.0"` |
| `go` | Go modules | `"golang.org/x/tools/cmd/goimports@latest"` |
| `npm` | Node.js（npm） | `"express@4.18.0"` |
| `pip` | Python（pip） | `"pandas==2.2.0"` |

指定多个包管理器时按字母序运行（apt, cargo, gem, go, npm, pip）。可锁版本；默认是最新。

**例：**

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

### Networking 配置

| 模式 | 描述 |
|------|-------------|
| `unrestricted` | 完整出站访问（除安全黑名单外）。**默认。** |
| `limited` | 限定为 `allowed_hosts` 列表 |

**Limited networking 字段：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `type` | string | `"limited"` |
| `allowed_hosts` | string[] | 容器可达的域名（必须 HTTPS 前缀） |
| `allow_mcp_servers` | boolean | 允许出站到已配置 MCP server endpoint。默认 `false` |
| `allow_package_managers` | boolean | 允许出站到公共包注册中心。默认 `false` |

**例：**

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

> 注意：`networking` 字段不影响 `web_search` 或 `web_fetch` 工具的允许域名。

### 在 Session 中使用 Environment

```
POST /v1/sessions
```

```json
{
  "agent": "{agent_id}",
  "environment_id": "{environment_id}"
}
```

### 列出 Environments

```
GET /v1/environments
```

### 获取 Environment

```
GET /v1/environments/{environment_id}
```

### 归档 Environment

```
POST /v1/environments/{environment_id}/archive
```

只读。已存在 session 继续。

### 删除 Environment

```
DELETE /v1/environments/{environment_id}
```

仅当无 session 引用时。

### Environment 生命周期

- Environment 一直存在，直到显式归档或删除
- 多个 session 可引用同一 environment
- 每个 session 拿自己的容器实例（**不共享文件系统**）
- Environment 不版本化

---

## 5. Sessions API

### 创建 Session

```
POST /v1/sessions
```

**Request Body：**

```json
{
  "agent": "{agent_id}",
  "environment_id": "{environment_id}",
  "title": "Quickstart session"
}
```

**Session Create 字段：**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `agent` | string | 是 | Agent ID |
| `environment_id` | string | 是 | Environment ID |
| `title` | string | 否 | 人类可读标题 |
| `resources` | array | 否 | 附加资源（如 memory store） |

**Response 包含：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `id` | string | Session ID（如 `sesn_01...`） |
| `status` | string | `idle`、`running`、`rescheduled`、`terminated` |
| `usage` | object | 累计 token 统计 |
| `outcome_evaluations` | array | outcome 评测结果（用了 outcome 时） |

### 获取 Session

```
GET /v1/sessions/{session_id}
```

### Session Usage 对象

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

- `input_tokens`：未缓存的 input token
- `output_tokens`：所有模型调用的 output token 总和
- `cache_creation_input_tokens` / `cache_read_input_tokens`：prompt cache（5 分钟 TTL）

---

## 6. Events 与 Streaming API

### 事件类型

事件遵循 `{domain}.{action}` 命名约定。每个事件都带 `processed_at`（时间戳，排队中为 null）。

#### User 事件（你发的）

| 类型 | 描述 |
|------|-------------|
| `user.message` | 带文本内容的用户消息 |
| `user.interrupt` | 在执行中途停止 agent |
| `user.custom_tool_result` | 自定义工具调用的结果 |
| `user.tool_confirmation` | 当 permission policy 要求确认时批准/拒绝 tool 调用 |
| `user.define_outcome` | 给 agent 定义 outcome（research preview） |

#### Agent 事件（你收到）

| 类型 | 描述 |
|------|-------------|
| `agent.message` | agent 响应，含文本内容块 |
| `agent.thinking` | agent 思考内容（与消息分开） |
| `agent.tool_use` | agent 调用预置 agent tool |
| `agent.tool_result` | 预置 agent tool 执行结果 |
| `agent.mcp_tool_use` | agent 调用 MCP server tool |
| `agent.mcp_tool_result` | MCP tool 执行结果 |
| `agent.custom_tool_use` | agent 调用 custom tool。用 `user.custom_tool_result` 回 |
| `agent.thread_context_compacted` | 对话历史被压缩以适配上下文窗口 |
| `agent.thread_message_sent` | agent 给另一个多 agent 线程发消息 |
| `agent.thread_message_received` | agent 从另一个线程收到消息 |

#### Session 事件（你收到）

| 类型 | 描述 |
|------|-------------|
| `session.status_running` | agent 正在处理 |
| `session.status_idle` | agent 完成，等输入。包含 `stop_reason` |
| `session.status_rescheduled` | 瞬时错误，session 自动重试 |
| `session.status_terminated` | 不可恢复错误，session 结束 |
| `session.error` | 发生错误。包含类型化 `error` 对象，含 `retry_status` |
| `session.outcome_evaluated` | outcome 评测达到终态 |
| `session.thread_created` | 协调器派生新多 agent 线程 |
| `session.thread_idle` | 多 agent 线程完成当前工作 |

#### Span 事件（你收到，可观测性）

| 类型 | 描述 |
|------|-------------|
| `span.model_request_start` | 模型推理调用开始 |
| `span.model_request_end` | 模型推理调用完成。包含 `model_usage` 与 token 计数 |
| `span.outcome_evaluation_start` | outcome 评测开始 |
| `span.outcome_evaluation_ongoing` | outcome 评测期间心跳 |
| `span.outcome_evaluation_end` | outcome 评测完成 |

### 发送事件

```
POST /v1/sessions/{session_id}/events
```

**Request Body：**

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

**中断 + 重定向：**

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

### Stream 事件（SSE）

```
GET /v1/sessions/{session_id}/stream
```

Headers：`Accept: text/event-stream`

返回 Server-Sent Events。**只发送在打开流之后产生的事件**。**先打开流再发事件**避免竞态。

### 列出历史事件

```
GET /v1/sessions/{session_id}/events
```

返回分页的所有 session 事件。

### Stop Reason 类型

`session.status_idle` 事件包含 `stop_reason`：

| Stop Reason 类型 | 描述 |
|-----------------|-------------|
| `end_turn` | agent 自然完成工作 |
| `requires_action` | agent 需要 client 行动。包含 `event_ids` 数组 |

**`requires_action` 结构：**

```json
{
  "type": "session.status_idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["sevt_01..."]
  }
}
```

### Custom Tool 调用流程

1. Session 发出 `agent.custom_tool_use` 事件（tool 名 + 输入）
2. Session 暂停为 `session.status_idle` + `stop_reason: requires_action`
3. 你执行 tool 并发 `user.custom_tool_result`：

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

4. Session 恢复为 `running`

### Tool Confirmation 流程

1. Session 发出 `agent.tool_use` 或 `agent.mcp_tool_use`
2. Session 暂停为 `session.status_idle` + `stop_reason: requires_action`
3. 发 `user.tool_confirmation`：

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

或拒绝：

```json
{
  "type": "user.tool_confirmation",
  "tool_use_id": "{event_id}",
  "result": "deny",
  "deny_message": "Reason for denial"
}
```

4. Session 恢复为 `running`

### 重连模式

1. 打开新 SSE 流
2. List 完整历史以填满已见 event ID
3. Tail 实时流，跳过已见事件

---

## 7. Tools

### 可用内置工具

| 工具 | 名 | 描述 |
|------|------|-------------|
| Bash | `bash` | 在 shell session 中执行 bash 命令 |
| Read | `read` | 从本地文件系统读文件 |
| Write | `write` | 向本地文件系统写文件 |
| Edit | `edit` | 在文件中做字符串替换 |
| Glob | `glob` | 用 glob 模式快速文件匹配 |
| Grep | `grep` | 用 regex 做文本搜索 |
| Web fetch | `web_fetch` | 抓 URL 并返回干净 markdown（Workers AI 转换）；可通过 `agent.aux_model` 自动摘要 |
| Web search | `web_search` | 网页搜索 |

包含 `agent_toolset_20260401` 时全部默认启用。

### Agent Toolset 配置

**完整 toolset：**

```json
{ "type": "agent_toolset_20260401" }
```

**带 per-tool 覆盖：**

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    {"name": "web_fetch", "enabled": false},
    {"name": "web_search", "enabled": false}
  ]
}
```

**仅启用特定工具（默认关）：**

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

### Toolset Config 字段

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `type` | string | `"agent_toolset_20260401"` |
| `default_config` | object | 应用于所有工具的默认配置 |
| `default_config.enabled` | boolean | 默认启用/禁用所有工具 |
| `default_config.permission_policy` | object | 默认权限策略 |
| `configs` | array | per-tool 覆盖 |
| `configs[].name` | string | 工具名（`bash` `read` `write` `edit` `glob` `grep` `web_fetch` `web_search`） |
| `configs[].enabled` | boolean | 启用/禁用本工具 |

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

**Custom Tool 字段：**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `type` | string | 是 | `"custom"` |
| `name` | string | 是 | 工具名 |
| `description` | string | 是 | 工具做什么（建议 3-4+ 句） |
| `input_schema` | object | 是 | 工具输入的 JSON Schema |

**最佳实践：**

- **极其详细的描述**（最重要因素）
- 把相关操作合并为更少的工具（用 `action` 参数）
- 工具名带有意义的命名空间（如 `db_query`、`storage_read`）
- 工具响应只返回高信号信息

---

## 8. 多 Agent 编排

> Research Preview 特性，需申请权限。

### 工作原理

- 所有 agent 共享同一容器与文件系统
- 每个 agent 跑在自己的 session **thread**（上下文隔离的事件流，自己的历史）
- 协调器在 **primary thread** 中运行（与 session 级事件流相同）
- 协调器委派时在运行时派生额外 thread
- thread 持久化（后续问题保留先前回合）
- 每个 agent 用自己的配置（model、system、tools、MCP servers、skills）
- 工具与上下文 **不在 agent 间共享**
- **只一层委派**：协调器可调 agent，但被调 agent **不能再调其它 agent**

### Callable Agents 配置

```json
{
  "callable_agents": [
    {"type": "agent", "id": "{agent_id}", "version": 1},
    {"type": "agent", "id": "{agent_id}", "version": 2}
  ]
}
```

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `type` | string | `"agent"` |
| `id` | string | 已存在 agent 的 ID |
| `version` | integer | 使用的 agent 版本 |

### Session Threads

**列出 thread：**

```
GET /v1/sessions/{session_id}/threads
```

Thread 对象字段：`session_thread_id`、`agent_name`、`status`、`model`。

**Stream thread 事件：**

```
GET /v1/sessions/{session_id}/threads/{thread_id}/stream
```

**列出 thread 事件：**

```
GET /v1/sessions/{session_id}/threads/{thread_id}/events
```

### 多 Agent 事件类型

| 类型 | 描述 |
|------|-------------|
| `session.thread_created` | 协调器派生新 thread。包含 `session_thread_id` 与 `model` |
| `session.thread_idle` | agent thread 完成当前工作 |
| `agent.thread_message_sent` | agent 给另一 thread 发消息。包含 `to_thread_id` 与 `content` |
| `agent.thread_message_received` | agent 从另一 thread 收消息。包含 `from_thread_id` 与 `content` |

### Thread 路由（用于 tool 权限和 custom tool）

当一个 callable_agent thread 需要权限或 custom tool 结果：

- 请求出现在**主 session 流上**，带 `session_thread_id` 字段
- 回复时**包含同一 `session_thread_id`**
- 若 `session_thread_id` 存在：来自子 agent thread 的事件（回复时回写它）
- 若 `session_thread_id` 缺失：来自主 thread 的事件（回复不带它）
- 用 `tool_use_id` 把请求与响应配对

**带 thread 路由的例：**

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

> Research Preview 特性，需申请权限。

### 概览

- **Memory store**：workspace 范围的文本文档集合
- **Memory**：store 中的单个文档（封顶 **100KB / 约 25K token**）
- **Memory version**：每次变更的不可变审计记录（`memver_...`）
- agent 启动前自动检查 store，结束后写入学到的内容
- 每 session **最多 8 个 memory store**

### 创建 Memory Store

```
POST /v1/memory_stores
```

**Request Body：**

```json
{
  "name": "User Preferences",
  "description": "Per-user preferences and project context."
}
```

**Response 包含：**`id`（如 `memstore_01Hx...`）。

### 写/创建 Memory

```
POST /v1/memory_stores/{store_id}/memories
```

**Request Body：**

```json
{
  "path": "/formatting_standards.md",
  "content": "All reports use GAAP formatting. Dates are ISO-8601..."
}
```

按路径 upsert：不存在则创建，存在则替换。

**Safe write（仅创建守卫）：**

```json
{
  "path": "/preferences/formatting.md",
  "content": "Always use 2-space indentation.",
  "precondition": {"type": "not_exists"}
}
```

路径已存在时返回 `409 memory_precondition_failed`。

### 读 Memory

```
GET /v1/memory_stores/{store_id}/memories/{memory_id}
```

返回完整内容。

### 列出 Memory

```
GET /v1/memory_stores/{store_id}/memories?path_prefix=/
```

只返回元数据（不含内容）。带 trailing slash 的 `path_prefix` 用于按目录过滤。

**Memory 对象字段：**`path`、`size_bytes`、`content_sha256`。

### 更新 Memory

```
PATCH /v1/memory_stores/{store_id}/memories/{memory_id}
```

**Request Body：**

```json
{ "path": "/archive/2026_q1_formatting.md" }
```

可改 `content`、`path`（重命名）或两者。重命名到已占路径返回 `409 conflict`。

**Safe content edit（乐观并发）：**

```json
{
  "content": "CORRECTED: Always use 2-space indentation.",
  "precondition": {"type": "content_sha256", "content_sha256": "{sha256_hash}"}
}
```

哈希不匹配返回 `409 memory_precondition_failed`。

### 删除 Memory

```
DELETE /v1/memory_stores/{store_id}/memories/{memory_id}
```

可选传 `expected_content_sha256` 做条件删除。

### 把 Memory Store 挂到 Session

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

**Resource 字段：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `type` | string | `"memory_store"` |
| `memory_store_id` | string | store ID |
| `access` | string | `"read_write"`（默认）或 `"read_only"` |
| `prompt` | string | 本 session 使用此 store 的指令（最多 4096 字符） |

### Memory 工具（挂了 memory store 时自动挂上）

| 工具 | 描述 |
|------|-------------|
| `memory_list` | 列出 memory，可按路径前缀过滤 |
| `memory_search` | 跨 memory 内容做全文搜索 |
| `memory_read` | 读 memory 内容 |
| `memory_write` | 在某路径创建或覆写 memory |
| `memory_edit` | 修改既有 memory |
| `memory_delete` | 删除 memory |

### Memory Versions（审计）

每次变更产生一个不可变 memory version（`memver_...`）。

**版本操作：**

- 第一次 `write`：`operation: "created"`
- `update`（content/path 变化）：`operation: "modified"`
- `delete`：`operation: "deleted"`

#### 列出 version

```
GET /v1/memory_stores/{store_id}/memory_versions?memory_id={mem_id}
```

分页，最新优先。可按 `memory_id`、`operation`、`session_id`、`api_key_id`、`created_at_gte` / `created_at_lte` 时间范围过滤。List 响应**不含**内容 body。

#### 获取一个 version

```
GET /v1/memory_stores/{store_id}/memory_versions/{version_id}
```

返回完整内容 body。

#### Redact 一个 version

```
POST /v1/memory_stores/{store_id}/memory_versions/{version_id}/redact
```

清除内容但保留审计跟踪。**硬清除**：`content`、`content_sha256`、`content_size_bytes`、`path`。**保留**：actor、时间戳、其它字段。

### Precondition 类型

| 类型 | 字段 | 描述 |
|------|--------|-------------|
| `not_exists` | 仅 `type` | 路径已存在则失败 |
| `content_sha256` | `type`、`content_sha256` | 存储的哈希不匹配则失败 |

---

## 10. Outcomes（Define Outcomes）

> Research Preview 特性，需申请权限。
> 需要 beta header：`managed-agents-2026-04-01-research-preview`

### 概览

- 把 session 从对话提升到工作
- 定义结果应该是什么样、如何衡量质量
- harness 配一个独立 **grader**（独立上下文窗口）
- grader 返回逐条目分解
- 反馈回 agent 做迭代

### Rubric

必填。Markdown 文档描述逐条目评分。结构化为可评分的明确条目。

**通过 Files API 上传**：`POST /v1/files`，需要 beta header `files-api-2025-04-14`。

### `user.define_outcome` 事件

```json
{
  "type": "user.define_outcome",
  "description": "Build a DCF model for Costco in .xlsx",
  "rubric": {"type": "text", "content": "# DCF Model Rubric\n..."},
  "max_iterations": 5
}
```

或带 file：

```json
{ "rubric": {"type": "file", "file_id": "file_01..."} }
```

**字段：**

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `type` | string | 是 | `"user.define_outcome"` |
| `description` | string | 是 | 要构建什么 |
| `rubric` | object | 是 | rubric，文本或文件引用 |
| `rubric.type` | string | 是 | `"text"` 或 `"file"` |
| `rubric.content` | string | 文本时是 | 内联 rubric 内容 |
| `rubric.file_id` | string | 文件时是 | Files API 的 file ID |
| `max_iterations` | integer | 否 | 默认 3，最大 20 |

同时只能一个 outcome。串联 outcome：上一个完成后发新 `user.define_outcome`。

### Outcome 事件

#### `span.outcome_evaluation_start`

```json
{
  "type": "span.outcome_evaluation_start",
  "id": "sevt_01def...",
  "outcome_id": "outc_01a...",
  "iteration": 0,
  "processed_at": "2026-03-25T14:01:45Z"
}
```

`iteration`：0-indexed。0 = 首次评测，1 = 首次修订后再评测。

#### `span.outcome_evaluation_ongoing`

```json
{
  "type": "span.outcome_evaluation_ongoing",
  "id": "sevt_01ghi...",
  "outcome_id": "outc_01a...",
  "processed_at": "2026-03-25T14:02:10Z"
}
```

grader 运行期间的心跳。grader 推理对外不可见。

#### `span.outcome_evaluation_end`

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

**Result 取值：**

| Result | 下一步 |
|--------|------|
| `satisfied` | session 转 `idle` |
| `needs_revision` | agent 启动新一轮迭代 |
| `max_iterations_reached` | 不再评测。agent 可在 `idle` 前再做一次最终修订 |
| `failed` | session 转 `idle`。rubric 与任务不匹配 |
| `interrupted` | 仅在中断前已 fire `outcome_evaluation_start` 时发出 |

### 检查 Outcome 状态

```
GET /v1/sessions/{session_id}
```

读 `outcome_evaluations[].result`：

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

### 取回交付物

agent 把输出文件写到容器内 `/mnt/session/outputs/`。

**列出文件：**

```
GET /v1/files?scope_id={session_id}
```

需要 beta header：`files-api-2025-04-14,managed-agents-2026-04-01-research-preview`

**下载文件：**

```
GET /v1/files/{file_id}/content
```

---

## 11. Cloud Container 参考

### 编程语言

| 语言 | 版本 | 包管理器 |
|----------|---------|-----------------|
| Python | 3.12+ | pip、uv |
| Node.js | 20+ | npm、yarn、pnpm |
| Go | 1.22+ | go modules |
| Rust | 1.77+ | cargo |
| Java | 21+ | maven、gradle |
| Ruby | 3.3+ | bundler、gem |
| PHP | 8.3+ | composer |
| C/C++ | GCC 13+ | make、cmake |

### 数据库

| 数据库 | 描述 |
|----------|-------------|
| SQLite | 预装，立即可用 |
| PostgreSQL 客户端 | `psql` 连接外部库 |
| Redis 客户端 | `redis-cli` 连接外部实例 |

> 数据库**服务端**（PostgreSQL、Redis 等）默认**不**运行。容器只含客户端工具。SQLite 完全可用。

### 系统工具

`git`、`curl`、`wget`、`jq`、`tar`、`zip`、`unzip`、`ssh`、`scp`、`tmux`、`screen`。

### 开发工具

`make`、`cmake`、`docker`（受限）、`ripgrep`（`rg`）、`tree`、`htop`。

### 文本处理

`sed`、`awk`、`grep`、`vim`、`nano`、`diff`、`patch`。

### 容器规格

| 属性 | 值 |
|----------|-------|
| 操作系统 | Ubuntu 22.04 LTS |
| 架构 | x86_64（amd64） |
| 内存 | 最多 8 GB |
| 磁盘 | 最多 10 GB |
| 网络 | 默认禁用（在 environment 配置中开启） |

---

## 12. Files API（Outcomes 用）

需要 beta header：`files-api-2025-04-14`

### 上传文件

```
POST /v1/files
```

Multipart 表单上传。用于 outcomes 的 rubric 文件。

### 列出文件

```
GET /v1/files?scope_id={session_id}
```

### 下载文件

```
GET /v1/files/{file_id}/content
```

---

## 完整 API Endpoint 汇总

### Agents

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/agents` | 创建 agent |
| POST | `/v1/agents/{id}` | 更新 agent |
| GET | `/v1/agents/{id}` | 获取 agent |
| GET | `/v1/agents` | 列出 agent |
| GET | `/v1/agents/{id}/versions` | 列出版本 |
| POST | `/v1/agents/{id}/archive` | 归档 |

### Environments

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/environments` | 创建 environment |
| GET | `/v1/environments` | 列出 |
| GET | `/v1/environments/{id}` | 获取 |
| POST | `/v1/environments/{id}/archive` | 归档 |
| DELETE | `/v1/environments/{id}` | 删除 |

### Sessions

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/sessions` | 创建 session |
| GET | `/v1/sessions/{id}` | 获取 session |

### Session Events

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/sessions/{id}/events` | 发事件 |
| GET | `/v1/sessions/{id}/events` | 列出历史事件 |
| GET | `/v1/sessions/{id}/stream` | 流式事件（SSE） |

### Session Threads（多 Agent）

| Method | Path | 描述 |
|--------|------|-------------|
| GET | `/v1/sessions/{id}/threads` | 列出 thread |
| GET | `/v1/sessions/{id}/threads/{thread_id}/stream` | 流 thread 事件 |
| GET | `/v1/sessions/{id}/threads/{thread_id}/events` | 列出 thread 事件 |

### Memory Stores

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/memory_stores` | 创建 |
| GET | `/v1/memory_stores/{id}` | 获取 |
| GET | `/v1/memory_stores` | 列出 |

### Memories

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/memory_stores/{store_id}/memories` | 写/创建（按路径 upsert） |
| GET | `/v1/memory_stores/{store_id}/memories` | 列出 |
| GET | `/v1/memory_stores/{store_id}/memories/{mem_id}` | 获取 |
| PATCH | `/v1/memory_stores/{store_id}/memories/{mem_id}` | 更新 |
| DELETE | `/v1/memory_stores/{store_id}/memories/{mem_id}` | 删除 |

### Memory Versions

| Method | Path | 描述 |
|--------|------|-------------|
| GET | `/v1/memory_stores/{store_id}/memory_versions` | 列出 |
| GET | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}` | 获取 |
| POST | `/v1/memory_stores/{store_id}/memory_versions/{ver_id}/redact` | redact |

### Files

| Method | Path | 描述 |
|--------|------|-------------|
| POST | `/v1/files` | 上传 |
| GET | `/v1/files` | 列出 |
| GET | `/v1/files/{id}/content` | 下载 |

---

## ID 前缀

| 资源 | 前缀 | 例 |
|----------|--------|---------|
| Agent | `agent_` | `agent_01HqR2k7vXbZ9mNpL3wYcT8f` |
| Environment | （多种） | - |
| Session | `sesn_` | `sesn_01...` |
| Session Event | `sevt_` | `sevt_01def...` |
| Memory Store | `memstore_` | `memstore_01Hx...` |
| Memory | `mem_` | `mem_...` |
| Memory Version | `memver_` | `memver_...` |
| Outcome | `outc_` | `outc_01a...` |
| File | `file_` | `file_01...` |
| Session Thread | （多种） | - |