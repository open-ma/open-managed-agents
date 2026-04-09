# Open Managed Agents on Cloudflare

开源的 Managed Agents runtime，默认体验对标 Anthropic（纯 JSON config），但 harness 层开源可替换。

## 架构三层

```
┌───────────────────────────────────────────────┐
│  Config API（兼容 Anthropic 接口格式）          │  ← 零代码用户
│  /v1/agents  /v1/environments  /v1/sessions   │
├───────────────────────────────────────────────┤
│  Default Harness（开源，可 fork/替换）          │  ← 开发者 & 社区
│  agent loop · compaction · tool routing       │
│  可插拔：ai-sdk / 自定义 / 社区贡献            │
├───────────────────────────────────────────────┤
│  Runtime 原语（Cloudflare infra）              │  ← 基础设施，不用改
│  DO session · Container sandbox               │
│  Dynamic Workers · credential vault · MCP     │
└───────────────────────────────────────────────┘
```

## Cloudflare 原语映射

| 概念 | Cloudflare 实现 |
|---|---|
| Session (event log) | Durable Object + SQLite，hibernate 模式 idle 不计费 |
| Sandbox (重) | Cloudflare Containers（完整 Linux，bash/file/git） |
| Sandbox (轻) | Dynamic Workers（V8 isolate，毫秒启动，JS/TS only） |
| Credential vault | KV + Outbound Workers（Container 内 HTTP 拦截注入） |
| MCP | agents-sdk 原生 `this.addMcpServer()` |
| Multi-agent | 多 DO 实例通过 RPC 互调 |
| Provider 切换 | ai-sdk 一行换（Claude / GPT / Gemini / Workers AI） |

## 项目结构

```
open-managed-agents/
├── packages/
│   ├── runtime/                    # 底层原语（不动层）
│   │   ├── session-do.ts           # Durable Object: event log + WebSocket
│   │   ├── sandbox/
│   │   │   ├── container.ts        # Cloudflare Container 封装
│   │   │   ├── dynamic-worker.ts   # Dynamic Worker 封装
│   │   │   └── outbound.ts         # credential injection
│   │   ├── vault.ts                # KV credential store
│   │   ├── mcp-bridge.ts           # MCP → tool adapter
│   │   └── history.ts              # event log → messages 格式转换
│   │
│   ├── harness/                    # 默认 harness（可替换层）
│   │   ├── default-loop.ts         # 默认 agent loop（基于 ai-sdk）
│   │   ├── compaction/
│   │   │   ├── interface.ts        # CompactionStrategy 接口
│   │   │   ├── summarize.ts        # 默认：用廉价模型做摘要
│   │   │   ├── sliding-window.ts   # 社区贡献：滑动窗口
│   │   │   └── semantic-trim.ts    # 社区贡献：按语义重要度裁剪
│   │   ├── tool-routing.ts         # tool name → executor 分发
│   │   ├── tools/                  # 内置 tool 实现
│   │   │   ├── bash.ts
│   │   │   ├── file-ops.ts         # read/write/edit/glob/grep
│   │   │   ├── web-search.ts
│   │   │   └── web-fetch.ts
│   │   └── providers/              # ai-sdk provider 预配置
│   │       ├── auto.ts             # 根据 model string 自动选 provider
│   │       └── workers-ai.ts       # Cloudflare Workers AI 特殊适配
│   │
│   ├── api/                        # Config API（薄壳层）
│   │   ├── index.ts                # Worker entry + 路由
│   │   ├── routes/
│   │   │   ├── agents.ts           # CRUD /v1/agents
│   │   │   ├── environments.ts     # CRUD /v1/environments
│   │   │   ├── sessions.ts         # CRUD + event posting
│   │   │   └── sse-bridge.ts       # DO WebSocket → SSE 桥接
│   │   └── auth.ts                 # API key 验证
│   │
│   └── sdk/                        # 客户端 SDK（可选）
│       ├── client.ts               # TypeScript client
│       └── types.ts                # 共享类型
│
├── harnesses/                      # 社区 harness 仓库（可独立 npm 包）
│   ├── coding-agent/               # 针对 coding 场景优化
│   ├── data-analyst/               # 针对数据分析优化
│   └── research-agent/             # 针对长文研究优化
│
├── tool-packs/                     # 社区 tool 包
│   ├── github/                     # GitHub API tools
│   ├── database/                   # SQL/NoSQL tools
│   └── browser/                    # Headless browser tools
│
├── wrangler.jsonc
├── Dockerfile.sandbox              # 默认 sandbox 镜像
└── docker/                         # 可选 sandbox 镜像
    ├── python-data/                # Python + pandas/numpy
    ├── node-full/                  # Node.js + common packages
    └── go-dev/                     # Go 开发环境
```

