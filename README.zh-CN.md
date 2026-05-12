<p align="center">
  <img src="logo.svg" alt="openma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/Tests-passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**一个开源的AI智能体元框架，运行在Cloudflare上。**

编写一个框架，部署它 —— 平台会自动运行，内置会话、沙箱、工具、记忆、保险库和崩溃恢复功能。

📖 **完整文档：** [docs.openma.dev](https://docs.openma.dev)

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
pnpm install
```

### 2. 本地运行

无需Cloudflare账户。所有功能都通过Wrangler在本地运行。

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```
API_KEY=dev-test-key
ANTHROPIC_API_KEY=sk-ant-xxx
```

```bash
pnpm dev
# API   → http://localhost:8787
# 控制台 → http://localhost:5173
```

验证：

```bash
curl localhost:8787/health
# {"status":"ok"}
```

### 3. 部署到Cloudflare

需要 [Workers付费计划](https://developers.cloudflare.com/workers/platform/pricing/)（用于Durable Objects + 容器）。

```bash
# 登录
npx wrangler login

# 创建基础设施
npx wrangler kv namespace create CONFIG_KV
# → 将命名空间ID粘贴到wrangler.jsonc中

npx wrangler r2 bucket create managed-agents-workspace  # 可选，用于文件持久化

# 设置密钥
npx wrangler secret put API_KEY
npx wrangler secret put ANTHROPIC_API_KEY

# 部署
npm run deploy
# → https://openma.dev (或个人部署: https://managed-agents.<your-subdomain>.workers.dev)
```

部署的内容：

| 组件 | 功能 |
|---|---|
| **主工作器** | API路由 —— 智能体、会话、环境、保险库、记忆、文件 |
| **智能体工作器** | SessionDO + 框架 + 每个环境的沙箱 |
| **KV命名空间** | 智能体、环境、凭证的配置存储 |
| **R2存储桶** | 容器重启间的持久化工作区文件 |

### 4. 创建第一个智能体

```bash
BASE=http://localhost:8787  # 或您的部署URL
KEY=dev-test-key

# 创建智能体
AGENT_ID=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "你是一个有帮助的编程助手。",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r '.id')

# 创建环境（带包的沙箱）
ENV_ID=$(curl -s $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "dev",
    "config": {
      "type": "cloud",
      "packages": { "pip": ["requests", "pandas"] }
    }
  }' | jq -r '.id')

# 启动会话
SESSION_ID=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\"}" \
  | jq -r '.id')

# 发送消息
curl -s $BASE/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{ "type": "text", "text": "编写一个获取HN热门文章的Python脚本" }]
    }]
  }'

# 流式事件 (SSE)
curl -N $BASE/v1/sessions/$SESSION_ID/events/stream \
  -H "x-api-key: $KEY"
```

---

## 架构

**元框架**不是一个智能体 —— 它是运行智能体的平台。它为智能体所需的一切定义了稳定的接口，并且不会干扰智能体循环：

```
┌─────────────────────────────────────────────────────────┐
│  框架（大脑 —— 您的代码）                               │
│  - 读取事件，构建上下文，调用模型                     │
│  - 决定如何：缓存、压缩、工具交付                     │
│  - 无状态：崩溃 → 从事件日志重建 → 恢复               │
├─────────────────────────────────────────────────────────┤
│  元框架（平台 —— SessionDO）                          │
│  - 准备可用的内容：工具、技能、历史                   │
│  - 管理生命周期：沙箱、事件、WebSocket                │
│  - 崩溃恢复、凭证隔离、使用跟踪                       │
├─────────────────────────────────────────────────────────┤
│  基础设施（Cloudflare）                               │
│  - Durable Objects + SQLite —— 会话事件日志           │
│  - 容器 —— 隔离的代码执行                             │
│  - KV + R2 —— 配置、文件、凭证                        │
└─────────────────────────────────────────────────────────┘
```

**平台准备_什么_是可用的。框架决定_如何_将其交付给模型。**

| 平台管理 | 框架决定 |
|---|---|
| 事件日志持久化 (SQLite) | 上下文工程（过滤、排序） |
| 沙箱生命周期（容器） | 缓存策略（缓存断点） |
| 工具注册（内置 + MCP） | 压缩策略（何时压缩） |
| WebSocket广播 | 重试策略（退避、瞬时检测） |
| 崩溃恢复 | 停止条件（最大步骤、完成信号） |
| 凭证隔离（保险库） | 系统提示构建 |
| 记忆（向量搜索） | 工具交付（一次性 vs 渐进式） |

---

## 编写框架

默认框架开箱即用。当您需要自定义行为 —— 不同的缓存、压缩、上下文工程 —— 时，编写您自己的：

```typescript
// my-harness.ts
import { defineHarness, generateText, stepCountIs } from "@open-managed-agents/sdk";

