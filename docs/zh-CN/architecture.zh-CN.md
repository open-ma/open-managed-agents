# 架构：Meta-Harness 设计

> 「我们对接口的形状有强烈主张，但对接口背后跑的是什么并不挑剔。」
> —— [Scaling Managed Agents：让大脑与双手解耦](https://www.anthropic.com/engineering/managed-agents)

## 什么是 Meta-Harness

Managed Agents 自身是一个 **meta-harness**——它**不是**某种具体的 agent 实现，而是一个为「任何 agent」定义稳定接口的平台。它对 *Claude 应该用哪种 harness* 不持立场，但对 *每个 harness 都需要哪些原语* 立场鲜明：

1. **Session** —— 一份 append-only 的事件日志，是持久化状态的载体
2. **Sandbox** —— 工具执行的计算环境
3. **Vault** —— 安全的凭据存储，**永远不会暴露给 sandbox**

Harness 是可插拔的。**平台提供能力，harness 提供策略。**

## 三层结构

```
┌─────────────────────────────────────────────────────────┐
│  Harness（可插拔的 agent loop）                          │
│  - 读事件、组上下文、调用 Claude                          │
│  - 决定 HOW：怎么用 tools / skills / 缓存 / 压缩         │
│  - 无状态：crash → wake(sessionId) → resume              │
├─────────────────────────────────────────────────────────┤
│  Meta-Harness / Platform（SessionDO）                    │
│  - 定义接口：session、sandbox、vault                     │
│  - 准备 WHAT 可用：tools、skills、history                │
│  - 管理生命周期：sandbox 预热、事件持久化                 │
├─────────────────────────────────────────────────────────┤
│  基础设施（Cloudflare 原语）                              │
│  - Durable Objects + SQLite（session 存储）              │
│  - Containers（sandbox 执行）                             │
│  - KV + R2（配置、文件、凭据）                            │
└─────────────────────────────────────────────────────────┘
```

## 平台与 Harness 的职责划分

分界线是：**平台准备「有什么可用」，harness 决定「怎么把它们交给模型」。**

### 平台（SessionDO）准备：

| 职责 | 接口 |
|---|---|
| 根据 agent 配置注册工具 | `buildTools(agent, sandbox) → tools` |
| 把 skill 文件挂到 sandbox | `sandbox.writeFile('/home/user/.skills/...')` |
| 根据 store ID 构建 memory 工具 | `buildMemoryTools(storeIds, kv) → tools` |
| 管理 sandbox 生命周期 | `getOrCreateSandbox()`、`warmUpSandbox()` |
| 持久化事件 | `history.append(event)` |
| 广播给 WebSocket 客户端 | `broadcastEvent(event)` |
| 跟踪 session 状态 | `idle → running → idle` |
| 处理 harness 崩溃恢复 | catch error → `session.error` → 回到 idle |

### Harness（agent loop）决定：

| 职责 | 为什么这是 harness 关心的事 |
|---|---|
| System prompt 怎么拼 | 不同 harness 需要不同人格 |
| 缓存策略 | 在哪打 `cache_control: ephemeral` 断点 |
| 压缩策略 | 何时压缩，保留什么（摘要 vs. 滑动窗口） |
| 上下文工程 | 事件 → message 的转换、排序、过滤 |
| 重试策略 | 重试几次、什么算瞬时错误、退避曲线 |
| 工具投递 | 一次性给完 vs. 渐进披露 |
| Step 处理 | 每步广播什么（thinking / tool_use / message） |
| 停机条件 | agent 何时算「干完」（max steps、`user.message_required` 等） |

## 关键接口

### Session 接口

```typescript
interface HistoryStore {
  getMessages(): CoreMessage[];                    // Events → AI SDK message 格式
  append(event: SessionEvent): void;               // 持久化写入 SQLite
  getEvents(afterSeq?: number): SessionEvent[];    // 按位置切片
}
```

事件日志带来：
- **崩溃恢复**：`wake(sessionId)` → `getEvents()` → 重建上下文 → 继续
- **Replay**：新加入的 WebSocket 客户端能拿到完整历史
- **灵活性**：harness 可以在交给 Claude 之前回退、跳过、或转换事件

### Sandbox 接口

```typescript
interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
}
```

每个工具——包括 MCP server——都收敛成 `execute(name, input) → string`。harness 永远不知道沙箱底下到底是 Cloudflare Container、本地进程还是 mock，它只调接口。

### HarnessContext（平台交给 harness 的东西）

```typescript
interface HarnessContext {
  agent: AgentConfig;              // 模型、system prompt、工具配置
  userMessage: UserMessageEvent;   // 触发本次的用户消息
  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    CONFIG_KV?: KVNamespace;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
  };
  runtime: {
    history: HistoryStore;         // 读写事件日志
    sandbox: SandboxExecutor;      // 跑命令、读写文件
    broadcast: (event: SessionEvent) => void;  // 推给 WebSocket 客户端
    reportUsage?: (input: number, output: number) => Promise<void>;
    abortSignal?: AbortSignal;     // 用户中断
  };
}
```

## 大脑是无状态的

Harness 自己不持有任何状态。它需要的一切都来自：
1. **事件日志**（对话历史）
2. **agent 配置**（模型、工具、system prompt）
3. **sandbox**（文件系统、运行中的进程）

当 harness 崩溃时：
1. SessionDO 捕获错误
2. 发出 `session.error` 事件
3. 把状态重新设为 `idle`
4. 下一条 `user.message` 会创建一个全新的 harness 实例
5. 新 harness 读取事件日志、重建上下文、继续干活

什么都不会丢——因为事件在被广播出去之前已经持久化写到 SQLite。

## 双手是「牲口」

容器是可替换的。坏掉的容器用 `provision({resources})` 一行就能换一个新的——同样的包、同样挂载的文件、干净的状态。

关键设计抉择：

- **懒预置**：容器在第一次 tool 调用时才创建，而不是 session 启动时就拉起来。**根本不需要执行代码的会话完全跳过容器开销。**
- **并行启动**：推理直接从事件日志开始；容器预置在后台进行。等 Claude 第一次想调工具时，容器通常已经就绪。
- **凭据不进 sandbox**：Git token 在 init 时写进本地 remote 配置；OAuth token 留在 vault 里，通过 MCP 代理使用。**harness 全程见不到凭据。**

## 对自定义 Harness 的意义

因为基础设施都被平台接管了，自定义 harness 非常简单：

```typescript
class ResearchHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    // 平台已经准备好：tools、skills、sandbox、history
    // 我只决定怎么用它们

    const messages = ctx.runtime.history.getMessages();
    // 我自己的上下文工程：保留所有 web_search 结果，
    // 但激进地压缩 tool_result 段

    const result = await generateText({
      model: resolveModel(ctx.agent.model, ctx.env.ANTHROPIC_API_KEY),
      messages: myCustomTransform(messages),
      tools: ctx.tools,  // 平台已经构建好了
      maxSteps: 50,      // 研究类任务需要更多步数
    });
  }
}
```

- 编程类 harness 可能采用「先 plan 再 execute」+ 激进缓存
- 数据分析类 harness 可能用流式 + 自定义压缩，保留 DataFrame
- 研究类 harness 可能用 web search + 引用追踪

它们从平台拿到的 tools、skills、sandbox、history 都一样，**只在策略上有差异。**

## 当前实现备注

当前的 `DefaultHarness` 把一些本应属于平台的事（工具构建、skill 挂载）混进了 harness 里。这一点已记为技术债：harness 本身工作正确，但**自定义 harness 的作者目前需要重复这套 setup 代码**。后续重构会把 tool / skill 准备移到 `HarnessContext` 构造里，让 harness 收到的是一个完全准备好的上下文。

## 参考

- [Scaling Managed Agents：让大脑与双手解耦](https://www.anthropic.com/engineering/managed-agents) —— Anthropic 工程博客
- [Claude Managed Agents 概览](https://platform.claude.com/docs/en/managed-agents/overview) —— API 文档
- [Agent Skills 概览](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) —— Skills 架构