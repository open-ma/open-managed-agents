<p align="center">
  <img src="logo.svg" alt="openma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/Tests-passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
  <img src="https://img.shields.io/badge/OpenAI-Agents%20API%20%2B%20SDK-412991" alt="OpenAI Agents API 和 SDK 支持" />
</p>

# Open Managed Agents

**Claude Managed Agents 和 OpenAI Agents API 的开源、自部署替代方案。**

🌐 **[openma.dev](https://openma.dev)** · 📖 **[docs.openma.dev](https://docs.openma.dev)** · 💬 **[github.com/openma-ai/open-managed-agents](https://github.com/openma-ai/open-managed-agents)**

OpenMA 提供持久会话、沙箱工具、记忆、加密凭证和崩溃恢复。Cloudflare 与 Node 支持 Claude Managed Agents API；Node 还提供 `/openai/v1` 入口，可使用官方 OpenAI SDK。你可以使用自己的模型 API key，部署到自己的基础设施上。

---

## 两种运行方式

同一套 harness、业务逻辑和事件日志模型同时支持以下两种部署方式，按你的托管偏好选一种：

| | **自部署（Node）** | **Cloudflare** |
|---|---|---|
| 跑在哪里 | 你的 VPS / Mac / Docker 主机 / fly.io / k8s | Cloudflare Workers + DO + Containers |
| 存储 | SQLite 或 Postgres + 本地文件系统 | D1 + KV + R2 |
| 沙箱 | LiteBox / Daytona / E2B / BoxRun | Cloudflare Sandbox（Containers） |
| 启动时间 | `docker compose up`（约 2 分钟） | wrangler deploy（首次配置后约 10 分钟） |
| 适合谁 | 开源用户、私有部署、不想用 CF、需要数据驻留 | 边缘规模、不想运维主机、已在 CF 上 |

两种部署都提供 Claude 兼容的 `/v1/agents`、`/v1/sessions` API 和 Console UI。
OpenAI Agents API 适配器目前挂载在 Node 的 `/openai/v1`。

---

## OpenAI Agents API 快速开始（Node）

先按下方 Docker 部署说明启动 Node 服务，创建 OpenMA API key，并配置模型。
然后安装支持的 OpenAI SDK 版本：

```bash
npm install openai@7.15.0
```

把客户端地址指向你的 OpenMA 服务：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: "http://localhost:8787/openai/v1",
});

const session = await client.beta.agents.sessions.create({
  agent: { model: "your-configured-model", instructions: "Be concise." },
  environment: { type: "none" },
  input: "Hello",
});
console.log(session.id);
```

会话支持文本、等待应用返回结果的函数调用，以及子代理。设置
`agent.multi_agent.enabled: true` 后，主代理可以把子任务分派给子代理；
你可以向子代理发消息、等待结果、中断、关闭或恢复它。子代理分别保存对话，
共享父代理的文件，不能继续创建下一级子代理。

OpenAI API 目前在 Node 上可用。高级环境和插件设置、部分 MCP 与模型选项
尚不支持。迁移现有应用前，请查看[支持的功能与限制](docs/openai-agents-compatibility-status.md)；
具体配置见[适配器指南](packages/openai-agents-compat/README.md)。

---

## 快速开始：自部署（Docker）

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# 首次启动前必须设置两个密钥（都在本地生成）：
#   BETTER_AUTH_SECRET   — 用于签发 Console 会话
#   PLATFORM_ROOT_SECRET — 用于加密静态存储的凭证、Model Card API key、集成 token
#                          （丢失后所有加密行将无法解密 —— 务必备份）
$EDITOR .env
# BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
#
# 可选：ANTHROPIC_API_KEY 让第一个 agent 在还没添加 Model Card 时也能跑起来。
# 生产环境请改为在 Console 里按 tenant 添加 Model Card。
# 必须显式配置隔离沙箱，例如 SANDBOX_PROVIDER=e2b 和 E2B_API_KEY。

# SQLite + 显式配置的隔离沙箱
docker compose up -d

# 或者用 Postgres
# docker compose -f docker-compose.postgres.yml up -d

curl localhost:8787/health
# → {"status":"ok","backends":{"db":"sqlite ..."}, ...}

open http://localhost:8787   # Console UI 跑在同一个端口
```

端到端冒烟测试：

```bash
AID=$(curl -s -X POST localhost:8787/v1/agents -H 'content-type: application/json' \
  -d '{"name":"hello","model":"claude-sonnet-4-6","tools":[{"type":"agent_toolset_20260401"}]}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\"}" | jq -r .id)

curl -s -X POST localhost:8787/v1/sessions/$SID/events -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

完整的自部署指南（沙箱模式、Postgres、BoxRun、vault sidecar、Console UI、运维注意事项）：**[docs.openma.dev/self-host/overview](https://docs.openma.dev/self-host/overview/)**

---

## 快速开始：Cloudflare 部署

需要 [Workers 付费计划](https://developers.cloudflare.com/workers/platform/pricing/)（用于 Durable Objects + Containers）。

```bash
git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents
pnpm install

