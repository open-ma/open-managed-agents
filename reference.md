# 参考文档附录 — Open Managed Agents

本文档汇总了实现所需的全部外部参考资料。

---

## A. Anthropic Managed Agents API

### A.1 核心概念

四个实体：Agent, Environment, Session, Events。

- **Agent**: model + system prompt + tools + MCP servers + skills。创建后通过 ID 跨 session 复用。
- **Environment**: 容器模板（预装包、网络规则、挂载文件）。
- **Session**: 绑定 agent + environment 的运行实例。
- **Events**: user.message / agent.message / agent.tool_use / agent.tool_result / session.status_idle。

Beta header: `anthropic-beta: managed-agents-2026-04-01`

### A.2 API 端点

```
POST   /v1/agents                          # 创建 agent
GET    /v1/agents/:id                       # 获取 agent
POST   /v1/environments                     # 创建 environment
GET    /v1/environments/:id                 # 获取 environment
POST   /v1/sessions                         # 创建 session（绑定 agent + env）
GET    /v1/sessions/:id                     # 获取 session 状态
POST   /v1/sessions/:id/events              # 发送 user events
GET    /v1/sessions/:id/events              # SSE stream（接收 agent events）
```

Rate limits:
- Create endpoints: 60 req/min per org
- Read endpoints: 600 req/min per org

### A.3 创建 Agent

```bash
curl -sS https://api.anthropic.com/v1/agents \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "name": "Coding Assistant",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [
      {"type": "agent_toolset_20260401"}
    ]
  }'
# 返回: { "id": "agent_...", "version": 1, ... }
```

### A.4 创建 Environment

```bash
curl -sS https://api.anthropic.com/v1/environments \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "name": "quickstart-env",
    "config": {
      "type": "cloud",
      "networking": {"type": "unrestricted"}
    }
  }'
# 返回: { "id": "env_...", ... }
```

### A.5 创建 Session + 发送消息 + SSE

```bash
# 创建 session
curl -sS https://api.anthropic.com/v1/sessions \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "agent": "'$AGENT_ID'",
    "environment_id": "'$ENVIRONMENT_ID'",
    "title": "My session"
  }'

# 发送 user message
curl -sS https://api.anthropic.com/v1/sessions/$SESSION_ID/events \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{"type": "text", "text": "Create a Python fibonacci script"}]
    }]
  }'

# SSE stream
curl -sS -N https://api.anthropic.com/v1/sessions/$SESSION_ID/events/stream \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01"
# 返回 SSE events:
#   data: {"type": "agent.message", "content": [{"type": "text", "text": "..."}]}
#   data: {"type": "agent.tool_use", "name": "bash", "input": {...}}
#   data: {"type": "agent.tool_result", "tool_use_id": "...", "content": "..."}
#   data: {"type": "session.status_idle"}
```

### A.6 内置工具列表

| Tool | Name | 说明 |
|---|---|---|
| Bash | `bash` | 在容器 shell 中执行命令 |
| Read | `read` | 读取文件 |
| Write | `write` | 写入文件 |
| Edit | `edit` | 字符串替换编辑文件 |
| Glob | `glob` | 文件模式匹配 |
| Grep | `grep` | 正则搜索 |
| Web fetch | `web_fetch` | URL → markdown（Workers AI 转换，配置 `agent.aux_model` 时自动摘要 + 原文落 `/workspace/.web/`） |
| Web search | `web_search` | 搜索网页 |

配置方式：

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

### A.7 Custom Tools

用户定义 schema，Claude 决定何时调用，用户在 SSE 流中收到 tool_use 事件后自行执行，把结果 POST 回去。

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

### A.8 定价

- 标准 API token 价格（按 model）
- Session runtime: $0.08/session-hour（活跃时间，毫秒精度，idle 不计费）
- Web search: $10/1000 次

### A.9 Research Preview 功能

