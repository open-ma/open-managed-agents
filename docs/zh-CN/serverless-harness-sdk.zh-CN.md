# Serverless Harness SDK

> 用户写一个 `.ts` 文件 → 部署 → 自定义 harness 替换掉 DefaultHarness——零基础设施需要管。

## 问题

平台已经通过 `HarnessInterface` + `resolveHarness(name)` 支持可插拔 harness。但今天，自定义 harness 代码必须由我们在构建时编进 agent worker——**用户没有自助路径来部署自己的 harness 逻辑**。

目标：**让 harness 可以无服务化地热替换。**

## 设计空间：评估过的三种方案

### 方案 A：动态加载代码（已否决）

```
用户的 .ts → 编译 → 存进 KV / R2 → SessionDO 运行时 eval()
```

思路：把 harness 代码当数据。把编译后的 JS 存 KV，SessionDO 实例化 harness 时动态加载。

**为什么不行：**
- Cloudflare Workers 不支持从字符串 `dynamic import()`
- `eval()` / `new Function()` 在 Workers 默认禁用（需 `unsafe-eval` compat flag）
- 安全模型崩了——用户代码与 SessionDO 同一 isolate，能访问所有 binding（KV、R2、DO storage）
- 没有依赖解析——用户的 harness 没法 `import` `ai`、`@anthropic-ai/sdk` 之类，除非把所有依赖打到那段 eval 字符串里

### 方案 B：Harness 作为独立 Worker（已否决）

```
用户的 .ts → 构建成独立 Worker → SessionDO 通过 Service Binding 调它
```

思路：每个自定义 harness 都是一个独立 Cloudflare Worker。SessionDO 通过 HTTP 把 `HarnessContext` 发过去，harness worker 跑 loop，把事件回传。

**为什么不行：**
- `HarnessContext` 包含无法序列化的活对象：`runtime.sandbox`（容器函数引用）、`runtime.broadcast`（WebSocket 推送）、`runtime.history`（基于 SQLite 的 store）
- 必须搭一层 RPC：harness 调 `sandbox.exec()` → HTTP 回到 SessionDO → SessionDO 调容器 → 返回 harness worker
- 每次 tool 调用要多 2 跳网络（harness → SessionDO → container → SessionDO → harness）
- 延迟翻倍：50 步 loop、每步 2 个 tool = 200 次额外往返
- 复杂度爆炸，收益微薄

### 方案 C：编译期注入（采用）

```
用户的 .ts → 注入 agent worker 模板 → esbuild → wrangler deploy
```

思路：**复用已经存在的 environment 部署管线**。把用户的 harness `.ts` 在构建时 import 到 worker 入口，注册到 harness registry，作为 agent worker 的一部分部署。

**为什么这个方案胜出：**
- **架构零变化** —— `HarnessContext` 维持原样，`sandbox` / `broadcast` / `history` 这些引用都还是同 isolate 内的本地函数调用
- **复用已有管线** —— environment 部署本来就是「生成 wrangler 配置 → esbuild → wrangler deploy」
- **天然安全** —— 用户代码跑在 Workers 的 V8 sandbox 里，与任意 Worker 同隔离级别。无 `eval`、无动态 import、能访问的也只有 `HarnessContext` 给的东西
- **零开销** —— harness 与 SessionDO 共享 isolate，工具调用零网络跳
- **熟悉的心智模型** —— 「改代码 → 部署 → 生效」与任何 Cloudflare Worker / Vercel function / Deno Deploy 脚本完全一致

代价是：**改 harness 时要重新部署 worker。** 这是每个无服务平台都会要求的代价——用户已经接受了。

## 工作原理

### 构建期流程

```
┌──────────────────────────────────────────────────────────────┐
│  1. 用户写 my-harness.ts，实现 HarnessInterface              │
│  2. CLI：oma deploy --harness my-harness.ts --agent agent_x  │
│  3. 平台读 agent 配置 → 找到对应的 environment worker         │
│  4. 把用户 harness 注入到 worker 入口：                        │
│                                                              │
│     import UserHarness from "__USER_HARNESS__";  // esbuild  │
│     registerHarness("custom", () => new UserHarness());      │
│                                                              │
│  5. esbuild 把 worker + harness 打到一起                      │
│  6. wrangler deploy 更新 worker                              │
│  7. 更新 agent 配置：agent.harness = "custom"                 │
└──────────────────────────────────────────────────────────────┘
```

