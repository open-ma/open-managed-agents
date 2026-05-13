# Open Managed Agents — 系统架构与模块深度解读

> 本文目标：让初次接触本仓库的工程师在一篇文档内建立完整心智模型——理解项目定位、三层架构、每个 `apps/*`、`packages/*`、`rl/` 模块的职责与协作关系，并掌握平台在「meta-harness、Cloudflare 原生、可自托管」三条主线上的关键设计抉择。
>
> 阅读建议：第 1–3 章用于建立全局视图；第 4 章按需查阅模块矩阵；第 5 章面向想要做二次开发或贡献者，深入到关键运行时流程与抉择背后的取舍。

---

## 1. 项目定位：什么是「Meta-Harness」

### 1.1 一句话定义

Open Managed Agents（下称 **OMA**）是一个**面向 AI Agent 的开源「元宿主」（meta-harness）平台**，运行在 Cloudflare Workers 上，遵循 [Anthropic Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents) 协议。

它**本身不是某一种 Agent**，而是为「任何 Agent」抽象出一组稳定接口：会话事件日志、沙箱执行、凭据保险柜、技能挂载、记忆存储、多 Agent 委派、出站代理、可观测性。**Harness（agent loop）是可插拔的**。

### 1.2 「Brain / Hands / Substrate」三层心智模型

```
┌─────────────────────────────────────────────────────────┐
│ Brain  ── Harness（可插拔的 agent loop）                │
│   - 读 event log → 组 messages → 调 LLM → 触发 tool     │
│   - 决定 HOW：上下文裁剪、缓存断点、压缩策略、停机条件   │
│   - 无状态：crash → 从 SQLite 重放 → resume             │
├─────────────────────────────────────────────────────────┤
│ Hands  ── Meta-Harness 平台（SessionDO + Sandbox）      │
│   - 决定 WHAT：注册 tools/skills、挂载 memory、构建上下文│
│   - 管理生命周期：DO 唤醒、container 预热、事件持久化    │
│   - crash 恢复、出站代理、凭据隔离、多 Agent 委派        │
├─────────────────────────────────────────────────────────┤
│ Substrate ── Cloudflare 原生基础设施                    │
│   Durable Objects + SQLite | Containers | KV | R2 | D1  │
│   Queues | Workers AI | Workers Email                  │
│   Rate Limiting | Analytics Engine | Browser Rendering  │
└─────────────────────────────────────────────────────────┘
```

> 这一切都是一个有意识的「**接口稳定 / 实现可换**」抉择：
> - 平台对接口（HarnessInterface、SandboxExecutor、HistoryStore、Services）做强约束；
> - 对实现（Anthropic / OpenAI / 自托管 LLM、CF Container / 本地 daemon、D1 / Postgres）尽量解耦。

### 1.3 与同类项目的差异

| 维度 | LangGraph / CrewAI | Anthropic Hosted | **OMA** |
|---|---|---|---|
| 部署形态 | 应用框架（业务进程内） | 闭源 SaaS | **开源 + Serverless 边缘** |
| 沙箱 | 由用户自备 | 平台托管 | **CF Container 原生托管** |
| 状态恢复 | 需用户实现 checkpoint | 透明 | **DO + SQLite 事件溯源** |
| 凭据隔离 | 进入用户代码 | 黑盒 | **outbound 代理透明注入** |
| 可插拔 Brain | 是（库 API） | 否 | **HarnessInterface + Compile-Time 注入** |
| 多租户 | 无 | 平台级 | **per-tenant D1 路由 + KV 配置** |
| RL 自训练 | 无 | 无 | **rl/ 子系统：相同 runtime 用于训练** |

---

## 2. 顶层目录与职责一览

```
open-managed-agents/
├── apps/                          # 4 个 Worker（部署单位）
│   ├── main/                      # API Worker（Hono 路由 + Better-Auth）
│   ├── agent/                     # Agent Worker（SessionDO + Harness + Sandbox）
│   ├── integrations/              # 集成网关（Linear / GitHub / Slack OAuth+Webhook）
│   └── console/                   # 控制台（React + Vite + Tailwind v4，与 main 同源部署）
├── packages/                      # 26 个内部包（pnpm workspace）
│   ├── api-types/ shared/         # DTO 与 Env 类型，最薄依赖
│   ├── services/                  # 服务容器（依赖反转层）
│   ├── *-store/                   # 12 个领域存储（agents、sessions、vaults …）
│   ├── tenant-db/ tenant-dbs-store/  # 多租户 D1 路由
│   ├── credentials-store/         # outbound 代理凭据
│   ├── linear/ github/ slack/     # 集成 provider 实现
│   ├── integrations-core/         # provider 中立的端口/类型
│   ├── integrations-adapters-cf/  # CF（D1）适配
│   ├── eval-core/ event-log/      # trajectory + 事件库
│   ├── cf-billing/                # 用量计费
│   ├── acp-runtime/               # ACP（Agent Client Protocol）本地 daemon
│   ├── cli/                       # `oma` 命令行
│   └── sdk/                       # `@openma/sdk` 公网 TS SDK
├── docs/                          # 内部 RFC / 设计文档（本文亦在此）
├── apps/docs/                     # 用户文档（Astro Starlight，docs.openma.dev）
├── skills/                        # 内置技能（openma SOP、create-agent）
├── rl/                            # Reinforcement Learning 自训练子系统
├── scripts/                       # 部署 / 迁移 / 监控脚本
├── test/                          # unit / integration / e2e / eval
└── .github/workflows/             # CI（含 lane-deploy / sandbox image build）
```

