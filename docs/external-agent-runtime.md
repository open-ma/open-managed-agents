# External Agent Runtime Integration

Status: **PENDING**
Created: 2026-04-13

## Context

open-managed-agents 当前只有一种 runtime 模式：平台通过 DefaultHarness 驱动 Anthropic API，工具在 Cloudflare Container 沙箱中执行。目标是将流行的 local coding agent（Claude Code、Codex、OpenCode、OpenClaw、Hermes）接入平台，让它们作为可选的 agent runtime 运行，同时复用平台的 session lifecycle、event streaming、memory、multi-agent、outcome evaluation 等能力。

参考实现：
- **multica** — 已验证 5 种 agent 的统一 `Backend.Execute()` 抽象
- **mini-caption** — 已验证 Claude Code stream-json 的事件桥接
- **slock.ai** — daemon 连接模式参考

核心设计原则：
- **Loop + Sandbox 共处**：agent CLI 和执行环境在同一个容器/机器上，不拆分
- **MCP 是统一注入通道**：平台能力（memory、skills、vault）通过 MCP server 注入，所有主流 agent 都支持 MCP
- **Vault 走代理**：credential 不暴露给 agent 进程，通过 proxy 注入到 MCP 连接和 Model API
- **CLI 认证不支持**：`gh`、`gcloud` 等依赖 env var 的 CLI 认证超出 scope

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │   /v1/sessions API (不变)     │
                        └──────────┬───────────────────┘
                                   │
                        ┌──────────▼───────────────────┐
                        │       SessionDO               │
                        │  event queue / broadcast      │
                        │  session lifecycle            │
                        └──────────┬───────────────────┘
                                   │
                    ┌──────────────┼──────────────────┐
                    │              │                   │
            ┌───────▼──────┐ ┌────▼─────────┐ ┌──────▼────────┐
            │ DefaultHarness│ │ ContainerAgent│ │  DaemonAgent  │
            │ (现有, 不变)   │ │ Harness      │ │  Harness      │
            │ 平台驱动loop  │ │ 容器内agent  │ │  本地daemon   │
            │ 平台执行tool  │ │ CLI自治      │ │  CLI自治      │
            └──────────────┘ └──────────────┘ └───────────────┘
```

两种 runtime 模式：
- **Cloud Container**：platform 管理容器生命周期，agent CLI 预装在镜像中，在容器内自治运行
- **Local Daemon**：本地 daemon 进程连接 platform（参考 slock `npx @slock-ai/daemon` 和 multica `multica daemon start`），接收 session dispatch，本地跑 agent CLI

对 `/v1/sessions` API 消费者完全透明 — 不管 backend 是 DefaultHarness、Claude Code 还是 Codex，事件流格式一致。

---

## Phase 1: Agent Protocol Adapter Layer

定义外部 agent 的统一事件协议，参考 multica 的 `server/pkg/agent/agent.go`。

### 1.1 统一事件类型

```typescript
// 外部 agent 的统一事件格式 (参考 multica Message/Result)
export type AgentMessageType =
  | "text" | "thinking" | "tool_use" | "tool_result"
  | "status" | "error" | "log";

export interface ExternalAgentMessage {
  type: AgentMessageType;
  content?: string;
  tool?: string;
  callId?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: string;
  level?: string;
}

export interface ExternalAgentResult {
  status: "completed" | "failed" | "aborted" | "timeout";
  output: string;
  error?: string;
  sessionId?: string;  // for resume
  usage?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
}
```

### 1.2 Agent Protocol Adapters

每种 agent 一个 adapter，负责启动 CLI process、解析私有输出格式到统一类型、收集结果。

| Agent | CLI 调用 | 协议 |
|-------|---------|------|
| **Claude Code** | `claude -p --output-format stream-json --input-format stream-json` | stdin/stdout NDJSON |
| **Codex** | `codex app-server --listen stdio://` | JSON-RPC 2.0 |
| **OpenCode** | `opencode run --format json` | NDJSON |
| **OpenClaw** | `openclaw agent --local --json` | stderr JSON |
| **Hermes** | `hermes acp` | ACP JSON-RPC 2.0 |

统一 adapter 接口：

```typescript
export interface AgentAdapter {
  spawn(opts: AgentSpawnOptions): AgentProcess;
}

export interface AgentProcess {
  send(message: string): Promise<void>;
  events: AsyncIterable<ExternalAgentMessage>;
  result: Promise<ExternalAgentResult>;
  kill(): Promise<void>;
}

export interface AgentSpawnOptions {
  cwd: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  envVars?: Record<string, string>;
  resumeSessionId?: string;
  maxTurns?: number;
  timeout?: number;
}
```

### 1.3 Event Translator

将 `ExternalAgentMessage` 转为 `SessionEvent`：

