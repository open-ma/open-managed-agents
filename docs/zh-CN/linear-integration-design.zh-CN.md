# Linear 集成 —— 设计

**状态**：草稿（头脑风暴产物，待实施计划）
**日期**：2026-04-20
**作者**：open-managed-agents 贡献者

> ## 实施现实（构建后增补，2026-04-20）
>
> 实施在几处偏离了本规格。先读这一段，本文剩余内容仍然是原始设计意图。
>
> 1. **没有自建 MCP server。** §6/§8 原本描述了一个 gateway 托管的 Linear MCP server（约 500 行 LoC，包含工具定义 + JSON-RPC 派发）。构建时我们意识到可以直接把 agent 现有的 `mcp_servers` 配置指向 Linear 托管 MCP（`https://mcp.linear.app/mcp`），通过 OMA 出站 vault 机制透明注入 access token。**净代码：MCP server 0 行。**
>
> 2. **能力强制是残留代码。** §6 描述了 per-publication 能力限制。**没有自家的 MCP 代理，能力检查就没地方落脚**——agent 直接和 Linear 托管 MCP 说话。能力集存在 DB 里、UI 上可编辑，但**v1 实际上不限制任何东西**。
>
> 3. **token 静态加密仍在；但传输靠 vault，不是 gateway-MCP。** Linear access token 在 `linear_installations` 中以 AES-GCM 加密存储，复制为一个 per-installation 的 OMA vault 凭据，按 `mcp.linear.app` 主机名匹配。沙箱已有的出站 Worker 注入 bearer 头。**沙箱永远看不到 token。**规格的安全目标全部达到。
>
> 4. **Console UI 在 `packages/integrations-ui` 出。** 新包，自己的 React/JSX tsconfig，被根 `tsc` 排除。`apps/console` 通过薄封装挂载页面（如给 publish wizard 注入 `loadAgents`）。
>
> 5. **per-agent App 是 Public 还是 Private** 由发布者决定；Private 是自托管单 workspace 用的默认值。
>
> 6. **Internal endpoint 鉴权。** 由 main 通过 service binding 调到 gateway 的 endpoint 需要 `X-Internal-Secret` header。main 与 gateway 必须共享同一个 `INTEGRATIONS_INTERNAL_SECRET`。
>
> 7. **存储债务承认在案。** OMA 大多数实体（sessions、agents、environments、vaults）都在 KV 里。KV 没有真正的索引。本集成新增的表（`linear_*`）放在 D1，是合适的位置；旧 KV → D1 的迁移是另一项独立工作。

---

## 1. 摘要

本文档为 Open Managed Agents（OMA）规定 Linear 集成。该集成让用户能把自己的 OMA agent 变成 **Linear teammate**——agent 在 Linear workspace 中作为真实用户出现，可以被 `@`-mention、被指派 issue、发评论、改状态，像人类成员一样在 issue 线程中参与。

**每个 agent 注册自己独立的 Linear OAuth App**，作为有 autocomplete + assignee dropdown 存在感的一等 Linear 用户出现（「完整身份」）。

新建的 Cloudflare Worker（`apps/integrations`）是 Linear 与既有 OMA 平台之间的网关，承载 OAuth 流程、webhook 接收、以及在运行时把 Linear API 工具暴露给 agent 的 MCP server。

---

## 2. 动机与目标

### 2.1 我们在做什么

OMA 今天是一个 AI agent 的 meta-harness——用户定义 agent（配置：模型、system prompt、工具），创建 session，通过 API 或 Console 跑。**与团队既有的协作面没有任何集成。**

对已经在用 Linear 做 issue 跟踪的团队，把任务委派给 AI agent 最自然的方式就是按对待人类同事的方式委派——`@`-mention 或 assign。本集成让这件事成为可能。

### 2.2 目标