模块按「**类型驱动 → 存储抽象 → 服务容器 → 路由层 → 运行时**」分层组织，依赖方向单向向下，避免环形依赖。

---

## 3. 部署拓扑与运行时

### 3.1 三个 Worker + 一个静态前端

```
       ┌──────────── Cloudflare Edge ────────────┐
       │                                          │
 ┌─────▼──────┐   service binding   ┌────────────▼──────────┐
 │  main       │◀────────────────── │  integrations          │
 │  (Hono API) │   /v1/internal/*   │  Linear / GH / Slack   │
 │  Console    │ ─────────────────▶ │  OAuth + webhook       │
 │  (assets)   │                    └────────────┬──────────┘
 └─────┬──────┘                                  │ webhook
       │ service binding                         │ (trusted via secret)
       │ SANDBOX_sandbox_default                 ▼
 ┌─────▼──────────────────────────┐  ┌────────────────────┐
 │  agent (per-environment)        │  │  RuntimeRoom DO    │
 │  ─ SessionDO  (DO + SQLite)     │  │  本地 daemon ↔ ACP │
 │  ─ Sandbox    (CF Container)    │  └────────────────────┘
 │  ─ outbound   (代理 + 凭据注入) │
 └─────────────────────────────────┘
```

要点：

1. **每个 Environment 一个 `agent` Worker**：因为 Container 镜像随 environment 的 `packages.{pip,npm,apt,…}` 变化。`apps/main` 通过 `services` binding（`SANDBOX_sandbox_<envid>`）路由 sessions 到正确的 worker，并由 `apps/agent/src/index.ts` 内的薄路由把请求转给对应的 `SessionDO`。
2. **Console 同源**：`apps/console/dist` 通过 `assets` binding 由 `apps/main` 直接提供，路由优先级 `run_worker_first` 显式列出 API 路径，其余走 SPA fallback。
3. **Integrations 单独一 Worker**：因为它要承载来自第三方平台的 webhook（高频、签名验签），与 API 隔离能独立扩缩 / 限流。
4. **RuntimeRoom DO**：成对配对 `oma bridge daemon` 和 SessionDO 的 ACP 代理 harness——把 agent loop 委派到用户本地 Claude Code / Codex（详见 §5.3）。

### 3.2 Cloudflare 资源矩阵

| 资源 | 用途 | 关键 binding |
|---|---|---|
| **Durable Objects** | 单点强一致：SessionDO、RuntimeRoom、Sandbox | `SESSION_DO`, `RUNTIME_ROOM`, `SANDBOX` |
| **D1 (SQLite)** | 用户 / 租户元数据，better-auth | `AUTH_DB`（共享）+ `TENANT_DB_<id>`（Phase 4） |
| **KV** | Agent / Environment / Skill / Credential 配置 | `CONFIG_KV` |
| **R2** | 文件、记忆字节真相、workspace 备份 | `FILES_BUCKET`, `MEMORY_BUCKET`, `WORKSPACE_BUCKET`, `BACKUP_BUCKET` |
| **Queues** | R2 Event Notifications → memory 索引同步 | `managed-agents-memory-events` |
| **Workers AI** | `web_fetch.toMarkdown()` | `AI` |
| **Browser Rendering** | 浏览器自动化工具 | `BROWSER`（仅 agent worker） |
| **Email** | OTP / 邀请发送 | `SEND_EMAIL` |
| **Rate Limiting** | 跨 isolate 限流 | `RL_*`（7 个 namespace） |
| **Analytics Engine** | 结构化错误 / 指标 | `ANALYTICS`（dataset `oma_events`） |
| **Cron** | 评测推进 + 记忆 30 天保留 | `* * * * *` |

### 3.3 多环境策略

`wrangler.jsonc` 顶层是 production，`env.staging` 是 staging。**Lane**（`docs/lanes.md`）是临时的「PR 级」并行部署：复制三个 worker 到独立 name，**代码隔离、数据与 staging 共享**，用于回归与体验验证。`scripts/lane-generate.mjs` 自动生成 lane wrangler 配置，去除 `cron`、`routes`，重绑 service。