# 本地开发（不需要 CF 账户）—— wrangler dev + 模拟器
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars
# 同上：PLATFORM_ROOT_SECRET 是启动所必需的
pnpm dev
# API     → http://localhost:8787
# Console → http://localhost:5173

# 部署
npx wrangler login
npx wrangler kv namespace create CONFIG_KV   # 把 id 粘贴进 wrangler.jsonc

# 必填密钥（提示时逐个粘贴）
npx wrangler secret put BETTER_AUTH_SECRET    # openssl rand -hex 32
npx wrangler secret put PLATFORM_ROOT_SECRET  # openssl rand -base64 32 —— 务必备份
npx wrangler secret put API_KEY               # REST API 初始引导密钥

# 可选 —— 仅当你想要一个 tenant 无关的默认 LLM（否则请在 Console 里添加 Model Card）
# npx wrangler secret put ANTHROPIC_API_KEY

npm run deploy
# → https://openma.dev（或个人部署：https://managed-agents.<your-subdomain>.workers.dev）
```

部署内容：

| 组件 | 功能 |
|---|---|
| **主 Worker** | API 路由 —— 智能体、会话、环境、保险库、记忆、文件 |
| **智能体 Worker** | SessionDO + harness + 每个环境的沙箱 |
| **KV 命名空间** | 智能体、环境、凭证的配置存储 |
| **R2 存储桶** | 容器重启之间持久化工作区文件 |

### 创建你的第一个智能体

上面的冒烟测试对任意部署都适用。完整的 Console 流程（Model Card、保险库、集成）见 **[docs.openma.dev/quickstart](https://docs.openma.dev/quickstart)**。API 等价的最小版本：

```bash
BASE=http://localhost:8787   # 或者你的部署 URL
KEY=dev-test-key             # 即你设置的 API_KEY

AGENT=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "你是一个有帮助的编程助手。",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r .id)

SESSION=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" | jq -r .id)

# 发送一轮消息并逐 token 流式返回回复
curl -N -X POST $BASE/v1/sessions/$SESSION/messages \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"content":"写一个抓 HN 热门文章的 Python 脚本"}'
```

长会话用 `GET /v1/sessions/$SESSION/events/stream` —— 连接时回放历史，永不主动关闭。

---

## 架构

**元框架（meta-harness）**不是一个智能体 —— 而是运行智能体的平台。它为智能体需要的一切定义了稳定接口，同时不干扰智能体本身的循环：

```
┌─────────────────────────────────────────────────────────┐
│  Harness（大脑 —— 你的代码）                            │
│  - 读取事件、构建上下文、调用模型                       │
│  - 决定「怎么做」：缓存、压缩、工具交付                 │
│  - 无状态：崩溃 → 从事件日志重建 → 恢复                 │
├─────────────────────────────────────────────────────────┤
│  元框架（平台 —— SessionDO）                            │
│  - 准备「有什么」：工具、技能、历史                     │
│  - 管理生命周期：沙箱、事件、WebSocket                  │
│  - 崩溃恢复、凭证隔离、用量跟踪                         │
├─────────────────────────────────────────────────────────┤
│  基础设施（Cloudflare 或 Node 自部署）                  │
│  - 事件日志：DO 内的 SQLite（CF），或 SQLite/Postgres   │
│  - 沙箱：CF Containers / LiteBox / E2B / Daytona        │
│  - 存储：KV + R2（CF），或本地文件系统（自部署）        │
└─────────────────────────────────────────────────────────┘
```

**平台准备「有什么」可用。Harness 决定「怎么」把这些交给模型。**

| 平台负责 | Harness 决定 |
|---|---|
| 事件日志持久化（SQLite） | 上下文工程（过滤、排序） |
| 沙箱生命周期（容器） | 缓存策略（缓存断点） |
| 工具注册（内置 + MCP） | 压缩策略（何时压缩） |
| WebSocket 广播 | 重试策略（退避、瞬时错误识别） |
| 崩溃恢复 | 停止条件（最大步数、完成信号） |
| 凭证隔离（保险库） | 系统提示构造 |
| 记忆（向量检索） | 工具交付（一次性 vs 渐进式） |

---

## 编写一个 Harness

默认 harness 开箱即用。当你需要自定义行为 —— 不同的缓存、压缩、上下文工程 —— 时，写你自己的：

```typescript
// my-harness.ts
import { defineHarness, generateText, stepCountIs } from "@open-managed-agents/sdk";