- **Outcomes (self-evaluation)**: 定义成功标准，Claude 自我迭代。内测提升 task success 最多 10 个百分点。
- **Multi-agent**: 一个 agent 可以 spawn 子 agent。
- **Memory**: 跨 session 记忆。

---

## B. Anthropic Engineering Blog — 架构设计

来源: https://www.anthropic.com/engineering/managed-agents

### B.1 核心架构思想

三层解耦：
- **Session**: append-only event log，持久化在容器外部。`emitEvent()` / `getEvents()` 接口。
- **Brain (Harness)**: 无状态，crash 后 `wake(sessionId)` + `getSession(id)` 恢复。
- **Hands (Sandbox)**: 通过 `execute(name, input) → string` 调用。

### B.2 关键设计决策

**从 pet 到 cattle**: 最初 harness + sandbox 在同一容器内，容器成了 pet。解耦后三层都是 cattle。

**安全边界**: Credential 永远不进 sandbox。Git token 在 provision 阶段注入 remote。MCP OAuth token 存在 vault，通过 proxy 代理调用。

**Session ≠ Context window**: Session 是 context 的外部化存储。`getEvents()` 支持按位置切片回溯。Compaction/trimming 是 harness 层面的可替换策略。

**Meta-harness**: 不对具体 harness 实现做假设，只约束接口形状。Harness 编码的假设会随模型进步过时（例：Sonnet 4.5 有 context anxiety，Opus 4.5 没有）。

### B.3 性能数据

解耦后 p50 TTFT 降约 60%，p95 降超 90%。

---

## C. Cloudflare Containers

来源: https://developers.cloudflare.com/containers/

### C.1 核心概念

Container 实例由 Worker 代码按需启动和控制。每个 Container 背后是一个 Durable Object。

```javascript
import { Container, getContainer } from "@cloudflare/containers";

export class MyContainer extends Container {
  defaultPort = 4000;
  sleepAfter = "10m";
}

export default {
  async fetch(request, env) {
    const { "session-id": sessionId } = await request.json();
    const containerInstance = getContainer(env.MY_CONTAINER, sessionId);
    return containerInstance.fetch(request);
  },
};
```

### C.2 wrangler 配置

```jsonc
{
  "containers": [{
    "class_name": "MyContainer",
    "image": "./Dockerfile",
    "max_instances": 5
  }],
  "durable_objects": {
    "bindings": [{
      "class_name": "MyContainer",
      "name": "MY_CONTAINER"
    }]
  },
  "migrations": [{
    "new_sqlite_classes": ["MyContainer"],
    "tag": "v1"
  }]
}
```

### C.3 Container 类 API

- `defaultPort`: 容器监听端口
- `sleepAfter`: idle 超时后休眠（如 "10m"）
- `enableInternet`: 是否允许出站网络
- `envVars`: 传入环境变量/密钥
- 继承所有 Durable Object 功能（SQLite storage, alarms, WebSocket）

### C.4 关键特性

- 磁盘是临时的（ephemeral）——休眠后重启从镜像恢复
- 冷启动约 2-3 秒
- 最大实例数通过 `max_instances` 控制
- 容器收到 SIGTERM → 15 分钟后 SIGKILL
- linux/amd64 架构

### C.5 Outbound Workers（2026-03-26 新增）

Container 内的 HTTP 请求可以被 Worker 拦截，用于 credential injection：

```javascript
// Container 内代码: curl http://my.kv/some-key
// Worker 拦截后转成 KV binding 调用

export default {
  async outbound(request, env) {
    // 拦截并注入 credentials
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${await env.KV.get("token")}`);
    return fetch(new Request(request, { headers }));
  },
  async outboundByHost(host) {
    if (host === "my.kv") return "outbound";
    return null;
  },
};
```

需要 `@cloudflare/containers` >= 0.2.0。

### C.6 限制（Beta）

- 实例数和大小限制（GA 前会提升）
- 无自动扩缩（手动通过不同 ID 调用 `get()` 扩展）
- DO 和 Container 暂未 co-locate（近期计划）
- Worker 和 Container 代码更新不是原子的

---

## D. Cloudflare Dynamic Workers

来源: https://blog.cloudflare.com/dynamic-workers/

### D.1 核心概念

V8 isolate-based sandbox，运行时动态创建 Worker，毫秒级启动。用于 AI 生成代码的安全执行。

```javascript
let agentCode = `
  export default {
    async myAgent(param, env, ctx) { /* ... */ }
  }
`;