### 运行期流程（不变）

```
user.message 到达
       ↓
SessionDO.drainEventQueue()
       ↓
resolveHarness(agent.harness)  →  返回用户的 harness 实例
       ↓
harness.run(ctx)  ←  与今天完全一样的 HarnessContext
       ↓
用户的 loop 直接拿到完整能力：
  - ctx.runtime.history    （事件日志）
  - ctx.runtime.sandbox    （容器执行）
  - ctx.runtime.broadcast  （WebSocket 推送）
  - ctx.tools              （平台已构建的工具）
  - ctx.model              （已解析的语言模型）
  - ctx.systemPrompt       （基础 system prompt）
```

零新增基础设施、零 RPC、零序列化边界——harness 直接跑。

## SDK

### 包：`@open-managed-agents/sdk`

SDK 很薄——只 re-export 用户需要实现的接口，再给一些便捷 helper。**它不会包装或抽象掉 `HarnessContext`**——用户拿到的就是平台原语。

```typescript
// --- 核心：用户要实现的 ---
export { HarnessInterface, HarnessContext, HistoryStore, SandboxExecutor } from "./interface";

// --- 便捷：defineHarness() 把一个函数包成 HarnessInterface ---
export function defineHarness(config: {
  name: string;
  run: (ctx: HarnessContext) => Promise<void>;
}): { name: string; create: () => HarnessInterface };

// --- Re-export：harness 在 run() 里要用的工具 ---
export { generateText, streamText, stepCountIs } from "ai";

// --- 内置电池：可选的平台策略 ---
export { SummarizeCompaction } from "./compaction";
export { withRetry } from "./retry";
export { defaultStepHandler } from "./step-handler";
```

### 用户的 harness 文件

```typescript
// my-harness.ts
import {
  defineHarness,
  generateText,
  stepCountIs,
  SummarizeCompaction,
} from "@open-managed-agents/sdk";

export default defineHarness({
  name: "research-harness",

  async run(ctx) {
    // 1. 从平台事件日志里读历史
    let messages = ctx.runtime.history.getMessages();

    // 2. 我自己的压缩策略：保留 web_search 结果，其它压缩
    const compaction = new SummarizeCompaction({ keepToolNames: ["web_search"] });
    if (compaction.shouldCompact(messages)) {
      messages = await compaction.compact(messages, ctx.model);
    }

    // 3. 我自己的缓存策略：在最后 3 条消息打缓存断点
    for (let i = Math.max(0, messages.length - 3); i < messages.length; i++) {
      (messages[i] as any).providerMetadata = {
        anthropic: { cacheControl: { type: "ephemeral" } },
      };
    }

    // 4. 跑 loop —— tools / sandbox / broadcast 都是平台提供的
    const result = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt + "\n\nAlways cite sources with URLs.",
      messages,
      tools: ctx.tools,
      stopWhen: stepCountIs(50),
      onStepFinish: async ({ text, toolCalls, toolResults }) => {
        // 把事件广播给 WebSocket 客户端
        if (text) {
          ctx.runtime.broadcast({
            type: "agent.message",
            content: [{ type: "text", text }],
          });
        }
        // ... 处理 tool 事件
      },
    });

    // 5. 上报用量
    if (result.usage && ctx.runtime.reportUsage) {
      await ctx.runtime.reportUsage(result.usage.inputTokens, result.usage.outputTokens);
    }
  },
});
```

### 部署

```bash
# 一条命令，平台负责其它所有事
oma deploy --harness my-harness.ts --agent agent_abc123

# 幕后发生了什么：
# 1. 校验 my-harness.ts 导出了合法的 defineHarness() 结果
# 2. 拉 agent 配置 → 找到绑定的 environment worker
# 3. 把 harness 注入到 worker 构建里
# 4. esbuild + wrangler deploy
# 5. 更新 agent.harness = "research-harness"
```

