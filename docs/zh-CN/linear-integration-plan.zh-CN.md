# Linear 集成 —— 实施计划

**配套文档**：[`linear-integration-design.zh-CN.md`](./linear-integration-design.zh-CN.md)
**日期**：2026-04-20

> ## 状态（构建后，2026-04-20）
>
> | 阶段 | 状态 |
> |---|---|
> | 0 — 仓库准备 | ✅ 已完成 |
> | 1 — `integrations-core` 接口 | ✅ 已完成 |
> | 2 — `integrations-adapters-cf` | ✅ 已完成 |
> | 3 — `apps/integrations` 骨架 + wire.ts | ✅ 已完成 |
> | 4 — `packages/linear` provider | ✅ 已完成 |
> | 5 — Webhook 接收 + 派发 | ✅ 已完成 |
> | 6 — Service-binding 创建 session | ✅ 已完成（main 上的 `/v1/internal/sessions`） |
> | 7 — MCP 集成 | ✅ 已完成，**没有自建 server** —— 通过 vault 出站注入使用 Linear 托管的 MCP |
> | 8 — Per-issue session 生命周期 | ✅ 已完成（基本状态；handoff/escalated 转换延后） |
> | 9 — 生命周期（handoff/reroute/escalate） | ⚠️ 部分完成 —— DB 状态已定义，但转换触发器未接 |
> | 10 — Per-agent App 安装 + setup 向导 | ✅ 已完成 |
> | 11 — Setup-link 给管理员的交接 | ✅ 已完成（7 天签名 JWT + 静态 HTML 页面） |
> | 12 — Console UI | ✅ 已完成（`packages/integrations-ui` + 3 个页面 + Agent Detail 徽标 + SessionsList/Detail 徽标） |
> | 13 — 能力矩阵 UI + 强制 | ⚠️ UI 已上，**强制未接**（残留代码；见 design 增补 #2） |
> | 14 — 错误/handoff 评论 + reauth | ❌ 延后（跨 worker；main 检测到错误，gateway 需通过 vault 发评论） |
> | 15 — 可观测性 + 冒烟测试 | ⚠️ 部分完成 —— Cloudflare 可观测已开，冒烟测试需要真实 Linear 凭据 |
>
> **测试**：单测覆盖 webhook 解析、OAuth helper、完整的 per-agent App 安装、handoff link 生成。所有仓库测试通过。
>
> **部署**：参见 [`linear-integration-sop.zh-CN.md`](./linear-integration-sop.zh-CN.md) 的逐步指南。

本计划把设计转化为一系列可构建、可验证的小单元。每个阶段都有清晰的「完成定义」（DoD）；只有显式说明的地方阶段之间才有相互门控。

---

## 阶段 0 —— 仓库准备

**目标**：workspace 知道有新包和新 app。

- 在 `pnpm-workspace.yaml` 中添加：
  - `packages/integrations-core`
  - `packages/linear`
  - `packages/integrations-adapters-cf`
  - `apps/integrations`
- 每个新包：`package.json`、继承根的 `tsconfig.json`、空的 `src/index.ts` re-export。
- 根 `tsconfig.json` 加新包的 path alias。
- 增加 `vitest.config.ts` 条目（或扩展现有的），让包测试能被发现。
- 验证 `pnpm install` + `pnpm typecheck` 干净。

**DoD**：`pnpm typecheck` 在新包为空的状态下通过；`pnpm test` 能发现（并跳过）新包中的零个测试。

---

## 阶段 1 —— `integrations-core` 接口

**目标**：每个 provider 都依赖的稳定契约。**无任何运行时 import。**

`packages/integrations-core/src/` 下的文件：

- `provider.ts` —— `IntegrationProvider`、`InstallStep`、`InstallComplete`、`WebhookRequest`、`WebhookOutcome`、`McpScope`、`McpToolDescriptor`。
- `persistence.ts` —— `InstallationRepo`、`PublicationRepo`、`WebhookEventStore`、`IssueSessionRepo`、`SetupLinkRepo`、`AppRepo`。每个都列出 `linear` 用到的读写方法（不含 SQL 类型）。
- `ports.ts` —— `SessionCreator`、`Crypto`、`HttpClient`、`JwtSigner`、`Clock`（可测试性）、`IdGenerator`。
- `domain.ts` —— 值对象类型：`Installation`、`Publication`、`PublicationStatus`、`CapabilitySet`、`Persona`、`IssueSession`、`IssueSessionStatus`。
- `index.ts` —— 桶 export。
- `test/fakes.ts` —— 每个 port 的内存实现（`linear` 测试在用）。