| ExternalAgentMessage.type | SessionEvent |
|---------------------------|--------------|
| `text` | `AgentMessageEvent` |
| `thinking` | `AgentThinkingEvent` |
| `tool_use` | `AgentToolUseEvent` |
| `tool_result` | `AgentToolResultEvent` |
| `status` | `SessionRunningEvent` / `SessionStatusEvent` |
| `error` | `SessionErrorEvent` |

---

## Phase 2: ExternalAgentHarness

实现 `HarnessInterface`，但不使用 `ctx.tools` 和 `ctx.model` — agent CLI 自带 loop + tool execution。

```typescript
export class ExternalAgentHarness implements HarnessInterface {
  constructor(private adapterName: string) {}

  async run(ctx: HarnessContext): Promise<void> {
    const adapter = resolveAdapter(this.adapterName);

    // 1. 生成 MCP config（注入平台能力）
    const mcpConfig = await buildMcpConfig(ctx);

    // 2. 启动 agent process
    const proc = adapter.spawn({
      cwd: sandbox.cwd,
      prompt: extractPrompt(ctx.userMessage),
      systemPrompt: ctx.systemPrompt,
      mcpConfigPath: mcpConfig.path,
      envVars: { /* proxy URLs, not raw credentials */ },
      resumeSessionId: ctx.runtime.history.getSessionId?.(),
    });

    // 3. 收集事件流，转换并广播
    for await (const msg of proc.events) {
      const event = translateToSessionEvent(msg);
      ctx.runtime.broadcast(event);
    }

    // 4. 收集结果，报告 usage
    const result = await proc.result;
    if (result.usage) {
      for (const [model, u] of Object.entries(result.usage)) {
        await ctx.runtime.reportUsage?.(u.input, u.output);
      }
    }
  }
}
```

注册到 harness registry：

```typescript
registerHarness("claude-code", () => new ExternalAgentHarness("claude-code"));
registerHarness("codex", () => new ExternalAgentHarness("codex"));
registerHarness("opencode", () => new ExternalAgentHarness("opencode"));
registerHarness("openclaw", () => new ExternalAgentHarness("openclaw"));
registerHarness("hermes", () => new ExternalAgentHarness("hermes"));
```

用户创建 agent 时指定 `"harness": "claude-code"`，平台自动使用对应 runtime。

---

## Phase 3: Platform MCP Sidecar

一个 stdio MCP server，暴露平台能力给外部 agent。所有主流 agent 都支持 MCP，这是统一的注入通道。

### 暴露的 Tools

| Tool | 功能 |
|------|------|
| `memory_list(store_id)` | 列出 memories |
| `memory_search(store_id, query)` | 搜索 memories |
| `memory_read(store_id, memory_id)` | 读取 memory |
| `memory_write(store_id, path, content)` | 写入 memory |
| `memory_delete(store_id, memory_id)` | 删除 memory |
| `skill_list()` | 列出可用 skills |
| `skill_get(skill_id)` | 获取 skill 内容 |

### 注入方式

在 `ExternalAgentHarness.run()` 中：

1. 启动 platform MCP server 进程（stdio 模式）
2. 生成 MCP config JSON，包含：
   - platform MCP server（memory、skills）
   - 用户配置的 MCP servers（通过 proxy，见 Phase 4）
3. 将 config 写入临时文件
4. agent CLI 启动时带 `--mcp-config <path>` 或等价参数

---

## Phase 4: Vault Credential Proxy

Agent 进程不直接持有任何 credential。所有需要认证的出站请求走 proxy。

### MCP Server Auth Proxy

用户在 agent config 中配置的 MCP servers（如 GitHub MCP、Jira MCP），agent 实际连接的是 proxy：

```
Agent → localhost:PORT/mcp/{server-name} → Proxy 注入 auth header → 真实 MCP Server
```

Proxy 从 vault 读取对应 credential，注入到请求中。Agent 的 MCP config 里只有 proxy 地址。

### Model API Proxy

Agent CLI 的模型 API 调用也走 proxy：

```
Agent → ANTHROPIC_BASE_URL=localhost:PORT/model-api → Proxy 注入 API key → api.anthropic.com
```

通过设置 `*_BASE_URL` env var 将模型 API 请求导向 proxy。

### Proxy 实现

运行在容器/daemon 的 sidecar 进程（或 ExternalAgentHarness 内的 HTTP server），生命周期与 session 绑定。

### 超出 Scope

CLI 工具认证（`gh`、`gcloud`、`aws`）依赖 env var 或 config file，无法走 proxy。不支持。

---

## Phase 5: Runtime Modes

### 5.1 Cloud Container Mode

Agent CLI 预装在容器镜像中。扩展 `EnvironmentConfig`：

```typescript
export interface EnvironmentConfig {
  config: {
    type: "cloud";
    runtime?: "default" | "claude-code" | "codex" | "opencode" | "openclaw" | "hermes";
    // runtime 决定使用哪个容器镜像和 harness
    // ...existing fields...
  };
}
```