---

## 4. 应用层（apps/）逐个拆解

### 4.1 apps/main —— API 入口与控制平面

文件入口：[`apps/main/src/index.ts`](apps/main/src/index.ts:1)

职责按调用链顺序：

1. **公共**：`/health`、`/auth/*`（better-auth 自托管）、`/auth-info`
2. **认证 + 限流 + 租户 + 服务容器**（中间件链）：
   - [`authMiddleware`](apps/main/src/auth.ts:1)：cookie session 或 `x-api-key`
   - [`rateLimitMiddleware`](apps/main/src/rate-limit.ts:1)：CF Rate Limiting 包装
   - `tenantDbMiddleware`：解析 `tenant_id` → 选择 D1 binding（默认 shared，Phase 4 静态 binding）
   - `servicesMiddleware`：每请求构建 `Services` 容器塞到 `c.var.services`
3. **业务路由**：`agents / environments / sessions / vaults / oauth / memory_stores / files / skills / model_cards / models / clawhub / api_keys / me / tenants / evals / cost_report / integrations / runtimes / mcp-proxy`
4. **Daemon 通道**：`/agents/runtime/*` 给 `oma bridge daemon` 用，含 `/_attach` WebSocket 升级路由——校验 runtime token 后转给 `RuntimeRoom DO`。
5. **Internal 路由**：`/v1/internal/*` 由 secret 头校验，仅供 `integrations` worker 通过 service binding 调用。
6. **第三方代理**：`/linear/*`、`/github/*`、`/slack/*`、`/*-setup/*` 直接转发到 `INTEGRATIONS` service binding——好处是 webhook URL 与 API 同源，浏览器侧无 CORS 烦恼。
7. **Cron**：每分钟触发 `tickEvalRuns` + `memoryRetentionTick`（内部按小时门控）
8. **Queue 消费**：R2 → Queue → `handleMemoryEvents`（把 agent 在 FUSE 上的 memory 写回 D1 索引 + audit）

> **设计点**：把「写入 D1 的索引」与「R2 字节真相」解耦后，agent 在容器里通过 FUSE 直接 `echo > /mnt/memory/...` 也能被审计，无需走 REST。这是「让 agent 写文件」与「平台审计」鱼和熊掌兼得的关键。

### 4.2 apps/agent —— Session 运行时

文件入口：[`apps/agent/src/index.ts`](apps/agent/src/index.ts:1)，仅做四件事：

1. `registerHarness("default", DefaultHarness)` / `registerHarness("acp-proxy", AcpProxyHarness)`
2. 导出 DO 类：`SessionDO`、`Sandbox`（即 `OmaSandbox`）、`ContainerProxy`
3. 导出 outbound 处理器（`@cloudflare/sandbox 0.8.x` 的 `setOutboundHandler` API 用）
4. 把 `/sessions/:id/*` 转给对应 DO

核心实现位于 `src/runtime/` 与 `src/harness/`：

| 文件 | 职责 |
|---|---|
| `runtime/session-do.ts` (115 KB) | **核心枢纽**。事件追加、状态机、广播、harness 调度、outcome 评测、recovery、resource 挂载 |
| `runtime/history.ts` (18 KB) | 把 SQLite `events` 表 → AI SDK `CoreMessage[]`，提供反向投影 |
| `runtime/sandbox.ts` (15 KB) | 与 `@cloudflare/sandbox` 桥接，懒预热 + 复用 |
| `runtime/recovery.ts` | DO crash 后扫描 in-flight 流，发 `session.warning` |
| `runtime/resource-mounter.ts` | 把 file/github_repo/memory_store 资源挂载到容器 |
| `runtime/workspace-backups.ts` | 用 `@cloudflare/sandbox createBackup` 把 workspace 打包到 R2 |
| `runtime/mcp-spawner.ts` | 在容器内拉起 MCP 子进程，建立 stdio 通道 |
| `runtime/appendable-prompts.ts` | 系统提示词的可追加片段（skills 用） |
| `harness/interface.ts` | `HarnessInterface`、`HarnessContext` 契约 |
| `harness/registry.ts` | 名字 → 工厂 |
| `harness/default-loop.ts` (39 KB) | 默认 harness：`generateText` + tool loop + 缓存 + 压缩 |
| `harness/compaction.ts` (25 KB) | 上下文压缩策略（事件级粒度、摘要、滑窗） |
| `harness/tools.ts` (51 KB) | bash / read / write / edit / glob / grep / web_fetch / web_search + 派生 mcp_*、call_agent_* |
| `harness/browser-tools.ts` | 由 Browser Rendering 暴露的 navigate / click / extract |
| `harness/skills.ts` | 把 skill 文件挂到 `/home/user/.skills/`，并把 prompt 拼进 system |
| `harness/provider.ts` | 模型解析（anthropic / openai / 自定义 base_url） |
| `harness/outcome-evaluator.ts` | LLM-as-judge：根据 rubric 判定 satisfied / needs_revision |
| `harness/acp-translate.ts` + `acp-proxy-loop.ts` | ACP 协议 ⇄ SessionEvent 互译，把 agent loop 委派到本地 Claude Code |