export default defineHarness({
  name: "research",

  async run(ctx) {
    let messages = ctx.runtime.history.getMessages();

    // 你的上下文工程
    messages = keepOnly(messages, ["web_search", "web_fetch"]);

    // 你的缓存策略
    markLastN(messages, 3, { cacheControl: "ephemeral" });

    // 你的循环 —— 工具、沙箱、广播由平台提供
    const result = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages,
      tools: ctx.tools,
      stopWhen: stepCountIs(50),
      onStepFinish: async ({ text }) => {
        if (text) ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text }],
        });
      },
    });

    await ctx.runtime.reportUsage?.(result.usage.inputTokens, result.usage.outputTokens);
  },
});
```

部署：

```bash
oma deploy --harness my-harness.ts --agent agent_abc123
```

Harness 在构建时被打包进 agent worker。你的代码和 SessionDO 跑在同一个 isolate 里 —— 直接访问事件日志、沙箱和 WebSocket 广播。没有 RPC，没有序列化边界。

---

## API

以下端点为 `/v1` 下的 [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents)。
Node 另在 `/openai/v1` 提供 [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)，
其独立的资源与事件合同见上方 OpenAI SDK 快速开始及兼容状态文档。

<details>
<summary><strong>智能体</strong> —— 创建和管理智能体配置</summary>

```http
POST   /v1/agents                          # 创建智能体
GET    /v1/agents                          # 列出智能体
GET    /v1/agents/:id                      # 获取智能体
PUT    /v1/agents/:id                      # 更新智能体
DELETE /v1/agents/:id                      # 删除智能体
POST   /v1/agents/:id/archive             # 归档智能体
GET    /v1/agents/:id/versions            # 版本历史
GET    /v1/agents/:id/versions/:version   # 获取特定版本
```

</details>

<details>
<summary><strong>环境</strong> —— 沙箱执行环境</summary>

```http
POST   /v1/environments                   # 创建环境
GET    /v1/environments                   # 列出环境
GET    /v1/environments/:id               # 获取环境
PUT    /v1/environments/:id               # 更新环境
DELETE /v1/environments/:id               # 删除环境
```

</details>

<details>
<summary><strong>会话</strong> —— 运行智能体对话</summary>

```http
POST   /v1/sessions                        # 创建会话
GET    /v1/sessions                        # 列出会话
GET    /v1/sessions/:id                    # 获取会话
POST   /v1/sessions/:id                    # 更新会话
DELETE /v1/sessions/:id                    # 删除会话
POST   /v1/sessions/:id/archive           # 归档会话

POST   /v1/sessions/:id/events            # 发送事件（用户消息）
GET    /v1/sessions/:id/events             # 获取事件（JSON 或 SSE）
GET    /v1/sessions/:id/events/stream      # SSE 流

POST   /v1/sessions/:id/resources          # 附加资源
GET    /v1/sessions/:id/resources          # 列出资源
DELETE /v1/sessions/:id/resources/:resId   # 移除资源
```

</details>

<details>
<summary><strong>保险库</strong> —— 安全凭证存储</summary>

```http
POST   /v1/vaults                          # 创建保险库
POST   /v1/vaults/:id/credentials          # 添加凭证
GET    /v1/vaults/:id/credentials          # 列出（已脱敏密钥）
```

</details>

<details>
<summary><strong>记忆存储</strong> —— 持久化存储；与 Claude Managed Agents Memory 合约一致</summary>

附加到会话时，每个存储都会挂载到沙箱的 `/mnt/memory/<store_name>/` 路径下。智能体使用**标准文件工具**（bash/read/write/edit/glob/grep）读写，没有专门的 `memory_*` 工具。

R2 持有真实字节（key 为 `<store_id>/<memory_path>`）；D1 持有索引 + 审计，通过 R2 Event Notifications → Cloudflare Queue → Consumer 维持最终一致性。

```http
POST   /v1/memory_stores                                        # 创建存储
GET    /v1/memory_stores                                        # 列出存储
GET    /v1/memory_stores/:id                                    # 检索存储
POST   /v1/memory_stores/:id/archive                            # 归档（单向）
DELETE /v1/memory_stores/:id                                    # 删除存储 + 记忆 + 版本

POST   /v1/memory_stores/:id/memories                           # 创建/更新记忆 {path, content, precondition?}
GET    /v1/memory_stores/:id/memories?path_prefix=&depth=N      # 列出记忆（元数据）
GET    /v1/memory_stores/:id/memories/:mid                      # 检索记忆（含内容）
POST   /v1/memory_stores/:id/memories/:mid                      # 更新记忆 {path?, content?, precondition?}
DELETE /v1/memory_stores/:id/memories/:mid                      # 删除记忆