- **G1**：拥有现有 OMA agent 的用户能把它发布到 Linear workspace，让 agent 成为 teammate（可 mention、可 assign、可评论、可改状态）。
- **G2**：非工程师可在 5 分钟内完成 setup。
- **G3**：Agent 在 Linear 中的身份是 per-agent（不是共享的「OMA bot」），支撑「agent 即同事」叙事。
- **G4**：所有 Linear 侧流量集中在独立 Cloudflare Worker（`apps/integrations`），让既有 main worker 专注于平台第一方 API。
- **G5**：**Linear API token 永远不到 agent 沙箱**；只在 gateway 内持有，agent 通过受限 MCP server 访问。
- **G6**：架构基础能扩展到将来的集成（Slack、GitHub、Discord），通过在 `apps/integrations/providers/` 下添加新 provider 即可。

### 2.3 非目标

- 造一个 Linear 的竞品，或在 OMA 内复刻 Linear 风格 UI（Multica 的路线）。
- 客户请求收件箱、project / cycle / milestone 驱动工作流（v1）。
- 多 OMA 用户共同拥有同一 Linear workspace 安装（v1：每安装单一 owner）。
- 用浏览器扩展给 Linear UI 加虚拟 `@` 自动补全条目。
- 来自 OMA 的移动推送通知。

---

## 3. 架构概览

```
┌──────────────┐  webhook  ┌──────────────────────────┐  service ┌──────────────┐
│   Linear     │──────────▶│ apps/integrations         │  binding │  apps/main   │
│  Workspaces  │◀──────────│ gateway worker            │─────────▶│  + sandbox   │
└──────────────┘  GraphQL  │ integrations.<host>       │          └──────────────┘
                            └─────────┬────────────────┘                ▲
                                      │  MCP（HTTP）Linear 工具         │
                                      └──────────────────────────────────┘
```

### 3.1 包分层（依赖反转）

集成拆成 4 个包，**provider 逻辑**（Linear 特定行为）与 **runtime**（Cloudflare Workers）和**存储**（D1/KV）解耦。组合根 ——`apps/integrations`—— 把具体实现注入 `packages/integrations-core` 定义的抽象 port。这样能让 Linear 逻辑无需 workerd 即可单测，让我们能在不动 gateway worker 代码的前提下加 Slack / GitHub provider，并防止 Linear 的细节渗到平台 main worker。

```
                     ┌──────────────────────────────────────┐
                     │  packages/integrations-core           │
                     │ （仅抽象接口，                         │
                     │  无 Cloudflare、无 Linear）            │
                     │                                       │
                     │  - IntegrationProvider                │
                     │  - WebhookValidator port              │
                     │  - InstallationRepo / PublicationRepo │
                     │  - WebhookEventStore（幂等）          │
                     │  - SessionCreator port                │
                     │  - McpToolRegistry                    │
                     │  - Crypto port（AES-GCM）             │
                     └─────────┬───────────────┬─────────────┘
                               │               │
                  实现        │               │   实现
                               ▼               ▼
        ┌────────────────────────────┐   ┌───────────────────────────────┐
        │  packages/linear           │   │  packages/integrations-       │
        │ （provider 实现，纯）      │   │  adapters-cf                  │
        │                            │   │ （Cloudflare 特定实现）       │
        │  - LinearProvider          │   │                               │
        │  - GraphQL client          │   │  - D1Installation/PublicationRepo
        │   （依赖 HTTP port）       │   │  - KvWebhookEventStore        │
        │  - HMAC validator          │   │  - ServiceBindingSessionCreator│
        │  - Routing rules           │   │  - WebCryptoAesGcm            │
        │  - createAsUser injection  │   │  - WorkerHttpClient           │
        │  - Linear MCP tools        │   │                               │
        └─────────────┬──────────────┘   └─────────────┬─────────────────┘
                      │                                │
                      └────────────┬───────────────────┘
                                   │ 都被以下包消费
                                   ▼
                     ┌──────────────────────────────────────┐
                     │  apps/integrations                    │
                     │ （组合根，薄）                         │
                     │                                       │
                     │  - Hono routes                        │
                     │  - wire.ts：实例化 adapter，注入        │
                     │    LinearProvider                      │
                     │  - Cloudflare env / bindings          │
                     └──────────────────────────────────────┘
```