### 4.3 apps/integrations —— 第三方集成网关

入口：[`apps/integrations/src/index.ts`](apps/integrations/src/index.ts:1)

为什么单独 worker：webhook 高频且必须 < 5s 返回；OAuth 回调必须托管在固定 URL；与 API 解耦后可单独限流（`webhook-rate-limit.ts`）。

子模块：

- `routes/linear/` —— Per-Agent OAuth App、Webhook（assigned/mention/comment → user.message）、出站 MCP 服务器（`mcp.linear.app` 透传）、PAT 安装、Setup 页面
- `routes/github/` —— GitHub App manifest + install callback + 多账号绑定 + webhook
- `routes/slack/` —— Per-channel publishing、Events Subscription、用户 OAuth
- `wire.ts` —— 将三种 provider 绑定到 `integrations-core` 端口
- `providers.ts` —— 注册表

### 4.4 apps/console —— Web 控制台

[`apps/console`](apps/console) 是 React + Vite + Tailwind v4，编译产物挂在 `apps/main` 的 assets 上。结构：

- `pages/` —— 19 个页面：Agents/Sessions/Environments/Vaults/Memory/Skills/Models/ApiKeys/Integrations…
- `components/timeline/` —— **时间线渲染**：把 `SessionEvent[]` 派生为可阅读的 timeline（`derive.ts` 15 KB，是 UX 复杂度的集中区）
- `integrations/api/client.ts` —— 与 `apps/main` 同源调用
- `lib/auth.tsx` + `auth-client.ts` —— better-auth 浏览器端
- `data/templates.ts` —— Agent 模板预设
- `data/mcp-registry.ts` —— 推荐 MCP 列表

### 4.5 apps/docs —— 用户文档站

Astro Starlight，部署到 `docs.openma.dev`。脚本通过 `pnpm --filter` 触发。

---

## 5. 内部包矩阵（packages/）

26 个内部包按职责可归为 **6 大类**：

| 分类 | 包 | 角色 |
|---|---|---|
| **类型基座** | `api-types`, `shared` | 不依赖 CF 的 DTO；`shared` 再叠加 Env 类型与日志/指标工具 |
| **Trajectory & 事件** | `eval-core`, `event-log` | 事件流契约、scorers、trajectory schema |
| **存储抽象层** | `agents-store`, `sessions-store`, `environments-store`, `vaults-store`, `credentials-store`, `memory-store`, `files-store`, `model-cards-store`, `evals-store`, `outbound-snapshots-store`, `session-secrets-store`, `tenant-dbs-store` | 12 个 *领域服务* — 每个都遵循「port + in-memory fake + CF 适配」三件套 |
| **服务容器与多租户** | `services`, `tenant-db` | 把 12 个 store 装进同一个 `Services` 接口；解析 per-request 的 D1 binding |
| **集成端口与适配** | `integrations-core`, `integrations-adapters-cf`, `linear`, `github`, `slack` | provider 中立的 ports → CF（D1）实现 → 三家具体 provider |
| **对外 SDK / CLI / 计费 / 本地 daemon** | `sdk`, `cli`, `cf-billing`, `acp-runtime` | 用户面对面的产物 |

### 5.1 类型基座：`api-types` 与 `shared`

- [`packages/api-types/src/types.ts`](packages/api-types/src/types.ts) 是**契约的真理之源**——`AgentConfig`、`SessionMeta`、`SessionEvent`、`StoredEvent`、`ContentBlock`、`MemoryItem`、`FileRecord` 等 DTO，零依赖、零运行时副作用。
- `shared` 通过 `export *` 把 `api-types` 与 `eval-core` 透传出来，再叠加：
  - [`env.ts`](packages/shared/src/env.ts) —— 整个仓库唯一的 `Env` 类型定义，所有 binding 都在这里登记，注释非常详细
  - `id.ts` —— ULID/前缀 ID（`agent_*`、`sess_*`…）
  - `log.ts` / `metrics.ts` —— 结构化 JSON 日志、`recordEvent(env.ANALYTICS, …)`
  - `format.ts`、`file-storage.ts` —— 通用工具

> **设计点**：把 DTO 与 Env 拆开，让 SDK / CLI 这种**不接触 CF 的环境**可以只依赖 `api-types`，避免 workers-types 污染下游。