let worker = env.LOADER.load({
  compatibilityDate: "2026-04-08",
  modules: [{ name: "agent-code", esModule: agentCode }],
});

let result = await worker.agentCode.myAgent(param);
```

### D.2 两种模式

- `load()`: 一次性执行，用完即弃
- `get()`: 缓存 Worker by ID，跨请求保持 warm

### D.3 关键特性

- 启动时间: 几毫秒（vs Container 2-3 秒）
- 内存: 几 MB（vs Container 几百 MB）
- 仅支持 JS/TS/Python/WASM（不支持 bash/完整 Linux）
- Outbound HTTP 拦截支持 credential injection
- 同机甚至同线程执行
- 定价: $0.002/unique Worker/day（beta 期间免费）

### D.4 限制

- 无 POSIX shell 支持
- 无文件系统（V8 isolate 限制）
- 适合轻量代码执行，不适合需要完整 Linux 环境的场景

---

## E. Cloudflare Agents SDK

来源: https://developers.cloudflare.com/agents/ + https://www.npmjs.com/package/agents

### E.1 核心概念

基于 Durable Objects 的有状态 agent 框架。每个 agent 是一个 DO 实例，自带 SQLite、WebSocket、调度。

```typescript
import { Agent, callable } from "agents-sdk";

export class MyAgent extends Agent<Env, MyState> {
  @callable()
  async processTask(input: string) {
    // 有状态的 agent 逻辑
    this.setState({ ...this.state, lastInput: input });
    return "done";
  }

  onStart() {
    // DO 启动时调用（首次创建或 hibernate 恢复后）
    this.schedule("daily at 9am", "morningReport");
  }
}
```

### E.2 Agent 类继承链

`DurableObject > Server (partyserver) > Agent`

- `DurableObject`: ctx.storage (KV + SQLite), alarms, WebSocket
- `Server`: URL routing (`/servers/:class/:name`), `onStart`, `onRequest`, `onConnect`
- `Agent`: 自动 state 持久化, `@callable` RPC, 调度, MCP 支持, email routing

### E.3 关键 API

```typescript
// State 管理
this.state          // getter, 从 SQLite 惰性加载
this.setState(newState)  // 自动序列化并持久化

// WebSocket
this.broadcast(data)     // 广播给所有连接
this.onMessage(conn, msg) // 接收消息
this.onConnect(conn)      // 新连接

// 调度
this.schedule("weekdays at 11:30am", "taskName")

// MCP
await this.addMcpServer("name", "https://...", { transport: { type: "streamable-http" } })
this.mcp.getTools()

// RPC
@callable()
async myMethod(param: string) { ... }

// 销毁
this.destroy()  // 安全清理 + evict
```

### E.4 路由

```typescript
import { routeAgentRequest } from "agents-sdk";

export default {
  async fetch(request: Request, env: Env) {
    return routeAgentRequest(request, env) ??
      new Response("Not found", { status: 404 });
  },
};
// URL: /servers/MyAgent/instance-name
```

### E.5 Hibernate

DO idle 后自动 hibernate，WebSocket 连接保持但不计费。收到消息后自动 wake，`onStart` 重新执行。

### E.6 Workflows 集成

```typescript
import { AgentWorkflow } from "agents";