**依赖方向（严格）：**

- `integrations-core` 在本设计中不依赖任何东西（仅 `packages/shared` 的类型）。
- `linear` 仅依赖 `integrations-core` 与 `packages/shared`。**禁止 import `cloudflare:workers`、`hono`、D1 类型，或任何 runtime 特定东西。**
- `integrations-adapters-cf` 仅依赖 `integrations-core` 与 Cloudflare runtime API。
- `apps/integrations` 依赖三者。**它不持有领域逻辑**，只做实例化与装配。

这意味着：

- `LinearProvider` 可以用 in-memory fake repo + fake HTTP client 单测。
- 未来的 Slack provider 落在 `packages/slack/`，实现同一个 `IntegrationProvider` 接口，gateway 在 `wire.ts` 加一行即可。
- 如果有一天我们换掉 Cloudflare（或者要把 MCP server 放到 `apps/main` 里做本地开发），只需要替换 `integrations-adapters-cf`。

### 3.2 组合根：`apps/integrations`

独立的 Cloudflare Worker，部署在 `integrations.<host>`，与 `apps/main` 分离。它是个**薄** worker —— Hono 路由 + 组合根（`wire.ts`），从 binding 构造 adapter 与 provider。**不含任何 Linear 特定逻辑，不含业务规则。**

职责：

- 挂 Hono 路由：OAuth（install、callback）、webhook 接收、setup-link 交接、MCP server、`/health`。
- 在 `wire.ts` 里：构造具体 adapter 实例（D1 repo、KV 幂等 store、service-binding session creator、AES-GCM 加密），注入到 `LinearProvider`。
- 把已装配的 `IntegrationProvider` 实例挂在 `/<provider>/...` 路由前缀下。**加新 provider = wire.ts 一行 + 路由注册。**

```
apps/integrations/
└── src/
    ├── index.ts            Hono app、路由注册
    ├── env.ts              Cloudflare binding 类型
    ├── wire.ts             组合根
    └── routes/
        ├── health.ts
        └── linear/
            ├── install.ts
            ├── callback.ts
            ├── webhook.ts
            ├── setup-link.ts
            └── mcp.ts
```

### 3.3 Bindings

```
apps/integrations bindings：
- AUTH_DB             （D1，与 main 共享；新增表）
- INTEGRATIONS_KV     （KV；OAuth state、webhook 幂等、setup-link token）
- MAIN                （指向 main worker 的 service binding，用于创建 session）
- MCP_SIGNING_KEY     （secret；签发给 agent 的 JWT）
```

### 3.4 请求生命周期

**OAuth 安装（per-agent App）：**

1. 用户在 Console 点「Publish agent」。
2. Console 调 main worker 创建 `pending_setup` 状态的 `linear_publication` 记录。
3. Main 返回 setup token；用户看到可复制凭据 + 通往 Linear 开发者设置的深链。
4. 用户在 Linear 注册 App，回填 `client_id`/`client_secret` 到 OMA 的 integrations worker。
5. Integrations worker 通过测试 OAuth 握手校验凭据；成功则把 publication 转为 `awaiting_install`，用户点安装链接。
6. Linear 重定向到 integrations worker 的 callback；worker 用 **per-publication** client 凭据换 access token，加密存储到 `linear_apps`，并把 publication 标 `live`。

**Webhook 事件：**

1. Linear POST 到 `integrations/linear/webhook/app/<app_id>`。
2. Worker 用安装的 webhook secret 校验 HMAC。
3. Worker 检查 `delivery_id` 在 `linear_webhook_events` 中以做幂等。
4. Webhook 落到 publication 专属 endpoint，所以与 publication 的绑定是直接的。
5. Worker 调 `MAIN.fetch("/v1/sessions", ...)` 创建或续接 OMA session，把 Linear 上下文（workspace、issue、comment）作为 session metadata 附上。
6. Worker 把 session id 写回 `linear_webhook_events`。