### 5.2 Trajectory：`eval-core` + `event-log`

- `eval-core` 定义 `Trajectory`（[trajectory-v1 spec](docs/trajectory-v1-spec.md)）+ 一组 scorer 接口；同一份 schema 被三种消费者复用：
  - **Outcome Eval**（生产侧 LLM-judge，supervisor loop）
  - **Eval Framework**（test/eval：质量回归）
  - **RL Reward**（rl/verifier.ts：训练信号）
- `event-log` 提供 SessionEvent 的追加 / 投影工具，被 `apps/agent/src/runtime/history.ts` 使用。

### 5.3 12 个领域 Store

每个 store 都遵循同一模式：

```
packages/<domain>-store/
├── src/types.ts        # 端口接口（业务方法）
├── src/cf.ts           # D1 / KV / R2 实现
├── src/in-memory.ts    # 测试用 fake
└── src/index.ts        # createCfXxxService(env, db?) 工厂
```

| Store | 持久化 | 关键能力 |
|---|---|---|
| `agents-store` | D1 | 版本化 CRUD（每 `PUT` 产新版本，sessions 绑定历史版本） |
| `sessions-store` | D1 + DO | sessions 元数据 + 状态机；事件日志在 SessionDO 的 SQLite，不在 D1 |
| `environments-store` | D1 + KV | `image_strategy`、build status、container 镜像选择 |
| `vaults-store` | D1 | 凭据元信息（`type`/`mcp_server_url`/`display_name`），秘密只通过 `credentials-store` 取 |
| `credentials-store` | KV（加密） | `static_bearer` / `mcp_oauth` / `command_secret`，由 outbound 代理读取注入 |
| `memory-store` | R2 + D1 | 字节真相在 R2；索引 + 审计 + 30 天版本在 D1 |
| `files-store` | R2 + D1 | 上传文件挂载到 sandbox |
| `model-cards-store` | D1 | 自定义模型 provider/base_url（OAI 兼容） |
| `evals-store` | D1 | eval runs 状态机，支持 cron 推进 |
| `outbound-snapshots-store` | R2 | 出站 HTTP 调用快照（调试用） |
| `session-secrets-store` | KV | 每会话临时秘密（不进容器） |
| `tenant-dbs-store` | D1（meta） | 维护 `tenant_shard` 表 — Phase 4 路由依据 |

### 5.4 服务容器与多租户：`services` + `tenant-db`

[`packages/services/src/index.ts`](packages/services/src/index.ts) 把 12 个 store 工厂统一聚合：

```ts
interface Services {
  agents: AgentService;        sessions: SessionService;
  environments: EnvironmentService; vaults: VaultService;
  credentials: CredentialService;  memory: MemoryStoreService;
  files: FileService;          modelCards: ModelCardService;
  evals: EvalRunService;       outboundSnapshots: OutboundSnapshotService;
  sessionSecrets: SessionSecretService;
}
export function buildCfServices(env: Env, db: D1Database): Services { … }
```

中间件 `servicesMiddleware` 在每个请求注入到 `c.var.services`。**所有路由只看接口、不直接 import store 实现**——这就是「未来要换 Postgres，只需新增 `buildNodeServices`」的根本原因。

`tenant-db` 提供 `TenantDbProvider`：
- Phase 1（默认）：所有租户都用 `env.AUTH_DB`
- Phase 4：根据 `tenant_shard` 表 + 静态 binding（`TENANT_DB_<shardId>`）路由到 per-tenant D1
- Killswitch：`PER_TENANT_DB_ENABLED=false` 一键回滚

### 5.5 集成层：四件套

```
integrations-core (端口/类型 — provider 中立)
        │ implements
        ▼
   ┌────────┬────────┬────────┐
linear    github    slack    （provider 实现）
        │ persistence via
        ▼
integrations-adapters-cf (D1 / KV 落库)
        │ 装配于
        ▼
apps/integrations (HTTP 网关)
```

- `integrations-core` 定义 `Provider`、`Publication`、`Capability`、`InboundEvent` 等中立类型 + 持久化端口
- `integrations-adapters-cf` 用 D1 实现端口
- `linear` / `github` / `slack` 写「这个第三方平台具体怎么 OAuth、怎么签 webhook、怎么转事件」
- `apps/integrations` 拼装：`wire.ts` 把 provider 实现 + 适配实现注入到统一注册表

> **设计点**：加第四种集成（如 Notion）只需写一个 `packages/notion/`，无需触碰适配层和网关代码。

### 5.6 对外产物