GET    /v1/memory_stores/:id/memory_versions?memory_id=         # 审计历史（最新优先）
GET    /v1/memory_stores/:id/memory_versions/:ver_id            # 单个版本（含快照内容）
POST   /v1/memory_stores/:id/memory_versions/:ver_id/redact     # 编辑历史版本（拒绝实时 head）
```

通过 `precondition: { type: "content_sha256", content_sha256 }` 实现 CAS。每条记忆 100KB 上限。版本保留 30 天，每条记忆的最新版本始终保留。回滚 = 检索旧版本并将其内容写为新一条修订（无需专门端点）。

CLI：
```bash
oma memory stores create "用户偏好"
oma memory write <store-id> /preferences/formatting.md --content "始终使用制表符。"
oma memory ls <store-id> --prefix /preferences/
oma memory versions <store-id> --memory-id <mem-id>
```

</details>

<details>
<summary><strong>文件与技能</strong></summary>

```http
POST   /v1/files                           # 上传文件
GET    /v1/files/:id/content               # 下载文件
POST   /v1/skills                          # 创建技能
GET    /v1/skills                          # 列出技能
```

</details>

---

## 内置工具

`agent_toolset_20260401` 提供：

| 工具 | 描述 |
|---|---|
| `bash` | 在沙箱中执行命令 |
| `read` | 从沙箱文件系统读文件 |
| `write` | 写入/创建文件（自动创建目录） |
| `edit` | 在文件中做精确字符串替换 |
| `glob` | 按模式查找文件 |
| `grep` | 用正则搜索文件内容 |
| `web_fetch` | URL → markdown，通过 Workers AI；当 `agent.aux_model` 设置时自动摘要，原文保存到 `/workspace/.web/` |
| `web_search` | 通过 Tavily API 的网页搜索（需要 `TAVILY_API_KEY`） |
| `schedule` / `cancel_schedule` / `list_schedules` | Cron 风格的自唤醒，用于长时运行的 agent |
| `browser`（按需启用） | 无头浏览器会话 —— 导航、点击、截屏。需通过 `tools: [{ name: "browser", enabled: true }]` 显式启用，默认工具列表会优先引导 agent 使用更便宜的 `web_fetch` |

派生工具会根据会话配置自动生成：

| 工具 | 来源 |
|---|---|
| `call_agent_*` | 可调用智能体（多智能体委派） |
| `mcp__<server>__<tool>` | MCP 服务器（双下划线是真正的分隔符） |

（记忆存储**不**新增专门工具 —— 智能体通过标准文件工具访问 `/mnt/memory/<store_name>/` 下的挂载。）

---

## MCP servers

OMA 接受任何挂在 agent 上的 [Model Context Protocol](https://modelcontextprotocol.io) 服务器。每个上游工具暴露给模型的名字是 `mcp__<server>__<tool>`（双下划线，照抄）。每个 agent 最多挂 20 个 server。

| Transport | 何时用 | 怎么配 |
|---|---|---|
| HTTP / SSE | 托管 MCP server（Linear、GitHub Copilot、Notion ……）| `{"type":"url","url":"https://mcp.linear.app/mcp"}` |
| stdio | 没有托管端点的 npm / PyPI MCP 包 | `{"type":"stdio","command":"uvx","args":[...],"port":8765}` —— OMA 在沙箱容器**里**起进程，连 `127.0.0.1:port/sse` |

凭证不进沙箱；出站 resolver 按 host 匹配，转发时注入。

| Auth 模式 | 怎么配 | 401/403 时刷新 |
|---|---|---|
| none | 不写 `authorization_token`，也没匹配的 vault 凭证 | n/a |
| 内联 bearer | server entry 上写 `"authorization_token": "..."` | 不刷 |
| vault static bearer | 会话 vault 里有 `static_bearer` 凭证，其 `mcp_server_url` 匹配 | 不刷 |
| vault OAuth | 会话 vault 里有 `mcp_oauth` 凭证（带 `refresh_token` + `token_endpoint`）| 刷 —— 401 **和 403** 都刷（Airtable / Asana / Sentry 用 403 表示 token 过期），CAS 写新 token 到 D1，重试一次 |

```bash
# server 挂在 agent 上（不是 session）
curl -X PUT $BASE/v1/agents/$AGENT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"mcp_servers":[{"name":"linear","type":"url","url":"https://mcp.linear.app/mcp"}]}'