export default defineHarness({
  name: "research",

  async run(ctx) {
    let messages = ctx.runtime.history.getMessages();

    // 您的上下文工程
    messages = keepOnly(messages, ["web_search", "web_fetch"]);

    // 您的缓存策略
    markLastN(messages, 3, { cacheControl: "ephemeral" });

    // 您的循环 —— 工具、沙箱、广播由平台提供
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

部署它：

```bash
oma deploy --harness my-harness.ts --agent agent_abc123
```

框架在构建时捆绑到智能体工作器中。您的代码与SessionDO在同一隔离区运行 —— 直接访问事件日志、沙箱和WebSocket广播。没有RPC，没有序列化边界。

---

## API

与 [Anthropic Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents) 兼容。相同的端点，相同的事件类型，可与现有SDK一起使用。

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
GET    /v1/sessions/:id/events             # 获取事件（JSON或SSE）
GET    /v1/sessions/:id/events/stream      # SSE流

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
GET    /v1/vaults/:id/credentials          # 列出（移除密钥）
```

</details>

<details>
<summary><strong>记忆存储</strong> —— 持久化存储；Anthropic Managed Agents记忆合约</summary>

当附加到会话时，每个存储都会挂载到沙箱中的
`/mnt/memory/<store_name>/`。智能体使用
**标准文件工具**（bash/read/write/edit/glob/grep）读取和写入 —— 没有
专门的 `memory_*` 工具。

R2持有字节真相（键 `<store_id>/<memory_path>`）；D1持有
索引 + 审计，通过R2事件通知 → Cloudflare队列 → 消费者保持最终一致性。

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
POST   /v1/memory_stores/:id/memory_versions/:ver_id/redact     # 编辑先前版本（拒绝实时头部）
```

通过 `precondition: { type: "content_sha256", content_sha256 }` 进行CAS。每个记忆100KB
上限。30天版本保留，每个记忆的最近版本始终保留。回滚 = 检索版本并将其
内容写为新记忆修订（无特殊端点）。

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
| `read` | 从沙箱文件系统读取文件 |
| `write` | 写入/创建文件（自动创建目录） |
| `edit` | 在文件中进行精确字符串替换 |
| `glob` | 查找匹配模式的文件 |
| `grep` | 使用正则表达式搜索文件内容 |
| `web_fetch` | URL → markdown 通过Workers AI；当设置了 `agent.aux_model` 时自动摘要，原始内容保存到 `/workspace/.web/` |
| `web_search` | 通过Tavily API进行网页搜索 |

派生工具根据会话配置自动生成：

| 工具 | 源 |
|---|---|
| `call_agent_*` | 可调用智能体（多智能体委派） |
| `mcp_*` | MCP服务器 |

（记忆存储**不**添加专门工具 —— 智能体通过标准文件工具将它们作为文件系统
挂载在 `/mnt/memory/<store_name>/` 处访问。）

---

## 集成

将智能体发布到第三方工具中，并让它像真正的团队成员一样在那里工作 —— 被分配、被提及、被回复。

### Linear

让智能体成为Linear工作区的成员，拥有自己的身份、头像和 `@autocomplete` 槽位。智能体出现在分配下拉菜单中，在被 `@提及` 时收到通知，并将状态推回它正在处理的问题。

有两种方式驱动发布流程：

```bash
# (1) 控制台 —— 适用于人类通过向导点击
集成 → Linear → 发布智能体

# (2) CLI —— 适用于代表用户驱动openma的智能体
oma linear publish <agent-id> --env <env-id>          # → 返回Linear应用配置 + 表单令牌
oma linear submit <form-token> --client-id … --client-secret …   # ↑ 一旦Linear提供OAuth凭证
oma linear list                                       # 验证工作区
oma linear pubs <installation-id>                     # 验证智能体显示状态=live
oma linear update <pub-id> --caps issue.read,comment.write,…   # 收紧能力
oma linear unpublish <pub-id>                         # 拆除
```

完整的智能体端操作手册（何时询问人类、如何提供浏览器自动化、确切地粘贴到Linear表单的内容）位于 [`skills/openma/integrations-linear.md`](skills/openma/integrations-linear.md)。

工作原理：

| 部分 | 功能 |
|---|---|
| **每个智能体的应用** | 每个智能体注册为自己的Linear OAuth应用，因此身份是隔离的 |
| **入站webhook** | Linear事件（分配、提及、评论）成为会话上的用户消息 |
| **出站MCP** | 智能体通过 `mcp.linear.app` 使用自己的承载器进行通信，因此写入归属于角色 |
| **能力门控** | 每次发布的允许列表（问题/评论/标签/分配/分类）限制智能体可以执行的操作 |

Linear集成以三个包的形式提供：`packages/linear/`（提供程序逻辑），`packages/integrations-core/`（提供程序中立的持久化类型），`packages/integrations-adapters-cf/`（D1实现）。添加第二个集成（Slack、GitHub、...）就是针对相同接口编写新的提供程序。

---

## 项目结构

```
open-managed-agents/
├── apps/
│   ├── main/              # API工作器 —— Hono路由、认证、速率限制
│   ├── agent/             # 智能体工作器 —— SessionDO + 框架 + 沙箱
│   ├── integrations/      # 集成网关 —— Linear OAuth + webhooks
│   └── console/           # 网页仪表板 —— React + Vite + Tailwind v4
├── packages/
│   ├── cli/               # `oma` CLI —— 智能体/会话/集成命令
│   ├── shared/            # 共享类型和实用程序
│   ├── linear/            # Linear提供程序（发布流程、webhook签名）
│   ├── integrations-core/ # 提供程序中立类型、持久化接口
│   ├── integrations-adapters-cf/ # D1 / KV / Workers适配器
│   └── integrations-ui/   # 控制台挂载的React页面
├── test/                  # 单元 + 集成测试
└── scripts/               # 部署脚本
```

---

## 配置

| 变量 | 必需 | 描述 |
|---|---|---|
| `API_KEY` | 是 | API访问的认证密钥 |
| `ANTHROPIC_API_KEY` | 是 | Claude的Anthropic API密钥 |
| `ANTHROPIC_BASE_URL` | 否 | 自定义端点（代理、兼容API） |
| `TAVILY_API_KEY` | 否 | `web_search`工具的Tavily API密钥 |

---

## 测试

```bash
npm test          # 单元 + 集成套件
npm run typecheck # 零错误
```

---

## 文档

面向用户的文档站点位于 [`apps/docs`](apps/docs/)（Astro Starlight），发布到 **[docs.openma.dev](https://docs.openma.dev)**。

```bash
pnpm dev:docs       # 本地预览在 http://localhost:4321
pnpm build:docs     # 静态构建到 apps/docs/dist/
pnpm deploy:docs    # 构建 + wrangler部署（Cloudflare Worker静态资源）
```

仓库根目录下的 `docs/` 文件夹包含**内部设计RFC** —— 不是面向用户的站点。

---

## 贡献

1. Fork仓库
2. 创建功能分支（`git checkout -b feat/amazing-feature`）
3. 运行测试（`npm test && npm run typecheck`）
4. 提交您的更改
5. 打开拉取请求

---

## 许可证

[Apache 2.0](LICENSE)