| 包 | 给谁 | 关键点 |
|---|---|---|
| [`packages/sdk`](packages/sdk) `@openma/sdk` | 业务集成方（Node/Bun/Deno/Browser/Workers） | typed REST + SSE，三类流（text/thinking/tool_input）通过 correlation id 收敛到 canonical event；提供 `chat` / `chatComplete` / `tail` 三档抽象 |
| [`packages/cli`](packages/cli) `oma` | 终端用户 / agent 自己 | `oma agents/sessions/memory/linear/bridge/...`；其中 `bridge daemon` 以 launchd plist 在用户 Mac 启动，并维持到 `apps/main` 的 WS 长连接 |
| [`packages/cf-billing`](packages/cf-billing) | 平台运营 | 把 token 用量翻成 CF Workers 计费抽象 |
| [`packages/acp-runtime`](packages/acp-runtime) | 本地 daemon | 实现 [Agent Client Protocol](https://github.com/anthropics/agent-client-protocol)；侦测本机 Claude Code/Codex 等是否安装并暴露给 daemon |

### 5.7 RL 自训练子系统：`rl/`

入口 [`rl/cli.ts`](rl/cli.ts) + Python `rl/verl/`。要点：

- **同一 runtime 用于训练**：`rl/rollout.ts` 通过 OMA `/v1/sessions` API 跑 trajectory，与生产共享 sandbox / tools / event log
- **Verifier vs Evaluator 分离**：
  - 生产 `outcome-evaluator`：LLM-judge，慢、贵、决定 supervisor loop
  - 训练 `verifier.ts`：确定性规则、快、免费、产 0–1 标量奖励
- **veRL on Mac MPS 可跑**：核心 GRPO 算法不依赖 CUDA-only 的 SGLang/Megatron，本地 0.5B LoRA 可调通
- **Tinker 配方**：`rl/verl/tinker_recipe.py` 把训练丢给 Tinker 托管 GPU
- **Trajectory v1 schema**：详见 [`docs/trajectory-v1-spec.md`](docs/trajectory-v1-spec.md)，是 eval / RL / 监控共同消费的契约

---

## 6. 关键运行时流程

### 6.1 Session 生命周期（标准 Harness）

```mermaid
sequenceDiagram
  participant U as User/Console/SDK
  participant Main as apps/main (Hono)
  participant DO as SessionDO (apps/agent)
  participant Box as Sandbox (CF Container)
  participant LLM as Anthropic / OpenAI

  U->>Main: POST /v1/sessions/:id/events { user.message }
  Main->>DO: forward via service binding
  DO->>DO: append(user.message) → SQLite
  DO-->>Main: 202 Accepted (drain in background)
  DO->>DO: status = running
  DO->>DO: history.getMessages() (event → CoreMessage[])
  loop tool loop
    DO->>LLM: model_request_start
    LLM-->>DO: stream(text/thinking/tool_use)
    DO->>DO: append + broadcast(SSE / WebSocket)
    alt tool_use
      DO->>Box: exec(bash/read/write/...) lazily
      Box-->>DO: stdout/stderr
      DO->>DO: append(agent.tool_result) + broadcast
    end
  end
  DO->>DO: status = idle (stop_reason)
  Note over Box: Container 在出站时由 outbound 代理注入凭据
```

要点：
- **POST 202 立返**：`session-do.ts` 用 `drainEventQueue()` fire-and-forget，避免 HTTP 超时阻塞 LLM。
- **懒预热 container**：`getOrCreateSandbox()` 在第一次 tool_use 前不创建容器；纯文本会话零成本。
- **并行启动**：模型推理与容器 provision 并发，等到第一次 tool_use 时通常已就绪。
- **崩溃恢复**：DO 实例化时 `recovery.ts` 扫描最后一条事件，若是流中位置则补发 `session.warning`，状态机回 idle，等待下一条 user.message 触发新一轮 harness。

### 6.2 Memory 双写一致性

```
┌────────────────┐    PUT /v1/memory_stores/:id/memories
│ REST 客户端     │────────────────────────────────────┐
└────────────────┘                                    │ inline write
                                                      ▼
                                  ┌─────────────────────────────┐
                                  │ apps/main route             │
                                  │ - R2.put(<store>/<path>)    │
                                  │ - D1: memories upsert       │
                                  │ - D1: memory_versions insert│
                                  └────────────┬────────────────┘
                                               │ R2 Event Notification
                                               ▼
┌────────────────┐    echo > /mnt/memory/...   ┌─────────────────────────────┐
│ Agent 容器(FUSE)│──────────────────────────────▶│ R2 (managed-agents-memory)  │
└────────────────┘                              └────────────┬────────────────┘
                                                             │ enqueue
                                                             ▼
                                                  ┌──────────────────┐
                                                  │ CF Queue         │
                                                  └────────┬─────────┘
                                                           ▼
                                                  ┌──────────────────────┐
                                                  │ apps/main queue()    │
                                                  │ handleMemoryEvents() │
                                                  │ dedupe by etag       │
                                                  │ → D1 索引/审计补写    │
                                                  └──────────────────────┘
```

> 要让 agent 像写本地文件一样自然地用 memory，又要保证审计/索引一致。这套**「R2 是真相 + D1 是索引 + Queue 拉平」**的方案是关键设计抉择，详见 [`docs/architecture.md`](docs/architecture.md) 与 `apps/main/migrations/0010_memory_anthropic_alignment.sql`。

### 6.3 Vault 凭据注入：永远不进沙箱

```
┌────────────┐   curl https://api.github.com   ┌──────────────────┐
│ Sandbox    │────────────────────────────────▶│ outbound proxy    │
│ (容器内代码)│                                 │ (apps/agent)      │
└────────────┘                                 │ - 匹配 vault URL  │
                                               │ - 注入 Authorization
                                               │ - 转发 HTTPS       │
                                               └─────────┬────────┘
                                                         ▼
                                                  外部第三方服务
```

`outbound.ts` 用 `@cloudflare/sandbox 0.8.x` 的 `setOutboundHandler` API 拦截容器出站请求，根据 `credentials-store` 的条目（按 `mcp_server_url` 前缀匹配）添加 `Authorization`。**沙箱内永远拿不到原始 token**——这一点和 Anthropic Hosted 行为完全对齐。

### 6.4 多 Agent 委派与 ACP 代理

两条委派路径：

1. **平台内委派**：Agent 配置 `callable_agents` → `tools.ts` 派生 `call_agent_*` 工具 → SessionDO 创建子 session → 等子 idle → 把回复回填给父 → 事件类型为 `agent.thread_*`
2. **委派到本地 LLM Agent**：用户在 Mac 跑 `oma bridge daemon`，建立到 `apps/main /agents/runtime/_attach` 的 WS 长连接 → `RuntimeRoom DO` 配对 daemon ↔ session → SessionDO 选 `acp-proxy` harness → ACP 协议双向翻译，agent loop 在用户机器上跑（Claude Code、Codex 等）

> 第二条路径的价值：**用户已订阅 Claude Code Pro 时，平台只做编排与状态，不重复消耗 token**——并且训练 RL 时同一根 runtime 通用。

### 6.5 Integrations Inbound：Linear @mention → Session 启动

```
Linear webhook  ──▶  apps/integrations /linear/webhook
                       │ verify HMAC
                       ▼
                       handleInboundEvent(provider=linear)
                       │
                       │  (匹配 publication.capability=mention)
                       ▼
                       buildUserMessageFromEvent(...)
                       │ POST /v1/internal/sessions  (service binding + secret)
                       ▼
                       apps/main /v1/internal/...
                       │ create or resume session
                       │ append user.message
                       ▼
                       SessionDO 启动 harness
                       │ tool_use(mcp.linear.app) 通过 outbound proxy 注入 vault
                       ▼
                       回写 issue comment / 状态
```

---

## 7. 设计抉择与背后的思考

下面挑出 8 个对项目走向影响最深的抉择：

### ① Meta-Harness 而非 SDK

**抉择**：把「平台」与「agent loop」边界写成接口契约，而不是写一个固定 loop 让用户继承。

**思考**：Anthropic 在 [《Decoupling the brain from the hands》](https://www.anthropic.com/engineering/managed-agents) 里把这一思路系统化。强约束接口 + 弱约束实现，让生产环境与训练环境（rl/）共用同一根「手」，让用户可以把「脑」换成 ACP 协议下的 Claude Code，让我们能在不动业务代码的前提下迭代上下文工程策略。

### ② Compile-time 注入而非动态加载

**抉择**：自定义 harness 通过 `oma deploy --harness my-harness.ts` 走 esbuild + `wrangler deploy`，与平台代码同一 isolate。

**思考**：见 [`docs/archive/serverless-harness-sdk.md`](docs/archive/serverless-harness-sdk.md)。CF Workers 不允许 `eval`/动态 import；Service Binding 方案会把 sandbox/broadcast/history 这些 *活引用* 序列化成 RPC，把 50 步 loop 变成数百次跨网络往返。Compile-time 注入用「重新部署」换「零开销 + 零安全成本」，与 Vercel/Lambda 心智一致。

### ③ R2 字节真相 + D1 索引 + Queue 拉平

**抉择**：Memory 用三件套实现「让 agent 写文件」与「平台审计」的兼容。

**思考**：单纯走 REST 限制 agent 表达力（`echo >>` 无法工作）；单纯让 agent 直接 mountBucket 失去审计/索引/版本。R2 Event Notifications 把这两条路径在异步处兜底，REST 写时同步 audit、FUSE 写后 < 30s 由 Queue 消费——做到「最终一致」而非「无审计」。

### ④ 服务容器（packages/services）

**抉择**：所有路由 / DO / cron 通过 `Services` 抽象访问 store，工厂在 `buildCfServices` 一处装配。

**思考**：让「自托管到 Postgres」这种重大变更只需新增一个 `buildNodeServices`——商业 / 开源双形态可以并存。如果继续在每个路由直接 `import { createCfXxxService }`，未来要换实现得改 N 处。这是仓库尺度上的依赖反转，不是过度设计。

### ⑤ Per-Tenant D1 路由（带 killswitch）

**抉择**：`tenant-db` + `tenantDbMiddleware` + 静态 binding `TENANT_DB_<id>`。Phase 1 先共享，Phase 4 切换。

**思考**：D1 单库写入有上限，多租户长期不可持续；但提前重写所有 SQL 风险极高。**接口先行 + Phase 化 + 环境变量回滚**让数据切片成为「运维操作」而非「代码工程」。

### ⑥ Lane（PR 级并行部署）

**抉择**：lane 复制 worker 名字，但与 staging 共享数据；`scripts/lane-generate.mjs` 自动产 wrangler 配置。

**思考**：CF Workers 没有原生 preview env。`docs/lanes.md` 详细列出 *risks*——共享 D1/KV 意味着脏数据风险，但与「为每个 PR 起 prod-grade 隔离环境」的复杂度相比，工程性价比更高。这是一个**有意识的「便捷性 > 完美隔离」抉择**，并通过文档 + 03:17 UTC reclaim cron 控制爆炸半径。

### ⑦ Trajectory v1 作为统一契约

**抉择**：把 SessionEvent 流锁为 `oma.trajectory.v1`，eval / RL / 监控 / 出站审计 都是消费者。

**思考**：见 [`docs/trajectory-v1-spec.md`](docs/trajectory-v1-spec.md)。**先拥有 substrate，再谈抽象**——OTel GenAI 太通用、Inspect AI 不覆盖多 agent，与其匆忙采纳外部规范，不如把内部 schema 稳住、再投影到这些标准。

### ⑧ Outcome / Eval / Reward 三联体

**抉择**：同一份 trajectory 三种消费方式：

| 消费 | 调用 | 输出 |
|---|---|---|
| Outcome | LLM-judge | satisfied / needs_revision |
| Eval | Layer 1 deterministic + Layer 2 judge | pass/fail + report |
| RL | verifier（确定性） | scalar 0–1 |

**思考**：见 [`docs/archive/handoff-verifier-framework.md`](docs/archive/handoff-verifier-framework.md)。三者本质都是 `(task, trajectory) → score`，只是延迟/成本/确定性不同。一个统一接口让平台同时是产品、是评测、是训练场——这是「Cursor 训练 Composer / Cognition 训练 Devin」模式的开源等价物。

---

## 8. 二次开发指南

| 想做的事 | 改动哪些模块 | 参考文档 |
|---|---|---|
| 新增工具 | `apps/agent/src/harness/tools.ts` 注册；如有需要更新 `agent_toolset_*` | `AGENTS.md` |
| 写自定义 harness | 实现 `HarnessInterface`，`registerHarness("...")`；本地 `oma deploy --harness` | `docs/archive/serverless-harness-sdk.md` |
| 新增 store | 复制任一 `*-store` 模板 → 加进 `Services` → 路由消费 | `packages/services/README.md` |
| 接入新第三方平台 | 新建 `packages/<provider>/` 实现 `integrations-core` ports；在 `apps/integrations/wire.ts` 注册；加 `routes/<provider>/` | `docs/linear-integration-design.md` |
| 改用自托管 Postgres | 新增 `buildNodeServices`；改 `apps/main/src/index.ts` 工厂调用 | `packages/services/README.md` |
| 让 agent 跑在用户机器 | 已支持：用户 `oma bridge setup && bridge daemon`；agent 配置 `harness: "acp-proxy"` | `docs/archive/external-agent-runtime.md` |
| 训练自有模型 | 用 `rl/cli.ts rollout` + `rl/verl/verl_trainer.py`；`provider.ts` 已支持 `oai-compatible` 指向 vLLM | `rl/README.md`、`docs/trajectory-v1-spec.md` |

## 9. 小结

OMA 的核心叙事可以浓缩为三句话：

1. **Brain 与 Hands 解耦**——agent loop 是策略，平台是机制；
2. **Cloudflare 是地基而非天花板**——`Services` 抽象让自托管成为可达目标；
3. **生产 = 训练 = 评测**——Trajectory v1 让一份运行时同时服务三类消费者。

读懂这三句话，再结合 §6 的运行时流程，基本就能在仓库的任意一处落点开始贡献。后续若要修改 SessionDO、调整 memory 一致性、引入新集成或加新 store，本文已给出最短路径。