# 通过 Vault 绑 OAuth 凭证
oma connect linear --vault $VAULT_ID
```

每个 server 的工具发现超时 15 秒；一个坏掉的 server 会日志记录后跳过，其它继续。完整设计见 [docs.openma.dev/build/vault-and-mcp](https://docs.openma.dev/build/vault-and-mcp/)。

---

## Skills

一个 skill = 一个 `SKILL.md` + 参考文件（模板、schema、示例）。会话开始时平台把所有文件挂到沙箱的 `/home/user/.skills/{name}/`，**并把 SKILL.md 正文直接 inline 进 system prompt** —— 不是惰性读，不需要 agent 再调 `read` 工具去发现。格式和 Anthropic [Claude Code skills](https://github.com/anthropics/skills) 兼容。

创建 skill（JSON，文件 inline 进去）：

```http
POST /v1/skills
{
  "files": [
    { "filename": "SKILL.md", "content": "---\nname: invoice-parser\ndescription: 解析供应商发票。\n---\n\n# 步骤\n1. ..." },
    { "filename": "schema.json", "content": "{...}" }
  ]
}
```

大 skill 带二进制：`POST /v1/skills/upload` multipart 上传 `file=<my-skill.zip>`。

挂到 agent 上要用**对象数组**，光给字符串数组**不会生效**：

```json
{ "skills": [{ "skill_id": "skill_abc123", "type": "custom" }] }
```

会话开始时，agent 的 system prompt 收到：

```text
<source name="skill:skill_abc123">
<skill name="invoice-parser">
{完整 SKILL.md 正文}
</skill>
</source>
```

文件出现在 `/home/user/.skills/invoice-parser/SKILL.md` 等位置。

四个内置 skill 开箱即用（不用上传）：`xlsx`、`pdf`、`docx`、`pptx`。用 `{"skill_id":"builtin_pdf","type":"anthropic"}` 这种方式挂上去。

---

## Vaults 与出站凭证

**工具看不到你的 token。** 沙箱发起 HTTP 请求时，出站 resolver —— 自部署上是 `oma-vault` sidecar（mockttp HTTPS 代理 + 自签 CA），Cloudflare 上是 agent worker 的 `outboundByHost` 拦截器 —— 按 host 匹配会话的 vault，**剥掉入站的 `Authorization`/`x-api-key`/`x-goog-api-key`**，注入真实凭证，再转发。被 prompt injection 的 agent 拿不到任何东西可泄露；沙箱里 `env | grep TOKEN` 什么都没有。

```bash
# 建一个 vault 并加一条绑到 api.github.com 的 static bearer
VID=$(curl -sX POST $BASE/v1/vaults -H "x-api-key: $KEY" \
  -d '{"name":"github-prod"}' | jq -r .id)

curl -sX POST $BASE/v1/vaults/$VID/credentials -H "x-api-key: $KEY" -d '{
  "display_name": "gh-pat",
  "auth": {
    "type": "static_bearer",
    "token": "ghp_xxx",
    "mcp_server_url": "https://api.github.com"
  }
}'

# 创建 session 时绑上
curl -sX POST $BASE/v1/sessions -H "x-api-key: $KEY" \
  -d "{\"agent\":\"$AGENT\",\"vault_ids\":[\"$VID\"]}"

# 沙箱内: curl https://api.github.com/user → 200，Authorization 在网络层注入
```

三种凭证类型共用一个 resolver：

| 类型 | 匹配方式 | 刷新 |
|---|---|---|
| `static_bearer` | 请求 host 匹配 `mcp_server_url` | 永不 |
| `mcp_oauth` | 请求 host 匹配 `mcp_server_url` | 401 / 403 时用 `token_endpoint` 刷新，CAS 写回 D1 |
| `cap_cli` | 沙箱里 CLI 调用按 `cli_id` 在 cap registry 里查（`gh`、`glab`、`aws` ……）| 按每个 CLI 处理 |

每个 vault 最多 20 条凭证。每次转发会发一条结构化的 `op:"mcp_proxy.forward"` 日志。完整设计：[`docs/mcp-credential-architecture.md`](docs/mcp-credential-architecture.md)、[docs.openma.dev/build/vault-and-mcp](https://docs.openma.dev/build/vault-and-mcp/)。

---

## 集成

把一个 agent 发布到第三方工具里，让它像真正的团队成员一样在那边工作 —— 被分配、被 @、像普通用户一样收到回复。

### Linear

让 agent 成为 Linear workspace 的成员，拥有自己的身份、头像和 `@autocomplete` 槽位。它出现在 assignee 下拉框里，被 `@提及` 时收到通知、在 Agent panel 里回复，并把状态推回它正在处理的 issue。

两种安装方式：

| 方式 | 何时用 | 怎么装 |
|---|---|---|
| **`personal_token`**（PAT）| 单 workspace，最快路径，无 OAuth App | `oma linear install-pat --workspace <slug> --pat <linear-pat>` |
| **`dedicated`**（OAuth App）| 多 workspace、独立 bot 身份、OAuth 自动刷新 | Console **集成 → Linear → 发布智能体**（向导会签发 per-publication 的 callback + webhook URL，你拿去贴到自己在 `linear.app/settings/api` 注册的 OAuth App 里）|

完整的 agent 侧操作手册（何时询问人、如何提供浏览器自动化、应该往 Linear 表单里粘贴什么）见 [`skills/openma/integrations-linear.md`](skills/openma/integrations-linear.md)。

PAT 模式自动派单 —— 按 label / state / project 让 bot 自己捡未分配 issue：

```bash
oma linear rules create <pub-id> --label triage --state Backlog --project "Inbox"
oma linear rules list <pub-id>
oma linear rules delete <rule-id>
```

查看 / 管理：

```bash
oma linear list                                       # workspaces
oma linear pubs <installation-id>                     # 发布列表（status=live、persona、caps）
oma linear get <pub-id>                               # 单条发布
oma linear update <pub-id> --caps issue.read,comment.write,issue.update,…
oma linear unpublish <pub-id>
```

工作原理：

| 部件 | 功能 |
|---|---|
| **每发布独立身份** | `dedicated` 给每个 agent 注册自己的 Linear OAuth App；`personal_token` 复用人的 PAT（不注册 App）|
| **入站 webhook** | Linear 事件转成会话上的用户消息 —— 分配、`@提及`、comment-mention、活跃 thread 里的新 comment、**Agent panel**（`agentSessionCreated` / `agentSessionPrompted`、`commentReply` 用于线程延续）|
| **出站 MCP** | agent 通过 `mcp.linear.app/mcp` 用自己的 bearer 写回去（PAT 或 OAuth-refreshed），写入归属到对应人格 |
| **能力门** | 每次发布的 allowlist（issue / comment / label / assign / triage）限制 agent 能做什么 |

Linear 集成以 `packages/linear/`（provider 逻辑、webhook 签名、MCP 配线）落地，CF 路由薄壳在 `apps/integrations/src/routes/linear/publications.ts`。

### GitHub

给 agent 一个自己的 GitHub App + 真实 bot 身份 —— 能被 issue 分配、能被 PR 提名为 reviewer、用自己的 `@<slug>[bot]` 句柄发评论。每个 agent 都是 github.com 上一个独立的 App（per-publication，不是共享 marketplace bot），凭证和审计日志彼此隔离。

```bash
# (1) Console —— 适合人通过向导点击
集成 → GitHub → 发布智能体