当 `runtime` 不是 `"default"` 时，使用对应容器镜像 + ExternalAgentHarness。

### 5.2 Local Daemon Mode

参考 slock (`npx @slock-ai/daemon --server-url ... --api-key ...`) 和 multica daemon。

**Daemon 协议**：

```typescript
// Daemon → Platform
interface DaemonRegister {
  type: "register";
  daemon_id: string;
  device_name: string;
  runtimes: Array<{ name: string; type: string; version: string }>;
}

interface DaemonEventReport {
  type: "event";
  session_id: string;
  event: SessionEvent;
}

interface DaemonResultReport {
  type: "result";
  session_id: string;
  result: ExternalAgentResult;
}

// Platform → Daemon
interface DaemonDispatchSession {
  type: "dispatch";
  session_id: string;
  agent: AgentConfig;
  user_message: string;
  mcp_config: object;
  env_vars: Record<string, string>;  // proxy URLs, not raw credentials
}

interface DaemonInterrupt {
  type: "interrupt";
  session_id: string;
}
```

**API Endpoints**：

```
POST /v1/daemons/register       — daemon 注册，上报可用 runtimes
POST /v1/daemons/heartbeat      — 心跳
WS   /v1/daemons/connect        — WebSocket 长连接，双向通信
```

**Daemon 端**（未来作为 `npx @open-managed-agents/daemon`）：
- 注册到 platform，上报本地可用的 agent CLIs
- 通过 WebSocket 接收 session dispatch
- 本地启动 agent CLI（使用 AgentAdapter）
- 实时上报事件流到 platform
- Vault credential proxy 跑在 daemon 进程中

### 5.3 SessionDO 路由逻辑

```typescript
async processUserMessage(event: UserMessageEvent) {
  const env = this.resolveEnvironment();

  if (env.config.runtime === "default" || !env.config.runtime) {
    // 现有逻辑：DefaultHarness + sandbox tools
    const harness = resolveHarness("default");
    await harness.run(this.buildContext(event));
  } else if (env.type === "cloud") {
    // Cloud Container 模式：容器内跑 external agent
    const harness = resolveHarness(env.config.runtime);
    await harness.run(this.buildExternalContext(event));
  } else if (env.type === "local") {
    // Local Daemon 模式：dispatch 到 daemon
    await this.dispatchToDaemon(event);
  }
}
```

---

## Phase 6: Agent Config Extensions

```typescript
export interface AgentConfig {
  // ...existing fields...
  harness?: string;  // 已存在，用于选择 runtime

  // 新增：external agent 特有配置
  external_agent?: {
    model?: string;           // 覆盖 agent CLI 使用的模型
    max_turns?: number;       // 最大轮次
    timeout?: number;         // 超时秒数
    permission_mode?: string; // 权限模式（如 bypassPermissions）
  };
}
```

---

## Implementation Order

| Phase | 内容 | 依赖 |
|-------|------|------|
| **P1** | Agent Protocol Adapter（先做 claude-code） | 无 |
| **P2** | ExternalAgentHarness + harness 注册 | P1 |
| **P3** | Platform MCP Sidecar（memory + skills） | P2 |
| **P4** | Vault Credential Proxy | P3 |
| **P5a** | Cloud Container Mode（EnvironmentConfig 扩展） | P2 |
| **P5b** | Local Daemon Mode（daemon protocol + routes） | P2, P4 |
| **P6** | AgentConfig extensions + API 文档 | P5 |

建议先做 P1 + P2，只接入 Claude Code 一种 agent 验证架构，再扩展其他 agent 和 daemon 模式。

---

## Key Files

### 修改

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | 新增 ExternalAgentMessage/Result、扩展 EnvironmentConfig、AgentConfig |
| `apps/agent/src/harness/interface.ts` | 微调 HarnessContext（新增 optional fields for external mode） |
| `apps/agent/src/harness/registry.ts` | 注册新 harness |
| `apps/agent/src/harness/index.ts` | 导出新 harness 注册 |
| `apps/agent/src/runtime/session-do.ts` | 路由逻辑：default vs external vs daemon |

### 新增

| 文件 | 内容 |
|------|------|
| `apps/agent/src/harness/adapters/` | 5 个 agent protocol adapters |
| `apps/agent/src/harness/adapters/event-translator.ts` | ExternalAgentMessage → SessionEvent |
| `apps/agent/src/harness/external-agent-harness.ts` | ExternalAgentHarness |
| `apps/agent/src/harness/platform-mcp-server.ts` | Platform MCP Sidecar |
| `apps/agent/src/harness/credential-proxy.ts` | Vault Credential Proxy |
| `apps/main/src/routes/daemons.ts` | Daemon API endpoints |
| `packages/shared/src/daemon-protocol.ts` | Daemon 通信协议 |
