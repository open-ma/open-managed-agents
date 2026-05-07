# Agent IM：Agent 间通信设计

> 在 Managed Agents 平台上构建类 Slack 的 agent 间消息系统的设计洞察，源自对 Claude Code Agent Teams 架构的分析。

## 背景

平台目前通过 `callable_agents` 支持**层级式**子 agent 通信（父调子，子返回结果）。本文档勾画 agent 之间**点对点（IM 式）**通信的设计，使多 agent 协作模式更接近团队聊天工作区。

**参考实现**：Claude Code Agent Teams（`~/.claude/teams/`、SendMessage 工具、文件型邮箱、共享任务列表）。

---

## Claude Code Agent Teams：它是怎么工作的

### 架构

Claude Code 实现了一个 **actor 模型**：每个 agent 是带自己邮箱的孤立 LLM 对话：

```
~/.claude/teams/{team_name}/
├── config.json                 # 团队配置：名字、成员、leader
└── inboxes/
    ├── team-lead.json          # leader 的邮箱
    ├── researcher.json         # 成员邮箱
    └── implementer.json        # 成员邮箱
```

每个邮箱是消息 JSON 数组：

```json
[
  {
    "from": "researcher",
    "text": "Analysis complete, found 3 issues",
    "timestamp": "2025-04-10T10:30:00Z",
    "read": false,
    "color": "blue",
    "summary": "analysis done"
  }
]
```

### 消息生命周期

**Step 1 —— 发送**：Agent A 调 `SendMessage({ to: "agent-b", message: "hello" })`。

**Step 2 —— 路由**：工具用文件级锁（proper-lockfile，指数退避，10 次重试）写入 agent-b 的邮箱文件。

**Step 3 —— 轮询**：Agent B 的主循环按优先级顺序轮询邮箱：

1. `shutdown_request`（最高）
2. 来自 team-lead 的消息
3. 来自任意 peer 的消息
4. 共享任务列表里没人认领的任务

**Step 4 —— 注入 LLM**：消息以 XML 包裹，作为 user message 注入：

```xml
<teammate-message teammate_id="researcher" color="blue" summary="analysis done">
Analysis complete, found 3 issues:
1. SQL injection at user.ts:42
2. XSS at render.ts:88
3. Hardcoded key at config.ts:15
</teammate-message>
```

**Step 5 —— Idle 通知**：处理完后，agent B 给 leader 邮箱发结构化通知：

```json
{
  "type": "idle_notification",
  "from": "agent-b",
  "idleReason": "available",
  "summary": "[to agent-a] I'll fix those issues",
  "completedTaskId": "3",
  "completedStatus": "resolved"
}
```

### 消息消费：优先级与时机

agent 进入 idle 状态时，每 500ms 轮询一次消息，严格按优先级：

```
优先级 1（最高）：shutdown_request
    → 第一遍扫，跳过其它消息
优先级 2：来自 team-lead 的消息
    → leader 指令优先于 peer 闲聊
优先级 3：来自任意 peer 的消息（FIFO）
    → 任意 teammate 的第一条未读
优先级 4（最低）：共享任务列表中无人认领的任务
    → 没有消息时自动认领
```

这一设计避免了 peer 间闲聊把 leader 指令饿死——是协调式多 agent 工作流的关键抉择。

### 用户交互路径

CC 给人类用户提供 3 种与 teammate 交互的方式：

1. **通过 leader**：用户正常输入 → leader 处理 → leader 调 SendMessage 给 teammate。**这是主路径。**
2. **Transcript 视图**：用户切到查看某 teammate 的 transcript，直接输入。消息进入 `pendingUserMessages`（内存队列），teammate 空闲时消费。
3. **`@name` 语法**：用户在 leader 提示符下输 `@researcher analyze this bug`。消息直接写入 researcher 的文件邮箱，**完全绕开 leader 的 LLM**。

3 种路径都只在目标 teammate 空闲（在 turn 之间）时投递。**只有 leader 实时收到用户输入。**

### CC 的关键设计抉择