# (2) CLI —— 适合代表用户驱动 openma 的 agent
oma github bind <agent-id> --env <env-id>       # → 打开一键 GitHub App Manifest 流程
oma github handoff <form-token>                 # 备选：7 天有效的 URL 让 org 管理员去走完
oma github list
oma github pubs <installation-id>
oma github update <pub-id> --caps pr.read,pr.review.write,issue.comment.write,…
oma github unpublish <pub-id>
```

`bind` 返回 `manifestStartUrl`；打开后会自动 POST 一份 App manifest 到 `github.com/settings/apps/new`，redirect URL、webhook URL、建议权限都已经填好。确认后 GitHub 把你引到 "Install on org" 页面，安装完毕，publication 变 `live`。手动 fallback：`oma github submit <form-token> --app-id … --private-key-file … --webhook-secret …`（如果你手动注册过 App）。

**触发是基于 label 的。** 安装时 OMA 会在每个选中仓库自动创建一个 label（默认是人格名字小写）。给任意 issue / PR 加上这个 label 就能让 bot 接管那条 thread 的后续所有动作；移除 label 就静音。`@<slug>[bot]` 在正文 / 评论里 mention 是 fallback 路径（GitHub `@` 自动补全不会带 Bot 账户，所以要纯文本输入）。

工作原理：

| 部件 | 功能 |
|---|---|
| **每发布独立 App** | 每个 agent 通过 Manifest 流程注册自己的 GitHub App；凭证 per-publication 加密存储 |
| **入站 webhook** | `issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment` 转成会话上的用户消息（每个 `<repo>#<num>` 一个 session）|
| **出站 MCP** | agent 用 installation token 直接打到 GitHub 自家的 MCP `api.githubcopilot.com/mcp/`；同一个 token 也作为 `GITHUB_TOKEN` 注入到沙箱里的 `gh` / `git` |
| **token 轮换** | 1 小时的 installation token 在每次 webhook 派发时通过 App JWT 自动刷新 |
| **能力门** | per-publication allowlist；破坏性操作（`pr.merge`、`repo.branch.delete`、`workflow.dispatch`、`release.create`、`*.delete`）必须显式 opt-in |

GitHub 集成的 provider 逻辑在 `packages/github/`，CF 路由薄壳在 `apps/integrations/src/routes/github/`。

### Slack

把 agent 发到 Slack workspace 里当一个 dedicated bot —— 在 channel 里能被 `@mention`、在 thread 里回复、能进 DM、托管 AI 助手面板。**每 channel 一个 session**：一个 `(publication, channel)` 对应一个运行中的 session，该 channel 里所有事件都汇到同一个 session id 上。

```bash
# (1) Console —— 适合人通过向导点击
集成 → Slack → 发布智能体          # ↑ 会打开 api.slack.com，manifest 已预填

# (2) CLI —— 适合代表用户驱动 openma 的 agent
oma slack publish <agent-id> --env <env-id>    # → 返回 manifestLaunchUrl + formToken（60 分钟 TTL）
oma slack submit <form-token> --client-id … --client-secret … --signing-secret …
oma slack handoff <form-token>                 # 备选：7 天有效的 URL 让 workspace 管理员去走完
oma slack list
oma slack pubs <installation-id>
oma slack update <pub-id> --caps message.write,thread.reply,reaction.add,…
oma slack unpublish <pub-id>
```