**Agent → Linear 回调（session 中）：**

1. Main worker 给 agent session 注入一个 MCP server URL，用 `MCP_SIGNING_KEY` 签 JWT，scope 为 publication + issue。
2. Agent 通过 MCP 调 Linear 工具。Integrations worker 校验 JWT、查 publication 的 access token、转发到 Linear 的 GraphQL API。

### 3.5 核心抽象（`packages/integrations-core`）

下面的接口是每个 provider 都要满足的契约。**它们故意 runtime 无关**——不带 Cloudflare 类型、不带 Linear 类型——这样 provider 可用 in-memory fake 单测。

```ts
// packages/integrations-core/src/provider.ts
export interface IntegrationProvider {
  readonly id: string; // 'linear'，将来：'slack'、'github' …

  /** 给 pending_setup 的 publication，返回下一步 UI payload。 */
  startInstall(input: StartInstallInput): Promise<InstallStep>;

  /** 用户回填凭据 / 完成 OAuth 时继续 install。 */
  continueInstall(input: ContinueInstallInput): Promise<InstallStep | InstallComplete>;

  /** 校验并派发 webhook payload。返回 provider 解析出的 publication。 */
  handleWebhook(req: WebhookRequest): Promise<WebhookOutcome>;

  /** 返回已发布 agent 在 session 时拿到的 MCP 工具描述。 */
  mcpTools(scope: McpScope): Promise<McpToolDescriptor[]>;

  /** 执行来自 agent session 的工具调用。 */
  invokeMcpTool(scope: McpScope, toolName: string, input: unknown): Promise<unknown>;
}
```

（以下 `packages/integrations-core/src/persistence.ts`、`ports.ts` 中的接口与英文版完全一致，类型签名照原样保留。）

`packages/linear/` 实现 `IntegrationProvider`，仅依赖这些 port。`packages/integrations-adapters-cf/` 用 Cloudflare 原语（D1、KV、service binding、Web Crypto、fetch）实现这些 port。

### 3.6 Bindings → adapter 映射

每个 Cloudflare binding 都被恰好一个 adapter 包装，满足某个 port。**任何 provider 都不直接读 binding。**

| Binding | Adapter | Port |
|---|---|---|
| `AUTH_DB`（D1） | `D1InstallationRepo`、`D1PublicationRepo`、`D1IssueSessionRepo`、`D1SetupLinkRepo`、`D1AppRepo` | `*Repo` |
| `INTEGRATIONS_KV` | `KvWebhookEventStore` | `WebhookEventStore` |
| `MAIN`（service binding） | `ServiceBindingSessionCreator` | `SessionCreator` |
| `MCP_SIGNING_KEY`（secret） | `WebCryptoJwtSigner` | `JwtSigner` |
| Worker `fetch` | `WorkerHttpClient` | `HttpClient` |
| Web Crypto API | `WebCryptoAesGcm` | `Crypto` |

`apps/integrations/src/wire.ts` 是唯一同时知道两层细节的文件。

---

## 4. 数据模型

所有表都在 `AUTH_DB`（D1）。Schema 迁移随 `packages/integrations-adapters-cf`（Cloudflare 特定 adapter），不在 `apps/integrations`、不在 `packages/linear` —— **provider 包永远不见 SQL**。

### 4.1 `linear_apps`（per-publication App 凭据）

```sql
CREATE TABLE linear_apps (
  id              TEXT PRIMARY KEY,           -- uuid
  publication_id  TEXT NOT NULL UNIQUE,       -- 与 publication 1:1
  client_id       TEXT NOT NULL,              -- Linear App 注册产生
  client_secret   TEXT NOT NULL,              -- 静态 AES-GCM 加密
  webhook_secret  TEXT NOT NULL,              -- AES-GCM 加密
  created_at      INTEGER NOT NULL
);
```