- **工具是唯一通信通道**：文本输出对 peer 不可见。Agent 必须显式调 `SendMessage`。这让通信可控、可审计、可路由。
- **System prompt 注入**：每个 teammate 的 system prompt 都被追加说明：你身处团队中，必须用 `SendMessage` 通信。
- **共享任务列表**：`TaskCreate`、`TaskList`、`TaskUpdate`、`TaskGet` 操作共享目录（`~/.claude/tasks/{team_name}/`），与短暂消息相比提供持久协调。
- **扁平团队结构**：1 leader + N member。**没有嵌套团队、没有 channel。**
- **没有 mid-turn steering**：agent 在一回合内完整处理一条消息后才接收下一条。这简化了并发，并防止上下文损坏。

### Mid-Turn Steering：什么能、什么不能

CC 架构的关键一面是**没有 mid-turn steering**。一旦 agent 进入一个回合（`runAgent()` 在跑），它就**无法**接收或处理新消息直到该回合结束。

#### CC 的两个 abort controller

每个 teammate 有两个独立的 abort 机制：

```
workAbortController     —— 停止当前回合，agent 还活着 → 进 idle
                          触发：用户按 Escape
lifecycleAbortController —— 杀掉整个 teammate
                          触发：shutdown 批准
```

这两个会在 `runAgent()` 内每一步检查：

```typescript
for await (const message of runAgent({ ... })) {
  if (abortController.signal.aborted) break        // 杀 teammate
  if (workAbortController.signal.aborted) break     // 停本回合
  // ... 正常处理 ...
}
```

**但 abort 不是 steer**——abort 后 agent 回到 idle 等下条消息，**不会**在中途收到替换指令。

#### 消息在回合中到达时会发生什么

```
                             Agent 在 RUNNING        Agent 在 IDLE
                             ──────────────         ─────────────
Agent→Agent（SendMessage）   写入文件邮箱，          每 500ms 轮询，
                             等到 idle              立刻消费

User→Teammate（transcript）  在内存里排队            每 500ms 轮询，
                             （pendingUserMessages） 立刻消费
                             等到 idle

User→Teammate（@name）       写入文件邮箱，          每 500ms 轮询，
                             等到 idle              立刻消费

User→Leader                  直接 —— 用户输入        直接 —— 立刻
                             触发 Escape/abort      启动新回合
```

**只有 Leader（主 CLI agent）能被用户实时 steer。**所有 teammate 在回合中是「聋的」。

#### 为什么没有 mid-turn steering 也感觉很即时

3 个因素制造实时通信的错觉：

1. **UI 反馈即时**：`injectUserMessageToTeammate()` 在排队投递的同时把消息加到 `task.messages` 用于显示。**用户立刻在 transcript 看到。**
2. **回合通常很短**：大多数 agent 回合几秒完成，「消息排队」到「消息消费」的时延几乎察觉不到。
3. **Leader 是快速中继**：用户 → Leader（即时）→ SendMessage 给 Teammate（排队）→ Teammate 在下个 idle 周期取（很快）。

#### 对我们平台的含义

V1 采用相同模型：**没有 mid-turn steering**。消息通过 DO→DO push 投递，但只在回合之间消费。

V2 可能的增强：

| 策略 | 描述 | 复杂度 |
|----------|-------------|------------|
| **`check_messages` 工具** | agent 在回合中可主动查邮箱 | 中 |
| **紧急消息中断** | 高优消息中止当前回合，重注入上下文 | 高 |
| **流式注入** | 在生成期间动态追加 system prompt | 极高 |

---

## 我们平台的设计原则

从 CC 的做法提炼出 3 条核心原则：

### 原则 1：消息是 LLM 的输入，不是人类聊天

消息格式、元数据、注入时机要为帮助**模型**理解并正确行动而设计。**面向人的 UI 是单独的呈现层。**

CC 用 `<teammate-message>` XML 包消息，带 sender ID、color、summary。模型解析这些来理解谁说了什么、决定下一步。

**对我们的含义**：以结构化形式存消息（TeamDO SQLite），但注入 LLM 上下文时转换为 XML/标签格式。带丰富元数据（发送者角色、时间戳、摘要、关联任务 ID），让模型能做优先级判断。