**DoD**：包能编译；`test/fakes.ts` 100% 覆盖每个 port 的方法；不依赖 `cloudflare:workers`、`hono` 或任何 HTTP/存储 runtime。

---

## 阶段 2 —— `integrations-adapters-cf` 骨架

**目标**：每个 port 在 Cloudflare 绑定上的实现。

`packages/integrations-adapters-cf/src/` 下的文件：

- `crypto.ts` —— `WebCryptoAesGcm` 实现 `Crypto`（用 `crypto.subtle` 做 AES-GCM，密钥来自注入的 secret）。
- `jwt.ts` —— `WebCryptoJwtSigner` 实现 `JwtSigner`（HS256）。
- `http.ts` —— `WorkerHttpClient` 实现 `HttpClient`（裸 `fetch`，带超时 + 5xx/429 退避重试）。
- `d1/schema.sql` —— 6 张新表（设计文档 §4）。
- `d1/migrations.ts` —— 复用 `apps/main` 已有的迁移工具的 runner（避免引入并行迁移系统）。
- `d1/installation-repo.ts`、`publication-repo.ts`、`webhook-event-store.ts`（D1 而非 KV —— 更简单且便于回填查询）、`issue-session-repo.ts`、`setup-link-repo.ts`、`app-repo.ts`。
- `service-binding-session-creator.ts` —— 通过 service binding 调主 worker。

**抉择**：webhook 幂等性放在 **D1** 而非 KV。理由：便于运维回填查询；生命周期与 installation 对齐；少一个 binding。

**DoD**：每个 adapter 都有针对 in-memory 等价实现的单测，或者用 `@cloudflare/workers-types` 测试桩做集成测试；D1 迁移用 miniflare D1 测过。

---

## 阶段 3 —— `apps/integrations` 骨架 + `wire.ts`

**目标**：空的 gateway worker 部署可达；composition root 就位。

- `apps/integrations/wrangler.jsonc`：
  - `name: "managed-agents-integrations"`
  - bindings：`AUTH_DB`（共享 D1）、`MAIN`（指向 `managed-agents` 的 service binding）、`MCP_SIGNING_KEY` secret。
  - `compatibility_date` 与 main 一致。
  - 自定义域名 route `integrations.<host>/*`。
- `src/index.ts` —— Hono app，仅 `/health`。
- `src/wire.ts` —— `buildContainer(env): Container`，从 `integrations-adapters-cf` 实例化每个 port。**Container 是纯数据；没有全局变量。**
- `src/env.ts` —— 与 wrangler binding 对齐的类型化 `Env`。
- 加进根部署脚本。

**DoD**：从新 app 跑 `wrangler deploy` 成功；`curl integrations.<host>/health` 返回 `{"status":"ok"}`；`wire.ts` 实例化不抛错。

---

## 阶段 4 —— `packages/linear` provider，per-agent App 安装流

**目标**：把 per-publication 的 Linear App 端到端 OAuth 安装到用户 workspace，并落到 D1。

`packages/linear/src/` 下的文件：

- `provider.ts` —— `LinearProvider implements IntegrationProvider`。构造函数收一个 ports 的 `Container`（与 `apps/integrations` 构造的同一个）。**无 Cloudflare import。**
- `oauth/protocol.ts` —— `buildAuthorizeUrl`、`buildTokenExchangeBody`、`parseTokenResponse`。
- `graphql/client.ts` —— 基于 `HttpClient` port 的最小 Linear GraphQL 客户端。Query helper：`viewer`、`organization`。
- `index.ts` —— 仅导出 `LinearProvider`。

`apps/integrations/src/routes/linear/` 下的路由：

- `publications.ts` —— `POST /linear/publications/start-a1`、`/credentials`、`/handoff-link`。
- `dedicated-callback.ts` —— `GET /linear/oauth/app/:appId/callback`。
- `setup-page.ts` —— 给非管理员交接用的 `GET /linear-setup/:token`。