## 核心接口设计

### HarnessInterface（可替换层的契约）

```typescript
// packages/harness/interface.ts
// 这是用户可以替换的核心接口

export interface HarnessInterface {
  /**
   * 处理用户消息，驱动 agent 完成任务
   * 默认实现用 ai-sdk 的 generateText + maxSteps
   * 用户可以完全替换成自己的 loop 逻辑
   */
  run(ctx: HarnessContext): AsyncIterable<SessionEvent>;
}

export interface HarnessContext {
  // 来自 Config API 的 agent 定义
  agent: AgentConfig;

  // 用户消息
  userMessage: UserMessage;

  // Runtime 原语（底层能力，harness 拿来用）
  runtime: {
    history: HistoryStore;       // 读写 event log
    sandbox: SandboxExecutor;    // 执行 bash/file 操作
    vault: CredentialVault;      // 读取 credentials
    mcp: McpBridge;              // 调 MCP servers
    broadcast: (event: SessionEvent) => void;  // 推送给客户端
  };
}
```

### 默认 Harness（用 ai-sdk 实现）

```typescript
// packages/harness/default-loop.ts
import { generateText, tool } from "ai";
import type { HarnessInterface, HarnessContext } from "./interface";

export class DefaultHarness implements HarnessInterface {
  async *run(ctx: HarnessContext): AsyncIterable<SessionEvent> {
    const { agent, userMessage, runtime } = ctx;

    // 1. 从 event log 恢复历史消息
    const messages = await runtime.history.getMessages();
    messages.push({ role: "user", content: userMessage.content });

    // 2. 构建 tools（内置 + MCP + custom）
    const tools = {
      ...this.buildBuiltinTools(agent, runtime),
      ...await this.buildMcpTools(agent, runtime),
    };

    // 3. ai-sdk 驱动 agent loop
    const result = await generateText({
      model: resolveModel(agent.model), // "claude-sonnet-4-6" → ai-sdk provider
      system: agent.system,
      messages,
      tools,
      maxSteps: 50,

      // 每一步的回调 → 实时推送给客户端
      onStepFinish: async (step) => {
        for (const block of step.response.messages) {
          const event = this.toSessionEvent(block);
          await runtime.history.append(event);
          runtime.broadcast(event);
          yield event;
        }
      },
    });

    yield { type: "session.status_idle" };
  }

  private buildBuiltinTools(agent: AgentConfig, runtime: RuntimePrimitives) {
    const toolDefs: Record<string, any> = {};
    const enabled = getEnabledTools(agent.tools);

    if (enabled.bash) {
      toolDefs.bash = tool({
        description: "Execute a bash command in the sandbox",
        inputSchema: z.object({ command: z.string() }),
        execute: ({ command }) => runtime.sandbox.exec(command),
      });
    }

    if (enabled.read) {
      toolDefs.read = tool({
        description: "Read a file from the sandbox filesystem",
        inputSchema: z.object({ path: z.string() }),
        execute: ({ path }) => runtime.sandbox.readFile(path),
      });
    }

    if (enabled.write) {
      toolDefs.write = tool({
        description: "Write content to a file",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: ({ path, content }) => runtime.sandbox.writeFile(path, content),
      });
    }

    // edit, glob, grep, web_search, web_fetch 同理...
    return toolDefs;
  }

  private async buildMcpTools(agent: AgentConfig, runtime: RuntimePrimitives) {
    // MCP servers 的 tools 自动转成 ai-sdk tool 格式
    const mcpTools: Record<string, any> = {};
    for (const server of agent.mcp_servers ?? []) {
      const tools = await runtime.mcp.getTools(server);
      for (const t of tools) {
        mcpTools[t.name] = tool({
          description: t.description,
          inputSchema: t.inputSchema,
          execute: (input) => runtime.mcp.call(server, t.name, input),
        });
      }
    }
    return mcpTools;
  }
}
```

### Session Durable Object（底层，不需要改）