### 原则 2：仅工具中介通信

Agent 文本输出（`agent.message` 事件）只对 client 可见，**peer agent 永远看不到**。所有 agent 间通信必须走 `send_message` 工具。

**这一约束由 system prompt 强制，不是代码强制**。没有显式指令，LLM 会试图通过文本输出和 peer「说话」。

**对我们的含义**：当一个 session 加入 team 时，给它的 system prompt 追加：

```
# Team Context
You are "{member_name}" in team "{team_name}".
Team members: planner (lead), coder, tester.
Use send_message to communicate. Your text output is NOT visible to peers.
Use task_create/task_update to coordinate shared work.
```

### 原则 3：Actor 模型 —— 隔离 + 异步邮箱 + 事件驱动状态同步

每个 agent 独立运行，**没有共享上下文窗口**。协调通过：

- **异步消息**做短暂通信
- **Idle 通知**做状态同步
- **共享任务列表**做持久协调

这是经过验证的分布式系统模式。CC 在 AI agent 场景验证了它。

---

## CC 的局限与我们的改进

| CC 局限 | 根因 | 我们的改进 |
|---------------|-----------|-----------------|
| 文件轮询、100ms+ 延迟 | 本地 FS 没有可靠的 watch | TeamDO → SessionDO HTTP push，亚毫秒级 |
| 退出时消息销毁 | `~/.claude/` 临时文件 | SQLite 持久化，**永久审计跟踪** |
| 单用户 | CLI 工具 | REST API，多用户/多系统 |
| 扁平结构、无 channel | 设计追求简单 | 可扩展到 channel/topic |
| 无消息搜索 | 文件存储 | SQLite 全文搜索 |
| 团队短寿命 | CLI session 生命周期 | 团队持久化，成员动态进出 |
| 无外部集成 | 本地工具 | API 接受 webhook、CI/CD、定时触发 |

---

## 架构：把 CC 适配到 Cloudflare

### 基础设施映射

```
CC（本地文件系统）              →  我们的平台（Cloudflare）
─────────────────────────────────────────────────────────
团队配置 JSON 文件             →  TeamDO（Durable Object + SQLite）
邮箱 JSON 文件                 →  TeamDO messages 表
任务 JSON 文件                 →  TeamDO tasks 表
AsyncLocalStorage 隔离        →  SessionDO 隔离（每个 agent 一个）
文件轮询                       →  HTTP push（TeamDO → SessionDO）
终端 UI（React Ink）           →  WebSocket/SSE → Console UI
```

### 组件总览

```
┌────────────────────────────────────────────────────┐
│ REST API（src/routes/teams.ts）                    │
│ /v1/teams、/v1/teams/:id/members、                 │
│ /v1/teams/:id/messages、/v1/teams/:id/tasks         │
├────────────────────────────────────────────────────┤
│ TeamDO（src/runtime/team-do.ts）                   │
│ SQLite：members、messages、tasks                    │
│ 路由消息：TeamDO → 目标 SessionDO                   │
├────────────────────────────────────────────────────┤
│ Agent 工具（src/harness/team-tools.ts）            │
│ send_message、check_messages                        │
│ task_create、task_list、task_update、task_get       │
├────────────────────────────────────────────────────┤
│ Session 集成（session-do.ts）                       │
│ POST /team-message endpoint                         │
│ 自动把未读消息注入 agent 上下文                     │
│ session 是 team 成员时挂上 team 工具                │
└────────────────────────────────────────────────────┘
```

### TeamDO Schema

```sql
CREATE TABLE team_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE members (
  name       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  role       TEXT DEFAULT 'member',  -- 'lead' | 'member'
  status     TEXT DEFAULT 'idle',    -- 'idle' | 'active' | 'offline'
  joined_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_name  TEXT NOT NULL,
  to_name    TEXT,                   -- NULL = 广播
  content    TEXT NOT NULL,
  summary    TEXT,
  read       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'pending', -- pending | in_progress | completed
  owner       TEXT,                   -- 成员名
  blocks      TEXT DEFAULT '[]',      -- 任务 ID JSON 数组
  blocked_by  TEXT DEFAULT '[]',      -- 任务 ID JSON 数组
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT
);
```