完整的 agent 侧操作手册（manifest 流程注意事项、`GATEWAY_ORIGIN` 必须 HTTPS、应该把什么粘到哪、MCP 开关探测）见 [`skills/openma/integrations-slack.md`](skills/openma/integrations-slack.md)。

工作原理：

| 部件 | 功能 |
|---|---|
| **每发布独立 App** | 每个 agent 通过 "Create from manifest" URL 流程注册自己 dedicated 的 Slack App —— 独立的 client id、signing secret、bot user；没有共享 marketplace App |
| **入站 webhook** | `app_mention` / DM / thread 回复 → `direct_invocation` 信号；channel 顶层发言 → 防抖窗口 `channel_scan_armed`（90 秒窗口）；对 bot 自己消息的 reaction → `reaction_on_bot_message`；bot 自身 `member_joined`/`member_left_channel` → `joined_channel` / `session_closed`；`channel_archive` / `channel_unarchive` → 关闭 / 重开 |
| **双 token 出站** | OAuth v2 同时拿到 bot（`xoxb-`）和 user（`xoxp-`）两个 token。`xoxp-` vault 绑到 `mcp.slack.com/mcp` 提供 `mcp__slack__*` 类型化工具（搜索、history、canvas）；`xoxb-` vault 绑到 `slack.com/api` 提供 `chat.postMessage`、reaction 等。bot 默认在 thread 里回复 |
| **能力门** | per-publication allowlist（`message.read/write/update/delete`、`thread.reply`、`reaction.add/remove`、`user.read`、`search.read`、`canvas.write`）|
| **断点续装** | publication-first —— shell 行一开始就建好，callback + webhook URL 第一秒就烤进 manifest。中途失败仍能从 Console 继续（`pending_setup` → `credentials_filled` → `awaiting_install` → `live`）|

Slack 集成的 provider 逻辑在 `packages/slack/`，CF 路由薄壳在 `apps/integrations/src/routes/slack/`。

**运维要求：** 集成网关需要把 `GATEWAY_ORIGIN` 指向可公网访问的 HTTPS host —— Slack 会在让你完成安装前先验证 OAuth redirect URL 和 Events Request URL。

---

## 项目结构

```
open-managed-agents/
├── apps/
│   ├── main/              # API worker（Cloudflare） —— Hono 路由、认证、限流
│   ├── main-node/         # API worker（Node 自部署） —— 同一套路由跑在 Hono/Node 上
│   ├── agent/             # Agent worker —— SessionDO + harness + 沙箱
│   ├── integrations/      # 集成网关 —— Linear / GitHub / Slack OAuth + webhook
│   ├── oma-vault/         # 保险库 sidecar —— 出站请求按 host 注入鉴权头
│   ├── console/           # Web 控制台 —— React + Vite + Tailwind v4
│   ├── docs/              # 文档站点（Astro Starlight） —— 发布到 docs.openma.dev
│   └── web/               # 营销站点（Astro） —— 发布到 openma.dev
├── packages/
│   ├── cli/                       # `oma` CLI —— 智能体 / 会话 / 集成命令
│   ├── sdk/                       # Harness SDK —— defineHarness、generateText 等
│   ├── api-types/                 # 共享 TypeScript 类型（配置 schema、事件类型）
│   ├── http-routes/               # 公开 REST 路由定义（main 与 main-node 共用）
│   ├── session-runtime/           # Harness 运行时 —— 事件日志、广播、恢复
│   ├── sandbox/                   # 沙箱 Port 与 provider-neutral 编排
│   ├── credentials-store/         # 加密凭证存储（基于 PLATFORM_ROOT_SECRET 的 AES-GCM）
│   ├── model-cards-store/         # 加密的 Model Card API key 存储
│   ├── vaults-store/              # 保险库定义 + 出站鉴权配线
│   ├── linear/  github/  slack/   # Provider 逻辑（OAuth、webhook 签名、MCP 配线）
│   ├── integrations-core/         # Provider 无关的持久化接口
│   └── integrations-adapters-{cf,node}/  # D1 / KV / Workers + Postgres / FS 实现
├── docs/                  # 内部设计 RFC（不是面向用户的站点）
├── test/                  # 单元 + 集成测试
└── scripts/               # 部署 + 运维脚本
```

---

## 配置

启动和加密静态存储所必需的变量：