### 4.2 `linear_installations`

```sql
CREATE TABLE linear_installations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,              -- OMA 用户（better-auth user.id）
  workspace_id    TEXT NOT NULL,              -- Linear org id
  workspace_name  TEXT NOT NULL,
  install_kind    TEXT NOT NULL,              -- 'dedicated'（保留单值以便前向兼容）
  app_id          TEXT,                       -- 外键 linear_apps.id
  access_token    TEXT NOT NULL,              -- 静态 AES-GCM 加密
  refresh_token   TEXT,                       -- 静态 AES-GCM 加密（如 Linear 颁发）
  scopes          TEXT NOT NULL,
  bot_user_id     TEXT NOT NULL,              -- App bot 在 Linear 的用户 id
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  UNIQUE (workspace_id, install_kind, app_id)
);
```

每次 App 注册产生一行。

### 4.3 `linear_publications`

```sql
CREATE TABLE linear_publications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,          -- OMA 用户（发布者）
  agent_id            TEXT NOT NULL,          -- OMA agent
  installation_id     TEXT NOT NULL,          -- 外键 linear_installations.id
  mode                TEXT NOT NULL,          -- 'full'
  status              TEXT NOT NULL,          -- 'pending_setup' | 'awaiting_install' | 'live' | 'needs_reauth' | 'unpublished'
  persona_name        TEXT NOT NULL,          -- 在 Linear 中显示的名（App name）
  persona_avatar_url  TEXT,                   -- App 头像
  capabilities        TEXT NOT NULL,          -- JSON：本 publication 允许的 Linear 操作
  session_granularity TEXT NOT NULL,          -- 'per_issue' | 'per_event'
  created_at          INTEGER NOT NULL,
  unpublished_at      INTEGER
);
```

### 4.4 `linear_webhook_events`

```sql
CREATE TABLE linear_webhook_events (
  delivery_id     TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  publication_id  TEXT,                       -- 可空：可能尚未路由
  event_type      TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER,
  session_id      TEXT,                       -- 触发的 session
  error           TEXT
);
```

### 4.5 `linear_setup_links`

```sql
CREATE TABLE linear_setup_links (
  token           TEXT PRIMARY KEY,           -- 32 字节随机
  publication_id  TEXT NOT NULL,
  created_by      TEXT NOT NULL,              -- OMA user_id
  expires_at      INTEGER NOT NULL,           -- 创建后 7 天
  used_at         INTEGER,
  used_by_email   TEXT
);
```

### 4.6 `linear_issue_sessions`

Linear issue 与 OMA session 的映射，`per_issue` 粒度时用来在后续 webhook 上找到既有 session。

```sql
CREATE TABLE linear_issue_sessions (
  publication_id  TEXT NOT NULL,
  issue_id        TEXT NOT NULL,              -- Linear issue id
  session_id      TEXT NOT NULL,              -- OMA session id
  status          TEXT NOT NULL,              -- 'active' | 'completed' | 'human_handoff' | 'rerouted' | 'escalated'
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (publication_id, issue_id)
);
```

---

## 5. 身份策略

### 5.1 完整身份（per-agent App）

每个 `linear_publication` 都有自己的 `linear_apps` 行，带专用 OAuth 凭据。当该 App 安装到一个 workspace 时创建的 bot 用户**就是** agent 的身份。Linear 的 `@` 自动补全和 assignee 下拉里，bot 与其它用户一样可见。

**Setup 成本**：每个 agent 每个 workspace 约 3 分钟（Linear App 注册必须由 workspace 管理员完成）。

**协议级能力**：标准 `actor=app` OAuth，请求的 scope（`read`、`write`、`app:assignable`、`app:mentionable`，加上用户授予的其它）。

路由是隐式的（事件落到 publication 专属 webhook endpoint，所以与 publication 的绑定是直接的）。

### 5.2 非管理员交接

非管理员的 OMA 用户**自己无法完成 setup**（Linear 要求 workspace 管理员注册 App）。Console 提供「Send setup link to admin」action，创建一行 `linear_setup_links` 并产出可分享 URL。