### 消息流

```
Agent A（SessionDO-A）        TeamDO              Agent B（SessionDO-B）
    │                           │                        │
    │ send_message(to:"B",      │                        │
    │   message:"hello")        │                        │
    │──────POST /messages──────▶│                        │
    │                           │ INSERT 进 messages     │
    │                           │ 查 B 的 session_id     │
    │                           │                        │
    │                           │──POST /team-message───▶│
    │                           │                        │ append 到 event log
    │                           │                        │ 通过 WebSocket 广播
    │                           │                        │
    │                           │                        │ 若 idle → 自动触发
    │                           │                        │   harness run
    │                           │                        │ 若 running → 排队
    │                           │                        │   下回合注入
    │                           │                        │
    │◀──────"sent OK"───────────│                        │
```

### Idle 通知流

```
Agent B 完成处理
    │
    │ session 状态 → idle
    │
    │──POST /status {"status":"idle"}──▶ TeamDO
    │                                      │
    │                          更新 members.status = 'idle'
    │                                      │
    │                          POST /team-message ──▶ Leader 的 SessionDO
    │                          { type: "idle_notification",
    │                            from: "agent-b",
    │                            idleReason: "available",
    │                            completedTaskId: "3" }
```

### 上下文注入

当一个属于 team 的 session 开始处理一个回合时：

1. 从 TeamDO 拉未读消息（`GET /messages/{member_name}`）
2. 格式化为 XML 标签前置到对话：

```xml
<team-messages team="{team_name}" member="{member_name}">
  <message from="planner" time="10:30:00" summary="task assignment">
    Please implement the /api/users CRUD endpoints.
  </message>
  <message from="tester" time="10:35:00" summary="test ready">
    Integration test suite is ready for your endpoints.
  </message>
</team-messages>
```

3. 在 TeamDO 把消息标已读
4. 把 team 上下文（成员列表、角色信息）追加到 system prompt
5. 把 team 工具（`send_message`、`task_*`）注入 agent 工具集

---

## Agent 工具规格

### `send_message`

```typescript
{
  name: "send_message",
  description: "Send a message to a team member or broadcast to all.",
  parameters: {
    to:      { type: "string", description: '收件人名，或 "*" 表示广播' },
    message: { type: "string", description: "消息内容" },
    summary: { type: "string", description: "5-10 词预览", optional: true },
  }
}
```

### `check_messages`

```typescript
{
  name: "check_messages",
  description: "Check for unread messages from team members.",
  parameters: {}
}
```

### `task_create`

```typescript
{
  name: "task_create",
  description: "在团队任务列表中创建一个共享任务。",
  parameters: {
    subject:     { type: "string" },
    description: { type: "string" },
    owner:       { type: "string", optional: true },
  }
}
```

### `task_list`

```typescript
{
  name: "task_list",
  description: "列出团队任务列表中的所有任务。",
  parameters: {}
}
```

### `task_get`

```typescript
{
  name: "task_get",
  description: "获取一个任务的完整详情。",
  parameters: {
    task_id: { type: "string" }
  }
}
```

### `task_update`

```typescript
{
  name: "task_update",
  description: "更新任务的状态、owner 或依赖。",
  parameters: {
    task_id:        { type: "string" },
    status:         { type: "string", enum: ["pending", "in_progress", "completed"], optional: true },
    owner:          { type: "string", optional: true },
    add_blocks:     { type: "array", items: "string", optional: true },
    add_blocked_by: { type: "array", items: "string", optional: true },
  }
}
```

---

## 新事件类型

```typescript
// Team messaging
"team.message_sent"       // agent 发了一条 peer 消息
"team.message_received"   // agent 收到一条 peer 消息

// Team membership
"team.member_joined"      // session 加入 team
"team.member_left"        // session 离开 team
"team.member_idle"        // 成员变 idle（状态同步）

// Team tasks
"team.task_created"       // 共享列表中创建任务
"team.task_updated"       // 任务状态/owner 改变
```