```typescript
// packages/runtime/session-do.ts
import { Agent } from "agents-sdk";
import { DefaultHarness } from "../harness/default-loop";
import type { HarnessInterface } from "../harness/interface";

export class SessionDO extends Agent<Env, SessionState> {
  private harness: HarnessInterface;

  async onStart() {
    this.ensureSchema();
    // 默认用 DefaultHarness，可以通过 agent config 指定替换
    this.harness = this.resolveHarness(this.state.harnessType);
  }

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data JSON NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  async onMessage(conn: Connection, raw: WSMessage) {
    const msg = JSON.parse(raw as string);

    if (msg.type === "user.message") {
      // 存 event
      this.appendEvent(msg);

      // 构建 context，交给 harness
      const ctx: HarnessContext = {
        agent: await this.loadAgentConfig(),
        userMessage: msg,
        runtime: {
          history: new SqliteHistory(this.ctx.storage.sql),
          sandbox: new ContainerSandbox(this.env, this.state.sessionId),
          vault: new KvVault(this.env.CREDENTIAL_KV, this.state.sessionId),
          mcp: new McpBridge(this.env),
          broadcast: (event) => this.broadcast(JSON.stringify(event)),
        },
      };

      // 运行 harness，流式推送
      for await (const event of this.harness.run(ctx)) {
        this.appendEvent(event);
      }
    }
  }

  // SSE 兼容：HTTP GET → 升级 WebSocket → 桥接 SSE
  async onRequest(request: Request): Promise<Response> {
    if (request.headers.get("Accept") === "text/event-stream") {
      return this.bridgeToSSE(request);
    }
    return super.onRequest(request);
  }

  private appendEvent(event: SessionEvent) {
    this.ctx.storage.sql.exec(
      `INSERT INTO events (type, data) VALUES (?, ?)`,
      event.type, JSON.stringify(event)
    );
  }

  private resolveHarness(type?: string): HarnessInterface {
    // 未来支持从 npm 包加载社区 harness
    switch (type) {
      case "coding":   return new CodingHarness();
      case "research": return new ResearchHarness();
      default:         return new DefaultHarness();
    }
  }
}
```

### Sandbox 封装

```typescript
// packages/runtime/sandbox/container.ts
import { getContainer } from "@cloudflare/containers";

export class ContainerSandbox implements SandboxExecutor {
  private container;

  constructor(env: Env, sessionId: string) {
    this.container = getContainer(env.SANDBOX_CONTAINER, sessionId);
  }

  async exec(command: string): Promise<string> {
    const res = await this.container.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ command }),
    }));
    const { exitCode, stdout, stderr } = await res.json();
    return `exit=${exitCode}\n${stdout}${stderr ? "\nstderr: " + stderr : ""}`;
  }

  async readFile(path: string): Promise<string> {
    const res = await this.container.fetch(`http://sandbox/read?path=${encodeURIComponent(path)}`);
    return res.text();
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.container.fetch(new Request("http://sandbox/write", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }));
    return "ok";
  }

  async glob(pattern: string): Promise<string[]> {
    const res = await this.container.fetch(`http://sandbox/glob?pattern=${encodeURIComponent(pattern)}`);
    return res.json();
  }

  async grep(pattern: string, path: string): Promise<string> {
    const res = await this.container.fetch(new Request("http://sandbox/grep", {
      method: "POST",
      body: JSON.stringify({ pattern, path }),
    }));
    return res.text();
  }
}
```

### Credential Injection（Outbound Worker）

```typescript
// packages/runtime/sandbox/outbound.ts
export default {
  async outbound(request: Request, env: Env): Promise<Response> {
    const sessionId = request.headers.get("x-session-id");
    const url = new URL(request.url);

    // MCP servers → 注入 OAuth token
    const token = await env.CREDENTIAL_KV.get(
      `cred:${sessionId}:${url.hostname}`
    );
    if (token) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(new Request(request, { headers }));
    }

    // Git → 注入到 URL
    if (url.hostname === "github.com" || url.hostname === "gitlab.com") {
      const gitToken = await env.CREDENTIAL_KV.get(`git:${sessionId}`);
      if (gitToken) {
        url.username = "x-access-token";
        url.password = gitToken;
        return fetch(new Request(url.toString(), request));
      }
    }

    return fetch(request);
  },
};
```

## Config API（薄壳层）

兼容 Anthropic 的接口格式，映射到底层原语：

```typescript
// packages/api/routes/sessions.ts

// POST /v1/sessions/:id/events — 发送用户消息
async function postEvents(req: Request, env: Env, sessionId: string) {
  const { events } = await req.json();
  const do_ = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

  for (const event of events) {
    // 转发到 DO（通过 RPC 或 fetch）
    await do_.fetch(new Request("http://internal/event", {
      method: "POST",
      body: JSON.stringify(event),
    }));
  }

  return new Response(null, { status: 202 });
}

// GET /v1/sessions/:id/events — SSE stream
async function streamEvents(req: Request, env: Env, sessionId: string) {
  const do_ = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

  // DO 内部升级 WebSocket，这里桥接为 SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const wsRes = await do_.fetch(
    new Request("http://internal/ws", { headers: { Upgrade: "websocket" } })
  );
  const ws = wsRes.webSocket!;
  ws.accept();
  ws.addEventListener("message", (e) => {
    writer.write(enc.encode(`data: ${e.data}\n\n`));
  });
  ws.addEventListener("close", () => writer.close());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