管理员打开链接，落到 gateway 托管的极简 setup 页面（**无需 OMA 登录**，仅需链接 token），完成 Linear 侧步骤，凭据回流到原 publication。原用户被通知。

---

## 6. 能力模型

### 6.1 默认

**所有 Linear API 操作默认开启**。包括：

- 读所有内容
- 评论 / 回复
- 改 `status`、`labels`、`priority`、`assignee`（含改派给他人）、`project`、`milestone`
- 创建 issue / sub-issue
- `@`-mention 真实人类
- 自我 unassign
- 删除 issue / 评论

理由：契合「agent 即同事」叙事；如果某个 agent 表现不好，修复方法是更新它的 system prompt 或 unpublish，而不是在 API 层做闸口。

### 6.2 限制模型

两层 opt-out：

- **Workspace 基线**（`linear_installations.capabilities`）：本 workspace 内任何 publication 的能力上限。
- **Per-publication**（`linear_publications.capabilities`）：可在 workspace 基线之上进一步收紧；**不能扩展超过它**。

MCP server 在每次 Linear API 调用前做能力检查。

UI：每个 workspace 的设置页显示开关列表；每个 publication 的设置页也显示同列表，被 workspace 关掉的项灰显。

---

## 7. Session 模型

### 7.1 粒度选项

通过 `session_granularity` 在 publication 维度设置：

- **`per_issue`**（默认）：给定 Linear issue 上的所有事件映射到同一个 OMA session。Session 随评论与状态变化累积上下文。由 `linear_issue_sessions` 支撑。
- **`per_event`**：每个 webhook 事件创建一个新 session。Agent 跨事件没有内置记忆；如需持久化可用 `memory_store`。

### 7.2 Session 生命周期状态

`linear_issue_sessions.status` 中的：

- `active`：agent 正在工作或空闲等待下一事件
- `completed`：issue 关闭；session 归档
- `human_handoff`：agent 自我 unassign；session 空闲，等人类 action
- `rerouted`：用户把 issue 改派到另一个 agent；本 session 终止，新 publication 可能起一个新 session
- `escalated`：连续 N 次失败；session 暂挂；在 Console 中露出为「需要人类关注」

### 7.3 崩溃后的上下文重建

OMA 已有的崩溃恢复适用：**session 的事件日志是真理之源**，下次 webhook 时 harness 从日志重建上下文。Linear 上下文从 `linear_issue_sessions` + 一次新的 `get_issue` 调用重新挂上。

---

## 8. Linear 工具（MCP）

Gateway 在 `https://integrations.<host>/mcp/linear?token=<jwt>` 托管一个 MCP server。JWT 由 `MCP_SIGNING_KEY` 签发，scope 为单个 publication + issue，**寿命短**（与 session 同期）。

### 8.1 工具

```
linear.get_issue(id)
linear.list_comments(issue_id)
linear.search_issues(query)
linear.list_users()
linear.list_labels()
linear.list_statuses()
linear.list_projects()
linear.post_comment(issue_id, body)
linear.update_issue(id, fields)
linear.create_issue(...)
linear.create_sub_issue(parent_id, ...)
linear.add_label(id, label)
linear.remove_label(id, label)
linear.assign(id, user_id)
linear.unassign(id, user_id)
linear.set_status(id, status_id)
linear.set_priority(id, priority)
linear.delete(id)
```

### 8.2 工具 schema

从 Linear 的 GraphQL schema introspection 自动生成。**单一真理之源**减少漂移。

---

## 9. Console UX

### 9.1 侧边栏

新增 `Integrations` 顶层项，下面 `Linear` 为子项。未来 provider（`Slack`、`GitHub`）将与 `Linear` 平级。

### 9.2 Integrations / Linear 页面

所有 Linear 配置的单一真理之源：