所有事件都同时持久化到 TeamDO 与每个 session 的事件日志，**支持完整可观测**。

---

## API Endpoint

```
POST   /v1/teams                       创建团队
GET    /v1/teams                       列出团队
GET    /v1/teams/:id                   获取团队（成员、状态）
DELETE /v1/teams/:id                   解散团队

POST   /v1/teams/:id/members           添加成员（绑定 session）
DELETE /v1/teams/:id/members/:name     移除成员
GET    /v1/teams/:id/members           列出成员及状态

POST   /v1/teams/:id/messages          发消息（外部/API）
GET    /v1/teams/:id/messages          消息历史

GET    /v1/teams/:id/tasks             列出任务
POST   /v1/teams/:id/tasks             创建任务（外部）
PUT    /v1/teams/:id/tasks/:task_id    更新任务（外部）
```

---

## 总结：CC Teams vs 我们的 Agent IM

| 维度 | CC Agent Teams | 我们的 Agent IM |
|-----------|---------------|--------------|
| Runtime | 本地终端（单机） | Cloudflare 云（分布式） |
| 消息存储 | 文件系统 JSON | TeamDO SQLite |
| 消息路由 | 文件读写 + 轮询 | TeamDO → SessionDO HTTP push |
| 实时 | 轮询（有延迟） | WebSocket push 给 client |
| 可观测 | 终端 UI（React Ink） | Web Console + SSE 事件流 |
| 团队创建 | agent 通过 TeamCreate 工具 | REST API + agent 工具 |
| Agent 隔离 | 进程级（AsyncLocalStorage / tmux） | session 级（每个 SessionDO 独立） |
| 任务列表 | 文件系统 JSON | TeamDO SQLite |
| 生命周期 | CLI 退出即销毁 | 持久化，能挺过重启 |
| 多用户 | 单用户 | 通过 API 多用户 |
| 外部集成 | 无 | API 接受 webhook、CI/CD |

**一句话总结**：CC Teams 是「本地多终端」；我们的 Agent IM 是「云原生 agent 聊天工作区」。

---

## 愿景：人类-Agent 协作

除了 IM 实现细节，agent 的两个根本属性会重塑协作的方式——并直接影响平台的长期架构。

### 工具即身份

在人类团队中，一个人的角色由其技能定义（前端工程师、DBA、SRE）。Agent 的角色由它的**工具配置**定义：

```
Agent Config = 模型 + System Prompt + Skills + MCP Servers + CLI 工具
              = 一份完整的「岗位定义」
```

例：

```
┌─ Agent Config "db-admin" ─────────────────────┐
│ Skills:  sql-optimizer, migration-planner     │
│ MCP:     postgres-mcp, redis-mcp              │
│ CLI:     psql, pg_dump, redis-cli             │
│ Model:   claude-sonnet（够用，便宜）           │
└───────────────────────────────────────────────┘

┌─ Agent Config "security-reviewer" ────────────┐
│ Skills:  code-audit, cve-scanner              │
│ MCP:     github-mcp, snyk-mcp                 │
│ CLI:     semgrep, trivy, git                  │
│ Model:   claude-opus（需要深度推理）           │
└───────────────────────────────────────────────┘
```

创建一个 agent 不是「招一个人」，而是**实例化一个岗位**。Agent config 是可复用模板；session 是运行实例。

这对消息路由有直接影响。除了按名字路由，我们还能按**能力**路由：

```
// 按名字路由（当前，CC 风格）
send_message({ to: "db-admin-1", message: "check slow queries" })

// 按能力路由（未来）
send_message({ to: { capability: "sql-optimizer" }, message: "check slow queries" })
// TeamDO 找一个空闲的、具备该技能的 agent，自动路由
```

这把团队变成一个 **service mesh** —— 消息路由到「谁能处理这个」，而不是某个具体个人。

### 无限扩展

人类团队有硬约束：招人要几个月，每天工作 8 小时，超过 7-8 人就触达 Brooks 定律的沟通开销上限。

Agent 没有这些约束：