export class OrderWorkflow extends AgentWorkflow<OrderAgent, OrderParams> {
  async run(event, step) {
    const validated = await step.do("validate", async () => validateOrder(event.payload));
    const approval = await this.waitForApproval(step, { timeout: "7 days" });
    await step.do("process", async () => processOrder(validated));
  }
}
```

---

## F. Vercel AI SDK

来源: https://ai-sdk.dev/ + https://vercel.com/blog/ai-sdk-6

### F.1 核心 API

```typescript
import { generateText, tool } from "ai";

const result = await generateText({
  model: "anthropic/claude-sonnet-4-6", // 或 openai/gpt-5.4, google/gemini-3-flash
  system: "You are a helpful assistant.",
  messages: [...],
  tools: {
    getWeather: tool({
      description: "Get weather for a location",
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ temperature: 72 }),
    }),
  },
  maxSteps: 20, // agent loop: 自动执行 tool → 回传结果 → 继续
});
```

### F.2 ToolLoopAgent (v6)

```typescript
import { ToolLoopAgent, stopWhen, stepCountIs } from "ai";

const agent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4-6",
  system: "...",
  tools: { ... },
  stopWhen: stepCountIs(20),
});

const result = await agent.generate({ prompt: "..." });
// 或
const stream = await agent.stream({ prompt: "..." });
```

### F.3 Human-in-the-loop

```typescript
tools: {
  deleteFile: tool({
    description: "Delete a file",
    inputSchema: z.object({ path: z.string() }),
    needsApproval: true, // 需要用户确认
    execute: async ({ path }) => { ... },
  }),
}
```

### F.4 Provider 切换

```typescript
// 一行换 provider
model: "anthropic/claude-sonnet-4-6"
model: "openai/gpt-5.4"
model: "google/gemini-3-flash"

// 或直接用 provider SDK
import { anthropic } from "@ai-sdk/anthropic";
model: anthropic("claude-sonnet-4-6")
```

### F.5 MCP 支持

```typescript
import { experimental_createMCPClient } from "ai";

const mcpClient = await experimental_createMCPClient({
  transport: { type: "sse", url: "https://mcp.example.com/sse" },
});

const tools = await mcpClient.tools();

const result = await generateText({
  model: "anthropic/claude-sonnet-4-6",
  tools,
  prompt: "...",
});
```

### F.6 Streaming

```typescript
import { streamText } from "ai";

const result = streamText({
  model: "anthropic/claude-sonnet-4-6",
  messages: [...],
  tools: { ... },
  onStepFinish: (step) => {
    // 每一步完成时回调
    console.log("Step:", step.stepType, step.text);
  },
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

---

## G. 关键链接汇总

| 资源 | URL |
|---|---|
| Anthropic Managed Agents 文档 | https://platform.claude.com/docs/en/managed-agents/overview |
| Anthropic 工程博客 | https://www.anthropic.com/engineering/managed-agents |
| Anthropic Agent SDK | https://platform.claude.com/docs/en/agent-sdk/overview |
| Cloudflare Containers 文档 | https://developers.cloudflare.com/containers/ |
| Cloudflare Containers 完整文档 | https://developers.cloudflare.com/containers/llms-full.txt |
| Cloudflare Dynamic Workers 博客 | https://blog.cloudflare.com/dynamic-workers/ |
| Cloudflare Outbound Workers | https://developers.cloudflare.com/changelog/post/2026-03-26-outbound-workers/ |
| Cloudflare Agents SDK 文档 | https://developers.cloudflare.com/agents/ |
| Cloudflare Agents SDK 完整文档 | https://developers.cloudflare.com/agents/llms-full.txt |
| agents npm 包 | https://www.npmjs.com/package/agents |
| @cloudflare/containers npm 包 | https://www.npmjs.com/package/@cloudflare/containers |
| Cloudflare agents GitHub | https://github.com/cloudflare/agents |
| Vercel AI SDK 文档 | https://ai-sdk.dev/docs/introduction |
| AI SDK GitHub | https://github.com/vercel/ai |
| AI SDK v6 发布 | https://vercel.com/blog/ai-sdk-6 |