- 已连接 workspace 列表（带模式徽标和 live agent 数量）
- 「+ Publish agent to Linear」入口
- 跨 agent 的最近活动 feed
- 每个 workspace 的「Manage」深链

### 9.3 发布流程

3 步 modal：

1. **选 agent** —— 选要发布的 OMA agent。
2. **Setup** —— 复制粘贴 Linear App 凭据；可选「发给管理员」。
3. **完成** —— 确认页，带回到 Linear workspace 的深链。

### 9.4 Workspace 管理页

per-workspace 视图：连接状态、live publication 列表、「+ Publish another agent」、「Disconnect workspace」（级联到本 install 下的所有 publication）。

### 9.5 Per-publication 设置

能力矩阵、人格覆盖（名/头像）、session 粒度、unpublish。

### 9.6 Agent Detail 页

最小改动：一个 Linear 状态徽标，带「在 Integrations 里管理」链接。**所有真实配置都在 Integrations 页发生。**

### 9.7 Sessions

- `SessionsList`：Linear 触发的行显示 `🔗 Linear` 徽标，hover 显示 workspace 名。
- `SessionDetail`：顶部一张 Linear 上下文卡片，含 issue 标题、回到 Linear 的链接、最近评论预览。

---

## 10. Linear 侧 UX

Agent 表现为一等 Linear 用户：

- `@` 自动补全显示人格名
- assignee 下拉列出它们
- 通知文案使用人格名（「Coder commented on ENG-142」）
- issue 侧栏的 Agent Session 面板显示实时活动，按 agent 限定

### 10.1 错误 / handoff 评论

agent 失败或交接时，发结构化评论：

```
⚠️ Hit an error while working on this:
"<short error description>"

Will retry in <duration>. If this keeps happening, see the OMA dashboard.
[ Open in OMA ↗ ]
```

```
I'm not sure how to proceed — <short reason>. Unassigning so a human can take it.
```

---

## 11. 安全

- **Webhook 鉴权**：用 per-install 的 webhook secret 做 HMAC-SHA256 校验。**常时比较**。不匹配则拒。
- **Webhook 幂等**：`delivery_id` 在 `linear_webhook_events` 中检查；重复投递立即返回 200。
- **静态 token**：Linear access token、refresh token、client secret、webhook secret 都用 AES-GCM 加密存到 D1，密钥派生自 `MCP_SIGNING_KEY`（如轮换策略要求可用单独 secret）。
- **Token 永远不到 sandbox**：agent 没有任何 Linear token 的直接访问。所有 Linear 调用都通过 gateway 的 MCP server，由短寿命 JWT 鉴权，scope 限定单个 publication + issue。
- **JWT scope**：包含 `publication_id`、`issue_id`、`session_id`、`exp`。MCP server 拒绝 scope 之外的调用。
- **能力强制**：每次 Linear 写都先做能力检查，对 publication 的有效能力集（workspace ∩ publication）。
- **Setup-link 安全**：setup-link token 是 32 字节随机、单次使用、7 天过期，**只授予完成某个特定 publication setup 的能力**。**不授予 OMA 登录**。

---

## 12. 不在 v1 范围