```
要 10 个 coder 并行？      → 用同一个 agent config 实例化 10 个 session
凌晨 3 点生产告警？        → agent 7×24 在线
任务完成不再需要？         → 销毁 session，零持续成本
要不同专长？               → 换工具配置，瞬间换岗
```

这从根本上改变团队拓扑：

#### 动态组建：团队是动词，不是名词

CC 的团队是静态的——成员在创建时固定。**有了无限扩展，团队应该是动态的**：

```
用户："重构支付模块"
        │
        ▼
  Planner agent 分析任务
        │
        ▼
  ┌── 决定所需能力 ──┐
  │                  │
  ▼                  ▼
要 3 个 coder        要 1 个 DBA
（3 个文件并行改）    （schema 迁移）
  │                  │
  ▼                  ▼
从 "coder" config   从 "db-admin" config
实例化 3 个 session 实例化 1 个 session
  │                  │
  ▼                  ▼
并行干活            干活
  │                  │
  ▼                  ▼
完成 → 销毁 session 完成 → 销毁 session
```

**团队不是一个固定成员组——而是为特定任务临时编成的阵型。**

#### Fan-Out：横向任务拆分

人类团队做不到的事 —— 把一个任务拆给 N 个相同的 agent：

```
任务："给 200 个 API endpoint 写测试"

人类团队：1 个 tester × 200 endpoint = 几周

Agent 团队：
  ┌→ tester-1：endpoint 1-20    → 完成、销毁
  ├→ tester-2：endpoint 21-40   → 完成、销毁
  ├→ tester-3：endpoint 41-60   → 完成、销毁
  │  ...
  └→ tester-10：endpoint 181-200 → 完成、销毁

  10 agent × 每个 20 endpoint = 几小时
```

对 IM 系统而言，这意味着消息可以发给的不是单 agent，而是 **agent pool** —— 系统在可用实例间负载均衡：

```
send_message({
  to: { agent_config: "tester", pool: true },
  message: "test endpoints 41-60"
})
// TeamDO 路由给一个空闲 tester 实例，或拉起一个新的
```

#### 递归层级：任意 agent 都能当 leader

任意 agent 都能 spawn 子 agent，形成递归团队结构：

```
Human
  └→ Planner（leader）
       ├→ Frontend Lead（sub-leader）
       │    ├→ coder-1
       │    ├→ coder-2
       │    └→ coder-3
       ├→ Backend Lead（sub-leader）
       │    ├→ coder-4
       │    ├→ coder-5
       │    └→ db-admin
       └→ QA Lead（sub-leader）
            ├→ tester-1
            ├→ tester-2
            └→ tester-3
```

平台已经通过 `callable_agents` 支持层级委派。结合 team IM，就能做递归组合 —— **团队中的团队**。

### 抽象栈

工具 + 规模一起产生分层抽象：

```
Agent Config（岗位模板）
    = 模型 + Prompt + Skills + MCP + CLI 工具
    ↓
Agent Instance（运行 worker）  × N
    = Agent Config + Session + Sandbox
    ↓
Team（动态阵型）
    = {Agent Instances} + 任务列表 + 消息总线
    ↓
Workspace（协作空间）
    = {Teams} + 共享记忆 + 共享产物 + 人类成员
```

### 混合主动协作

终态不是「人类命令 agent」也不是「agent 完全自治」，而是 **mixed-initiative** —— 人和 agent 都能发起、回应、上调：

| 模式 | 发起方 | 例子 | 时延容忍 |
|------|-----------|---------|-------------------|
| **Command** | 人 → Agent | 「构建特性 X」 | 低 |
| **Consult** | Agent → 人 | 「这里用 async 还是 sync？」 | 中（人可能在忙） |
| **Notify** | Agent → 人 | 「Task #3 完成，PR 已开」 | 高（异步通知） |
| **Coordinate** | Agent → Agent | 「我把 API 写好了，请写测试」 | 低 |
| **Escalate** | Agent → 人 | 「我已经失败 3 次，需要帮助」 | 中 |

具体场景：