**DoD**：一次真实的 OAuth 安装能完成并产生一行 `linear_installations`，`install_kind='dedicated'`；access token 静态加密存储；在 Linear 撤销 App → 下次 webhook 401 → installation 标记 `revoked_at`。

---

## 阶段 5 —— Webhook 接收 + 派发

**目标**：真实 Linear webhook 到达、被验签、去重、并路由到 publication。

`packages/linear/src/`：

- `webhook/parse.ts` —— 把 Linear 的 webhook payload 解析成 `WebhookEvent`（`issue_assigned`、`issue_mentioned`、`comment_created`、`agent_session_event`）。

路由：`apps/integrations/src/routes/linear/webhook.ts` —— `POST /linear/webhook/app/:appId`。**始终返回 200**（Linear 的契约）。Webhook 落到 publication 专属的 endpoint，所以与 publication 的绑定是直接的。

**DoD**：一次 `issueAssignedToYou` 事件在重试时正确去重；专用安装能解析到它唯一的 live publication；无法路由的事件记日志但不报错。

---

## 阶段 7 —— 通过 service binding 创建 session

**目标**：被路由的 webhook 事件物化成一个 OMA session。

`apps/main`：

- 新 endpoint：`POST /v1/internal/sessions/create-or-resume`（auth：仅 service-binding，通过共享签名 header）。接受 `{ agent_id, user_id, metadata, initial_event }`。**创建新 session 或按 `metadata.linear.issue_id` 续接现有 session**（per_issue 粒度）。
- 把 `metadata.linear` 写进 session 记录；后续在 SessionsList/Detail 上展示。

`integrations-adapters-cf`：

- `ServiceBindingSessionCreator` 通过 `MAIN` binding 调上面那个 endpoint。

`packages/linear`：

- `provider.handleWebhook` 解析 publication → 调 `SessionCreator.create({ agent_id, user_id, metadata, initial_event })`。
- 对 `per_issue`：还要写 `linear_issue_sessions`，让后续事件能续接。

**DoD**：在 Linear 里真实 `@OpenMA` mention 一次能创建一个 OMA session；同 issue 的后续评论会追加到同一 session（per_issue 模式）。

---

## 阶段 8 —— MCP server：`get_issue` + `post_comment`（垂直切片）

**目标**：agent 能读 issue 并以人格身份回评论。

- 路由：`apps/integrations/src/routes/linear/mcp.ts` —— 实现 HTTP 上的 MCP 协议（与 main 给其它 MCP server 用的形态一致；helper 能复用就复用）。
- JWT 校验：取出 `publication_id`、`issue_id`、`session_id`、`exp`；不匹配则拒。
- 工具实现放在 `packages/linear/src/tools/`：
  - `get-issue.ts`
  - `post-comment.ts` —— 以 App 的 bot 身份发评论。
- 主 worker 改动：当一个 session 由 Linear 触发时，把 MCP URL + 签名 JWT 注入到 session 的 MCP server 列表。

**DoD**：被发布的 agent 收到 issue mention，读 issue 上下文，发回的评论在 Linear 里以人格名 + 头像渲染。

---

## 阶段 9 —— 人格、能力检查、完整工具集

**目标**：生产可用的 Linear 工具集，带能力强制。

- 实现剩余工具（设计文档 §8）：`list_comments`、`search_issues`、`update_issue`、`create_issue`、`create_sub_issue`、`add_label`、`remove_label`、`assign`、`unassign`、`set_status`、`set_priority`、`delete`、`list_users`、`list_labels`、`list_statuses`、`list_projects`。
- `packages/linear` 中的能力检查 helper：每个工具在调 GraphQL 之前先调 `requireCapability(scope, "comment.write")` 之类。能力集是 `McpScope` 的一部分，在签 JWT 时填入。
- 在 Linear 支持的写操作里使用幂等键（用 Linear mutation 上的 `idempotencyKey` 字段）。

**DoD**：每个工具都有至少一条针对录制的 GraphQL fixture 的 happy-path 测试；能力拒绝时返回结构化错误，agent 能读懂并反应。

---

## 阶段 10 —— `per_issue` 生命周期：handoff、reroute、escalation

**目标**：`linear_issue_sessions` 中的状态机在收到入站事件时被尊重。