## 与 Vercel / Cloudflare Agent SDK 的差异

行业对比有助于说明**我们没有在做什么**：

| SDK | 它给你什么 | 你自己要管什么 |
|---|---|---|
| Vercel AI SDK（`ToolLoopAgent`） | 推理 loop | 其它一切：状态、sandbox、部署、工具 |
| Cloudflare Agents SDK（`Agent` 类） | Durable Object + 状态 | 工具执行、sandbox、记忆、凭据 |
| **我们的 SDK**（`defineHarness`） | 没有额外的——你拿到的更少 | 没有——平台全管了 |

关键洞察：**我们的 SDK 是「减法」式，而非「加法」式。**

别的 SDK 给你一堆积木，告诉你「自己组合」。我们的 SDK 给你一个完整可跑的 agent 平台，告诉你「**只换大脑**」。用户的 `.ts` 文件是最薄的一层——纯策略，零基础设施：

- 不管状态（SessionDO 持有事件日志）
- 不预置 sandbox（平台管容器）
- 不注册工具（平台从 agent 配置里构建）
- 不处理 WebSocket（平台广播事件）
- 不写崩溃恢复逻辑（平台 catch 错误并从事件日志重建）
- 不管凭据（vault 是平台级的，永远不接触 harness）

Harness 就是一个**纯函数**：`(history, tools, model) → events`。其它都是平台的工作。

## 实施计划

### 第一阶段：SDK 包

新建 `packages/sdk/`，导出 harness 接口 + helper。**大部分内容是把 `apps/agent/src/harness/` 里已有的东西 re-export**——把它做成正经的公开 API。

### 第二阶段：构建管线

扩展 `scripts/deploy.sh`（或新建 `scripts/deploy-harness.sh`）：
1. 接受用户的 `.ts` 文件路径
2. 拷到 agent worker 源码树，配上 esbuild alias
3. 生成注册代码（`registerHarness(name, factory)`）
4. 跑已有的 esbuild + wrangler deploy 管线

### 第三阶段：CLI

新建 `packages/cli/`：
- `oma init` —— 用模板脚手架一个 harness `.ts`
- `oma dev` —— 本地开发：miniflare + mock sandbox
- `oma deploy --harness <file> --agent <id>` —— 一键部署
- `oma logs <session-id>` —— 通过 WebSocket 流式打印事件

### 第四阶段：本地开发体验

- `oma dev` 用 miniflare 起 SessionDO + InMemoryHistory + 本地 shell sandbox
- 热重载：监听用户的 `.ts`，改动就重新打包
- 本地 Console UI 通过 WebSocket 实时收事件

## 待解决的问题

1. **一个 worker 支持多 harness 吗？** 一个 worker 通过 registry 支持多个自定义 harness，还是一个 worker 一个 harness？「一对一」更简单，但 N 个 harness 就要 N 次部署。

2. **Harness 版本管理**：用户部署新版本 harness 时，已经在跑的 session 仍然用老代码（它们正在 DO 里走 loop），新 session 才用新代码。这能接受吗？还是需要 per-session 的版本固定？

3. **依赖管理**：用户 harness 可以 import `ai`、`@anthropic-ai/sdk` 等是因为这些已经被打进 worker。**如果用户想用自己的 npm 包呢？**构建期是否要 `npm install`？还是只能用平台提供的依赖？

4. **测试**：用户在部署前怎么本地测试 harness？`oma dev` 必须做得足够好，以至于用户极少部署坏 harness。这就要求我们提供 `HistoryStore`、`SandboxExecutor`、`broadcast` 的 mock 实现。

## 参考

- [架构：Meta-Harness 设计](./architecture.zh-CN.md) —— 本文所基于的三层架构
- [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) —— Anthropic 关于「大脑/双手解耦」的论述
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) —— 部署目标
- [esbuild](https://esbuild.github.io/) —— 编译期注入用的打包工具