```

## 社区扩展点

### 自定义 Harness

```typescript
// harnesses/coding-agent/index.ts
import { generateText, tool } from "ai";
import type { HarnessInterface, HarnessContext } from "open-managed-agents/harness";

export class CodingHarness implements HarnessInterface {
  async *run(ctx: HarnessContext) {
    // 1. 自定义：先让模型制定计划
    const plan = await generateText({
      model: resolveModel(ctx.agent.model),
      system: "Create a step-by-step plan. Do not execute yet.",
      messages: [...await ctx.runtime.history.getMessages(), ctx.userMessage],
    });
    yield { type: "agent.message", content: [{ type: "text", text: plan.text }] };

    // 2. 逐步执行计划
    const steps = parsePlan(plan.text);
    for (const step of steps) {
      const result = await generateText({
        model: resolveModel(ctx.agent.model),
        system: `Execute this step: ${step}`,
        messages: await ctx.runtime.history.getMessages(),
        tools: this.buildTools(ctx.runtime),
        maxSteps: 10,
      });
      // ... stream results
    }

    yield { type: "session.status_idle" };
  }
}
```

### 自定义 Compaction

```typescript
// packages/harness/compaction/interface.ts
export interface CompactionStrategy {
  shouldCompact(messages: Message[], maxTokens: number): boolean;
  compact(messages: Message[], provider: any): Promise<Message[]>;
}

// harnesses/compaction/semantic-trim.ts — 社区贡献
export class SemanticTrimCompaction implements CompactionStrategy {
  shouldCompact(messages, maxTokens) {
    return estimateTokens(messages) > maxTokens * 0.85;
  }

  async compact(messages, provider) {
    // 按语义重要度打分，保留高分消息
    const scored = await scoreByRelevance(messages, provider);
    return scored.filter(m => m.score > 0.3);
  }
}
```

### 自定义 Tool Pack

```typescript
// tool-packs/github/index.ts
import { tool } from "ai";

export const githubTools = {
  create_pr: tool({
    description: "Create a pull request on GitHub",
    inputSchema: z.object({
      repo: z.string(),
      title: z.string(),
      body: z.string(),
      head: z.string(),
      base: z.string().default("main"),
    }),
    execute: async ({ repo, title, body, head, base }) => {
      // 用 runtime.vault 拿 GitHub token（自动注入，不经 sandbox）
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        body: JSON.stringify({ title, body, head, base }),
      });
      return res.json();
    },
  }),

  // list_issues, merge_pr, create_issue 等...
};
```

## 实现路线

### Phase 1 — 能跑（Week 1-2）

- [ ] Session DO + SQLite event log + WebSocket
- [ ] Default harness（ai-sdk generateText + maxSteps）
- [ ] Container sandbox（bash + file ops）
- [ ] Config API 三个 CRUD endpoint
- [ ] SSE bridge
- [ ] 能用 curl 走完 Anthropic quickstart 等价流程

### Phase 2 — 能用（Week 3-4）

- [ ] Credential injection（Outbound Worker）
- [ ] MCP bridge（agents-sdk → ai-sdk tool 转换）
- [ ] Compaction（默认 summarize 策略）
- [ ] Custom tools（用户定义 schema，SSE 回调执行）
- [ ] Dynamic Worker sandbox（轻量级 JS/TS 执行）
- [ ] 多 Environment 模板（Python/Node/Go Dockerfile）

### Phase 3 — 能扩展（Week 5-6）

- [ ] HarnessInterface 正式化，支持 npm 包加载
- [ ] 第一批社区 harness：coding-agent, research-agent
- [ ] Tool pack 注册机制
- [ ] Multi-agent（DO 间 RPC）
- [ ] Self-evaluation loop
- [ ] 文档 + 示例 + starter template

### Phase 4 — 生态（Week 7+）

- [ ] Harness marketplace / registry
- [ ] Tool pack registry
- [ ] 兼容 Anthropic SDK 的 drop-in client（让现有用户零改动迁移）
- [ ] Dashboard（session 监控、event 回放、cost tracking）
- [ ] Clash 集成（canvas 作为 agent 协作界面）

## 竞争定位

```
Anthropic Managed Agents    →  "我们帮你做 agent"（黑盒，锁 Claude）
Open Managed Agents         →  "我们给你做 agent 的地方"（开源，任意 LLM）

用户的升级路径：
JSON config 够用  →  用 Config API，跟 Anthropic 体验一样
需要定制 loop     →  fork DefaultHarness，换 ai-sdk 参数
需要深度控制      →  实现 HarnessInterface，写自己的 agent loop
需要极致性能      →  直接操作 runtime 原语（DO + Container）
```