- 按设计文档 §7.2 实现 `human_handoff`、`rerouted`、`escalated`、`completed` 转换。
- agent 自我 unassign 时，gateway 调 `IssueSessionRepo.markHandoff`。
- 用户把 issue 从一个 agent 改派给另一个 agent 时，原 session 以 `rerouted` 终止，新 session 在新 publication 下开。
- 失败追踪：每个 session 计连续错误数；累计 N 次（默认 3）后置 `escalated`；在 Console SessionsList 里露出。

**DoD**：每个转换都有单测；assignee 变更的 Linear webhook 正确路由到对应 session 生命周期 action。

---

## 阶段 11 —— A1 安装流（per-publication App）

**目标**：高级用户能注册自己的 Linear App，让一个 agent 以完整身份出现。

- Console UI 的 publish 向导（阶段 13 也会动 Console；这一阶段是 API/后端）。
- 路由：
  - `POST /linear/publications/start-a1` —— 创建一行 `linear_publications` 记为 `pending_setup`，生成一个 setup token，返回可复制的凭据块（callback URL、webhook URL、建议的 App 名 + 头像）。
  - `POST /linear/publications/:id/credentials` —— 接受用户提供的 `client_id` + `client_secret`；调 Linear 的 introspection 校验；转为 `awaiting_install`；返回安装 URL。
  - `GET /linear/oauth/app/:appId/callback` —— 处理 per-app OAuth 回调；加密存储 `client_secret` + `access_token` + `webhook_secret`；转为 `live`。
  - `POST /linear/webhook/app/:appId` —— 在阶段 6 已接，HMAC 用本 app 的 webhook secret 校验。
- D1：保证 `linear_apps` 行的创建与 publication 状态转换在同一原子内。

**DoD**：一个 publication 能完全靠 API 调用端到端配置完成（Console 紧随其后）；产生的 bot 用户能在 Linear 里查到；webhook 在 per-app endpoint 上接收。

---

## 阶段 12 —— 给非管理员的 setup link 交接

**目标**：非管理员用户能通过链接把 setup 交给所在 workspace 的管理员。

- `POST /linear/publications/:id/setup-link` —— 创建 `linear_setup_links` 行（32 字节 token，7 天过期），返回可分享 URL。
- `GET /linear-setup/:token` —— 公开落地页（不走 OMA 鉴权）。渲染一个简洁的 Hono+服务端 HTML 页面，引导管理员走 A1 流程的 Step 2 + Step 3。完成后标记 setup link `used_at`，并通知原用户（Console 收件箱；如无通知系统则 fallback 为静默把 publication 状态推完）。
- 限流 setup-link 创建（每 publication 每 10 分钟一条）。

**DoD**：管理员（无 OMA 登录）能通过链接走完 setup；原发布者的 Console 在管理员完成后 5 秒内反映完成状态。

---

## 阶段 13 —— Console UI：Integrations / Linear

**目标**：完整呈现设计文档 §9 的 UX。

- 侧边栏：加可展开的「Integrations」入口，下挂「Linear」。
- 页面（React + Vite，沿 `apps/console/src/pages/` 已有模式）：
  - `IntegrationsLinear.tsx` —— workspace 列表、最近活动、「Publish agent」入口。
  - `IntegrationsLinearWorkspace.tsx` —— 单 workspace 管理页。
  - `IntegrationsLinearPublishWizard.tsx` —— 发布流程的 modal/route。
  - `IntegrationsLinearPublication.tsx` —— per-publication 设置（capabilities、persona、session 粒度、unpublish）。
  - `IntegrationsLinearSetupHandoff.tsx` —— 显示生成的 setup link 的页面。
- Agent Detail 徽标：`AgentDetail.tsx` 上加一个小状态组件，显示 publication 状态，带「在 Integrations 里管理」的链接。
- Sessions UI：
  - `SessionsList.tsx`：加 Linear 徽标列。
  - `SessionDetail.tsx`：当 session 带 Linear metadata 时在顶部插入 Linear 上下文卡片。
- API client（`apps/console/src/lib/api/`）：为新 integrations 端点加类型化方法。

**DoD**：设计文档 §9 描述的每条流程在已部署 Console 上可走通；设计 token（与 Multica 风格一致）匹配既有页面；完整 publish 流的人工冒烟过。

---

## 阶段 14 —— 能力矩阵 UI + 强制审计

**目标**：让能力系统真正生效并可见。