- Slack、GitHub、Discord provider（架构在 `apps/integrations/providers/` 下留了位置）。
- Linear projects / cycles / milestones / initiatives 作为事件源（agent 仍然能通过工具操作这些对象）。
- 客户请求 / 反馈收件箱。
- 与 Linear MCP server（`mcp.linear.app`）的双向同步。
- 来自 OMA 的移动推送通知。
- 多 OMA 用户共享一个 Linear workspace 安装（v1：每安装单一 owner；ownership 通过 support 流程转移）。
- 通过标签做 per-issue 能力 override（如 `agent:read-only` 临时降权）。
- per-publication / per-workspace 的成本归因看板。

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Linear API 限流（约 1500 req/h/workspace） | 突发负载下 agent 阻塞 | gateway 内 per-installation token bucket；通过 tool result 把剩余配额暴露给 agent；在 SessionDetail 显示 |
| Webhook 投递丢失 | 错过事件、agent 状态过时 | Linear 端有重试；我方有幂等表；在每个 `linear_issue_sessions` 行上加「Resync issue」手动按钮 |
| 每个 workspace 的 Linear App 数量上限 | 阈值之后 A1 不可用 | 限制未公开文档化；UI 加上限（如 20）并在触达时提示联系 Linear support |
| Workspace 管理员拒绝 setup | 高级用户被卡 | Setup-link 流程鼓励与管理员异步协调 |
| Linear API/UI 变化 | 集成被打断 | Linear Agents API 已 GA，但 Agent Plans 还是 preview；锁文档化 endpoint；加集成冒烟测试；preview 特性按 best-effort 处理 |
| Token 泄露 | workspace 被攻陷 | 静态 AES-GCM 加密、仅 gateway 访问、JWT scope 短、Linear 侧通过 `actor=app` 归因留审计 |
| 用户在 Linear 卸载 App | webhook 401 | gateway 把 publication 标 `needs_reauth`；Console 显示红色 banner 带 reauth CTA |
| 用户 unpublish 一个 A1 agent | Linear App 成孤儿 | gateway 通过 Linear API 撤销 install；Linear 开发者设置中的 App 注册仍归用户手动删除 |

---

## 14. 计划阶段的实施备注

实施计划（下一阶段）应尊重包分层 —— 先接口、再 provider 实现、再 adapter、再 wiring。顺序：

**阶段 A —— 基础（暂无 Linear）**

1. `packages/integrations-core` 骨架，含 §3.5 接口和 shared 类型。**无 runtime 依赖。**
2. `packages/integrations-adapters-cf` 骨架：D1 / KV / service-binding / Web-Crypto adapter 实现 port。用 `integrations-core/test` 的 in-memory fake 单测。
3. 6 张新表的 D1 迁移，归 cf-adapters 包所有。
4. `apps/integrations` 骨架：`wrangler.jsonc`、`/health`、`wire.ts` 组合根，部署到 `integrations.<host>`。

**阶段 B —— Linear provider（per-agent App，端到端）**

5. `packages/linear` 骨架，实现 `IntegrationProvider`，仅依赖 `integrations-core` ports。
6. Per-publication App 安装流：setup 向导、校验、安装链接。
7. 给非管理员的 setup-link 交接。
8. Webhook 接收：HMAC 校验在 `packages/linear` 内，幂等通过 `WebhookEventStore` adapter；事件落到 per-app endpoint，所以与 publication 的绑定是直接的。
9. `SessionCreator` adapter 调主 worker；provider 附 Linear 上下文。
10. Linear MCP 集成：agent 的 `mcp_servers` 配置指向 Linear 托管 MCP（`https://mcp.linear.app/mcp`）；access token 通过 OMA 出站 vault 注入。**没有自建 MCP server。**
11. 通过 `IssueSessionRepo` 实现 `per_issue` session 粒度。

**阶段 C —— Console + 完善**

12. Console UI：Integrations 页、workspace 列表、publish 向导、workspace 管理页、per-publication 设置。
13. Agent Detail 徽标 + SessionsList 徽标 + SessionDetail Linear 上下文卡片。
14. MCP server 内的完整 Linear 工具集。
15. 能力矩阵 UI + 强制（在 `packages/linear` 内对 `McpScope` 携带的能力集做检查）。
16. 错误 / handoff 结构化评论。
17. Token 撤销检测时的 reauth 流程。
18. 集成冒烟测试、可观测性、限流保护。

**测试分层**

- `packages/integrations-core`：类型守卫、helper 逻辑的单测。
- `packages/linear`：用 in-memory fake repo + 录制 GraphQL fixture 的 HTTP client 单测。**不需要 workerd。**
- `packages/integrations-adapters-cf`：用类似 miniflare 的 D1/KV binding 做集成测试。
- `apps/integrations`：薄路由级冒烟测试；大部分逻辑由上面包测试覆盖。