| 变量 | 必需 | 描述 |
|---|---|---|
| `PLATFORM_ROOT_SECRET` | **是** | `credentials.auth`、`model_cards.api_key_cipher` 以及集成 token 的 AES-GCM 密钥。Worker 没有它无法启动。**务必备份** —— 丢失后所有加密行都将无法解密。用 `openssl rand -base64 32` 生成。 |
| `BETTER_AUTH_SECRET` | **是**（生产） | better-auth 用来签发会话的 key，缺了之后会话无法在重启后保留。用 `openssl rand -hex 32` 生成。 |
| `API_KEY` | 是 | 开发 / 首次启动用的 REST API 引导 key。Console 跑起来后，优先在那里按 tenant 申请 API key。 |
| `INTEGRATIONS_INTERNAL_SECRET` | 是（启用 `apps/integrations` 时） | `apps/main` 与 `apps/integrations` 之间的共享密钥。 |
| `ANTHROPIC_API_KEY` | 否 | tenant 还没添加 Model Card 时使用的备用 LLM 凭证。**生产环境请在 Console 里按 tenant 添加 Model Card** —— 它会基于 `PLATFORM_ROOT_SECRET` 加密静态存储、按 tenant 隔离、并且能不重新部署就轮换。 |
| `ANTHROPIC_BASE_URL` | 否 | 切到任意 Anthropic 兼容代理。 |
| `PUBLIC_BASE_URL` | 否（开发） / 是（生产） | Cookie 域和 OAuth redirect 的根。默认 `*` trusted-origins —— 只适合本地开发。 |
| `SANDBOX_PROVIDER` | **是**（Node/Fly） | 显式选择隔离后端：`litebox`（本机 Firecracker）、`daytona`、`e2b` 或 `boxrun`。可部署入口没有 subprocess 回退。 |
| `TAVILY_API_KEY` | 否 | `web_search` 内置工具的后端。 |

完整变量列表（集成 OAuth 凭证、Postgres URL、沙箱调参、记忆桶配置、Google 登录等）：**[docs.openma.dev/reference/configuration](https://docs.openma.dev/reference/configuration/)** 以及 `.env.example` / `.dev.vars.example`。

---

## Model Cards

按 tenant 隔离的 LLM 凭证。Agent 通过 `agent.model = "<model_id>"` 引用一张 card，worker 查到这张 card 后用它的 api_key、base_url、headers 签出站请求。这是全局 `ANTHROPIC_API_KEY` env 的官方替代品。

Provider（wire tag → 请求形态）：

| tag | 形态 | 典型用途 |
|---|---|---|
| `ant` | Anthropic `/v1/messages` | `api.anthropic.com` 上的 Claude |
| `ant-compatible` | Anthropic 形态，自定义 `base_url` | Bedrock 代理、自部署 Anthropic 兼容 |
| `oai` | OpenAI `/v1/chat/completions` | OpenAI、Azure OpenAI |
| `oai-compatible` | OpenAI 形态，自定义 `base_url` | vLLM、OpenRouter、Groq 等 |

在 **Console → Model Cards** 里加一张，或者用 CLI：

```bash
oma models create \
  --model-id claude-prod \
  --provider ant \
  --model claude-sonnet-4-6 \
  --api-key sk-ant-...
oma models list
```

REST：`POST /v1/model_cards`、`GET /v1/model_cards`、`POST /v1/model_cards/:id`（轮换）、`DELETE /v1/model_cards/:id`。创建时会跑一次 6 秒的探测，让坏 key 立刻报错，不至于到第一轮真实调用时才挂。

Key 以 AES-256-GCM 加密静态存储，密钥派自 `PLATFORM_ROOT_SECRET`（label `model.cards.keys`）；list 接口只返回末 4 位预览。轮换 = POST 新 `api_key` —— 不需要重新部署，没有 key 版本号（如果是轮换 `PLATFORM_ROOT_SECRET` 本身，跑一次 backfill 脚本）。

---

## 测试

```bash
npm test          # 单元 + 集成套件
npm run typecheck # 零错误
pnpm run test:openai-agents      # OpenAI SDK、HTTP 与会话行为
pnpm run test:openai-agents:node # Node 执行与子代理
pnpm run test:e2e:openai-agents # 官方 SDK 访问真实 Node 服务的 E2E
```

已测试的 SDK 版本、覆盖范围和已知限制见
[OpenAI 兼容报告](docs/openai-agents-compatibility-status.md)与
[上游测试审计](docs/openai-agents-upstream-test-audit.md)。

---

## 文档

面向用户的文档站点位于 [`apps/docs`](apps/docs/)（Astro Starlight），发布到 **[docs.openma.dev](https://docs.openma.dev)**。

```bash
pnpm dev:docs       # 本地预览在 http://localhost:4321
pnpm build:docs     # 静态构建到 apps/docs/dist/
pnpm deploy:docs    # 构建 + wrangler 部署（Cloudflare Worker 静态资源）
```

仓库根目录下的 `docs/` 文件夹是**内部设计 RFC** —— 不是面向用户的站点。

---

## 贡献

1. Fork 仓库
2. 创建功能分支（`git checkout -b feat/amazing-feature`）
3. 跑测试（`npm test && npm run typecheck`）
4. 提交修改
5. 开 Pull Request

---

## 许可证

[Apache 2.0](LICENSE)