- UI：在 workspace settings（基线）和 per-publication settings（进一步收紧）上做能力开关列表。被 workspace 关闭的项灰显。
- 强制审计：走查每个 Linear 工具实现，确保它在网络调用前先调 `requireCapability`；为每个工具加一条单测，断言被拒调用返回文档定义的错误形态。
- workspace 能力变更级联：当 workspace 基线移除某能力，其下所有 publication 都失去（有效集 = 基线 ∩ publication）。

**DoD**：能力矩阵 UI 工作；翻 workspace 开关后下次 agent 工具调用 1 分钟内反映。

---

## 阶段 15 —— 错误 / handoff 评论 + reauth

**目标**：把失败模式干净地传递给人类。

- 当 agent 错误冒到 session 级时，gateway 用结构化模板（设计文档 §10.3）发一条「error」评论。
- 当 agent 发出「handoff」意图（如 tool 调用 `linear.handoff(reason)` 或 session metadata 标志），gateway 发 handoff 评论 + unassign + 把 `IssueSession` 标 `human_handoff`。
- Reauth：任何 GraphQL 调用因 token 撤销返回 401/403 时，把 publication 标 `needs_reauth`，在 Console 显示 banner，并停止该 publication 的 webhook 处理直到 reauth。

**DoD**：人为引发的失败产生文档定义的 Linear 评论；在 Linear 撤销 App 在 Console 1 分钟内可见。

---

## 阶段 16 —— 可观测性、限流、冒烟测试

**目标**：可承载真实工作负载。

- per-installation 的出站 Linear API 限流器（token bucket，初始保守速率；把 `Retry-After` 透出到 agent tool result）。
- Webhook 摄入指标：`received`、`verified_failed`、`dedup_hit`、`routed_to_publication`、`routed_to_session`、`dropped`（按原因）。优先用 Cloudflare Workers Analytics Engine，否则 Logpush。
- 冒烟测试（脚本 + CI 任务，指向一个专用测试 Linear workspace）：完整 publish 流、发 mention、agent 响应；能力拒绝；handoff。
- Runbook：`docs/linear-integration-runbook.md`，覆盖 reauth、丢 webhook、限流调优、手动 session resync。

**DoD**：CI 上冒烟测试绿；agent 在 Linear API 上死循环时限流器能压住 429 风暴；runbook 经另一位维护者 review。

---

## 阶段顺序与关键路径

```
0 → 1 → 2 → 3 → 4 ┐
                  ├→ 5 → 6 → 7 → 8 → 9 → 10 ┐
                  │                          ├→ 13 → 14 → 15 → 16
                  └→ 11 → 12 ─────────────── ┘
```

- **第一个可用 publication 的关键路径**：0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。
- 12–15 阶段一旦 API 表面被锁定，就可与 10–11 并行启动。

---

## 不在本计划内（延后）

- Slack / GitHub provider —— 架构支持但未实现；等 Linear 达到稳定线（生产 1 个月无 P0/P1）后再考虑。
- 把 Linear projects / cycles / milestones 作为事件源。
- 与 `mcp.linear.app` 双向同步，让 Claude Desktop 用户驱动 OMA agent。
- 浏览器扩展。
- 多 OMA 用户共享 workspace 所有权。
- 通过标签实现 per-issue 能力 override。
- per-publication / per-workspace 成本看板。

---

## 阶段 5 之前要解决的实施问题

1. **gateway 调 `MAIN.fetch` 的 auth**：当前 main worker 的 `/v1/*` 走 `authMiddleware`。仅 service-binding 的内部端点需要独立 auth 路径。**需与维护者确认**：
   - (a) 在新的 `/v1/internal/*` 路由前缀上加 header 共享 secret 校验，或
   - (b) 复用现有 API-key 流程，给 gateway 一个专用 key。
2. **Console 框架细节**：确认是把新页面接入既有 react-router，还是采用其它路由策略。
3. **MCP 协议形态**：确认 OMA 现有 MCP 集成走 SSE、streamable HTTP 还是自定义形态；按此对齐 gateway 的 MCP server。
4. **通知系统**：`apps/main` 是否暴露应用内通知能力（用于 setup-link-completed 提示）？没有的话 v1 fallback 为 Console 轮询。

这些问题应在阶段 5 之前回答；答案可能影响阶段 7（auth）与阶段 13（Console）的细节。