```
09:00  人在 workspace 发：
       "本周要把 user management API 上线"

09:01  Planner agent 响应：
       → 创建 5 个任务，分给 coder 与 tester agent

09:15  Coder agent → 人（consult）：
       "支持软删除吗？这影响 schema 设计。"

09:20  人："要，用 deleted_at 列"

09:21  Coder 自主继续

10:30  Coder → Tester（coordinate）：
       "GET/POST /users 已就绪，请测试"

10:35  Tester → Coder（coordinate）：
       "POST /users 缺 email 校验，测试失败"

10:36  Coder 自动修复，再次通知 tester

10:40  Tester → workspace（notify、广播）：
       "全部测试通过 ✓"

       ... 人去开会，agent 继续 ...

12:00  人回来，看 workspace 状态：
       3/5 任务完成，1 个被阻塞（等审批），1 个进行中

12:01  人审批阻塞任务，工作继续
```

**人做了 3 次干预**（目标、决策、审批）。Agent 处理了其它一切——规划、写代码、测试、协调、错误恢复。

### 平台含义

| 能力 | 当前状态 | 需要的演进 |
|------------|--------------|------------------|
| Team 成员 | 静态 session 绑定 | 动态：按需从 agent config 实例化 |
| 消息路由 | 按成员名 | 按名 + 按能力 + 按 pool |
| Fan-out | 不支持 | `send_message` 给 agent pool 自动分发 |
| 实例生命周期 | 手动创建/销毁 | 任务分配时自动创建，完成后自动销毁 |
| 团队结构 | 扁平 | 递归：sub-team、agent-as-leader |
| 人类参与 | 外部（API 调用方） | 内部（workspace 成员，带 consult/notify 流程） |
| 自治程度 | 每个 agent 一致 | 按任务：低（审批门）→ 高（fire-and-forget） |

### 核心架构：任务触发 + 事件日志

分析 CC 架构、既有产品（如 Slock.ai）、各种 UI 范式（Slack 风聊天、空间画布、流水线视图、决策收件箱）后得出的根本洞察是：**后端协议与呈现层是完全独立的两件事**：

```
已定（按这个建）：
  任务触发 + 事件日志 = 后端协调协议
  TeamDO、send_message、共享任务、事件流

未定（以后探）：
  呈现层 = 人类如何看见并与之交互
  聊天视图 / 画布视图 / 决策收件箱 / 流水线视图 / 全部都行
```

后端做两件事：

1. **任务触发**：agent 发消息、创建/更新任务。消息触发其它 agent 唤醒并行动。任务跟踪共享状态与依赖。这是协调协议——**与是否有人类在看无关**。
2. **事件日志**：每条消息、任务变更、agent 状态转换都作为类型化事件持久化到 session 与 team 事件日志。**事件是真理之源**。任何呈现层只是事件流之上的视图。

这种分离意味着：

- 同一份事件流可以同时驱动 chat UI、canvas、dashboard、CLI
- 后端可与任何 UI 决策独立构建并验证
- agent 不关心人类怎么消费事件；它们通过工具与任务通信
- 新呈现范式可以被探索而不动协调层

人类与 agent 的交互模型是 **agent-driven、human-supervisory**：agent 干活并自我协调；人类设定目标、被询问时做决策、在被请求时审批。**呈现层应当为这个模型优化——最小化人类在 UI 中的时间，而非最大化。**

### 设计指导

> **Agent IM 不是给 AI 用的聊天软件。它是 workspace 的协调层——人类设定方向，agent 执行并自组织，系统通过实例化能力扩展，而不是通过加人头。**

---

## Multica 对比：我们已经解决的、我们真正缺的

> 2026-04-12 增补，源自对 [multica](https://github.com/anthropics/multica) 的深入分析——一个开源的、带本地 daemon 执行的 managed agents 平台。

### 我们相对 Multica 的架构优势

| 关切 | Multica 做法 | 我们做法 | 为什么我们更好 |
|---|---|---|---|
| **工作上下文** | `PriorSessionID` + `PriorWorkDir` —— 按 (agent, issue) 存上次 session/workdir，CLI `--resume` 恢复 | SessionDO 事件日志 —— 所有历史持久化在 DO SQLite，harness 自动从事件日志重建 | Multica 是个 hack：CLI 进程一死，状态没了，只剩 session ID 让你「resume」。**我们的事件日志就是状态——崩溃恢复免费。** |
| **Agent 身份** | 单独 `agent` 表 + `agent_runtime` 表 + `agent_task_queue` —— agent 是 DB 行，runtime 是另一个概念 | Session = agent 实例。Agent config 创建 session，**session 就是持续运行的 agent**。 | 没有阻抗失配。Multica 要 3 张表表达的事，我们用一个 DO 解决。 |
| **任务路由** | `ClaimTask` —— daemon 轮询任务，原子认领。Runtime sweeper 检查 stale claim。 | TeamDO → SessionDO HTTP push。消息直送目标 session。 | Pull vs push。Multica daemon 必须每 3 秒轮询。**我们消息瞬时到达。** |
| **协调** | 扁平：用户 assign issue → 一个 agent 执行。**没有 agent 间通信。** | Actor 模型：agent 发消息、建共享任务、自组织。 | Multica agent 是孤立 worker。**我们是协作的 teammate。** |

### 我们真正缺的（vs Multica）

剔除假性差距（工作上下文、持久身份、成本归因 —— 都已被 SessionDO 解决）后，真实差距是：

#### 1. 外部触发机制

**Multica 有**：Issue 分配 → 任务。@mention → 任务。聊天消息 → 任务。三个自然入口。

**我们缺**：让外部事件（GitHub webhook、Slack 消息、cron）自动创建 team 任务并唤醒 agent 的方式。TeamDO 的 API endpoint 已定义，但「事件 → 任务」的桥还没设计。

**方案草图**：触发系统——webhook endpoint，把外部事件映射到某个 TeamDO 上的 `send_message` 或 `task_create` 调用。可以是简单的 Worker 路由。

#### 2. 本地 agent 执行

**Multica 有**：完整 daemon —— 轮询 server，本地执行 agent CLI，把输出流式回传，session 续接，repo 缓存。**代码永不离开开发者机器。**

**我们缺**：任何本地执行路径。一切都跑在 Cloudflare Container 中。

**方案草图**：轻量本地 daemon（Node.js 或 Go），轮询我们的 API，本地跑 agent CLI，通过现有 session event API 上报。**镜像 multica 的 daemon 架构，只是连到我们的 API。**

#### 3. 失败恢复策略

**Multica 做法**：每 30s 一次 runtime sweeper —— 标记下线 runtime、自动失败孤儿任务。**这是「放弃，让人类重试」。**

**我们的优势**：SessionDO 的事件日志意味着我们能比「失败」做得更好：

```
Agent 超时或崩溃
  │
  ├─ 选项 1：重启 harness
  │  SessionDO 重读事件日志 → 重建上下文 → 继续
  │  （已经支持：harness 崩溃恢复）
  │
  ├─ 选项 2：升级模型
  │  同一 session，切到更强模型（model card 系统）
  │  agent 在历史里看到先前工作，用更强能力重试
  │
  ├─ 选项 3：拆解
  │  agent review 事件日志，把剩余工作拆成子任务
  │  通过 TeamDO 发给其它 agent
  │
  └─ 选项 4：升级到人类
  │  发通知（Mixed-Initiative 中的「escalate」模式）
  │
  关键洞察：事件日志保留**所有**先前工作。
  「从失败处恢复」是免费的。
  Multica 做不到 —— CLI 进程死 = 状态丢。
```

**实施方案**：在 SessionDO 中加一个恢复策略——可按 agent 配置。**默认**：harness 重启最多 3 次，然后 escalate。**不需要 sweeper**，因为 DO 不像外部 daemon 那样会「悄悄死掉」。

### 总结

我们设计与 multica 之间的差距比看起来**小得多**。Multica 的大部分复杂度（runtime 注册、心跳、sweeper、session 续接、workdir 持久化）都是为了补偿 daemon 模型的架构限制。**我们的 SessionDO 让大部分这些都不再必要。**

3 个真实差距（外部触发、本地 agent、失败恢复）都是**增量特性，不是架构重做**。协调层（TeamDO + agent 工具 + 消息路由）是核心，已经完全设计好了。