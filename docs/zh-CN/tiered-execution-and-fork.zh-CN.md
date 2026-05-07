# 分层执行 与 基于 Fork 的历史

> 来自对比 OpenAI Agents SDK Sandboxes、Cloudflare Project Think、以及 OMA 当前架构的设计洞察。
>
> 日期：2026-04-16

---

## 1. 问题

OMA 目前在每个 session 的**第一次 tool 调用**时启动 Cloudflare Container ——即使是 `read`、`grep`、`glob` 这种不需要 Linux 环境的操作。这意味着：

- **每个 session 都付容器启动延迟**（秒级），哪怕只是琐碎的文件操作
- **空闲容器要花钱** —— 休眠的 DO 是 \$0，但休眠的容器不是
- **压缩是破坏性的** —— `SummarizeCompaction` 替换中间消息，**不可恢复**

OpenAI Agents SDK 与 Cloudflare Project Think 各自部分解决了这些问题。本文记录我们能采纳什么、怎么做。

---

## 2. 行业对比

### 2.1 Sandbox 架构

| | OMA（当前） | OpenAI Agents SDK | Project Think |
|---|---|---|---|
| 执行模型 | 所有工具 → Container | 所有工具 → Provider（9 选项） | 分层：Workspace → Dynamic Worker → Container |
| 最轻执行 | Container（始终） | 取决于 provider | DO 内 Workspace（零成本） |
| 是否需要容器？ | 是，任何工具都要 | 是 | 否 —— Tier 0–3 不需容器 |
| Provider 切换 | Environment 配置 | 换 Client 类 | 加层式 |

### 2.2 状态与压缩

| | OMA | OpenAI | Think |
|---|---|---|---|
| 历史结构 | 线性事件日志 | 线性 | **树**（parent_id，可 fork） |
| 压缩 | 破坏性（替换中间） | 黑盒不透明项 | **非破坏性**（摘要，保留原文） |
| 历史搜索 | 无 | 无 | FTS5 全文搜索 |
| 可恢复性 | 压缩后丢失 | 不透明，不可恢复 | 全历史始终可查 |

### 2.3 凭据隔离

| | OMA | OpenAI | Think |
|---|---|---|---|
| 模型 | 出站 Worker 代理 | 「保留为运行时配置」 | 基于 capability（零环境授权） |
| 强度 | 强 —— 凭据永不进沙箱 | 仅指引 | 强 —— 每资源显式授予 |

### 2.4 Harness 灵活性

| | OMA | OpenAI | Think |
|---|---|---|---|
| 可替换？ | **完全** —— 实现 `HarnessInterface` | 否 —— `Runner` 固定 | 部分 —— 覆盖生命周期 hook |

### 2.5 工具哲学

| | OMA & OpenAI | Think |
|---|---|---|
| 路径 | Tool-calling：模型发 `tool_use`，平台执行，返回 `tool_result` | **Code-first**：模型写一段程序，一次执行 |
| Token 效率 | N 次工具调用 = N 次往返 | 1 段程序 = 1 次往返（Think benchmark 中减少 99.9%） |
| 自我扩展 | 无 | agent 写自己的工具为 TypeScript → Dynamic Worker → 持久化 |

---

## 3. 提案：分层执行

### 3.1 核心思路

把单一的 `CloudflareSandbox` 换成一个 `TieredSandboxExecutor`，把操作路由到能完成的最便宜的层。复用 Think 的独立包（`@cloudflare/shell`、`@cloudflare/codemode`、`@cloudflare/worker-bundler`）作积木——它们**不依赖 Think 基类**。

### 3.2 执行阶梯

```
Tier 0 —— Workspace（@cloudflare/shell）
  DO 内的 SQLite + R2 虚拟文件系统
  处理：read、write、edit、grep、glob
  成本：零（DO 的一部分）
  启动：0ms

Tier 1 —— Dynamic Worker（@cloudflare/codemode）
  V8 isolate 中执行的 LLM 生成 JS
  处理：计算、JSON 处理、简单脚本
  成本：极小（isolate，毫秒级生命周期）
  启动：毫秒

Tier 2 —— Runtime npm（@cloudflare/worker-bundler）
  自动打包 npm 包到 Dynamic Worker
  处理：用库做结构化数据处理
  成本：与 Tier 1 同
  启动：秒（首次打包），之后缓存

Tier 4 —— Container（既有 CloudflareSandbox）
  完整 Linux，含 git/npm/python/cargo
  处理：其它一切
  成本：容器价
  启动：秒（懒，按需）
```

**设计原则：Tier 0 单独使用就要有用。每一层都是加法。**

### 3.3 Tier 0 —— Workspace 的实际能力

`@cloudflare/shell` 的 `Workspace` 类 + `StateBackend` 接口提供 **40+ 个方法**，远超简单文件读写。这意味着 OMA 现有的 `read`/`write`/`edit`/`grep`/`glob` 工具**全部可以脱离容器执行**：

| OMA 现有工具 | 现在怎么跑 | Workspace 替代 |
|---|---|---|
| `read` | `sandbox.readFile(path)` → 容器 | `workspace.readFile(path)` → DO SQLite+R2 |
| `write` | `sandbox.writeFile(path, content)` → 容器 | `workspace.writeFile(path, content)` → DO SQLite+R2 |
| `edit` | `sandbox.readFile` + `sandbox.writeFile` → 容器 | `backend.replaceInFile(path, old, new)` → DO 内 |
| `grep` | `sandbox.exec("grep -rn ...")` → 容器内 bash | `backend.searchFiles(pattern, query)` → DO 内纯 JS |
| `glob` | `sandbox.exec("bash -c 'shopt -s globstar ...'")` → 容器内 bash | `workspace.glob(pattern)` → DO 内 SQLite 查询 |

此外 Workspace 还提供 OMA 没有的能力：`diff`、`diffContent`、`walkTree`、`summarizeTree`、`planEdits`、`applyEdits`、`searchFiles`（grep+find 组合）、`replaceInFiles`（批量替换）、JSON 操作、归档操作等。

### 3.4 Tier 1 —— Codemode（代码执行层）

各 tier **不是层层包含**，而是**并列暴露给 LLM 的工具**，LLM 根据任务选择用哪个。跨层访问需要显式配置：

```
LLM 可用的工具（全部平级）：
  ├─ read、write、edit、grep、glob  ← Tier 0（直接操作 Workspace）
  ├─ execute                        ← Tier 1（V8 isolate 执行代码）
  ├─ browser_*                      ← Tier 3（浏览器自动化）
  └─ bash                           ← Tier 4（Container shell）

跨层访问（显式配置）：
  Tier 1（execute） ──stateTools()──→ Tier 0（Workspace 文件操作）
  Tier 4（container） ──双向同步──→ Tier 0（Workspace 存储）
  Tier 1 ──自定义 ToolProvider──→ Tier 4（可选，不是默认行为）
```

「Additive」的含义：每加一个 tier，agent 多一种能力，**不是**每个 tier 包含前一个。Workspace 是共享存储层，各 tier 通过它共享文件。

**对比 tool-calling（OMA 现在）vs codemode（Tier 1）：**

```
Tool-calling：N 个操作 = N 次模型往返
  LLM → grep → LLM → read → LLM → write → LLM

Codemode：N 个操作 = 1 次模型往返（代码通过 RPC 回调 Workspace）
  LLM → execute({ code: `
    const files = await state.glob("**/*.ts");
    for (const f of files) { ... }
    return results;
  ` }) → V8 isolate 执行，state.* 通过 RPC 回调 Workspace → LLM
```

#### 实际 API（从 npm 包源码验证）

```typescript
import { createCodeTool, DynamicWorkerExecutor } from "@cloudflare/codemode/ai";
import { stateTools } from "@cloudflare/shell/workers";

// 创建代码执行工具
const executeTool = createCodeTool({
  tools: [
    stateTools(workspace),           // → state.* 命名空间（readFile、glob、searchFiles…）
    { name: "api", tools: myTools }, // → api.* 命名空间
  ],
  executor: new DynamicWorkerExecutor({
    loader: env.LOADER,              // Cloudflare WorkerLoader binding
    timeout: 30000,
    globalOutbound: null,            // 默认零网络访问
  }),
});
```

内部流程：

1. `createCodeTool` 从所有 ToolProvider 中**自动生成 TypeScript 类型声明**
2. 类型声明注入到 tool description，LLM 看到的是：`Available: state.readFile(path: string): Promise<string>, state.glob(pattern: string): Promise<FileInfo[]>, ...`
3. LLM 写一个 `async () => { ... }` 箭头函数
4. `DynamicWorkerExecutor` 在 V8 isolate 中执行这段代码
5. 代码内部的 `state.readFile()` 等调用通过 `ToolDispatcher`（Workers RPC）回到宿主执行
6. 返回 `{ result, logs, error }` 给 LLM

#### OMA 的接入方式

`execute` 是 sandbox 阶梯的 Tier 1，作为 built-in tool 加到 `tools.ts` 中。它天然访问 Workspace（Tier 0），也可以通过自定义 ToolProvider 回调 Container（Tier 4）：

```typescript
// tools.ts —— 新增 execute 工具（Tier 1）
if (env.LOADER) {
  tools["execute"] = createCodeTool({
    tools: [
      stateTools(workspace),       // → state.*   （Tier 0：Workspace 文件操作）
      containerTools(sandbox),     // → sandbox.* （Tier 4：Container shell，懒启动）
    ],
    executor: new DynamicWorkerExecutor({
      loader: env.LOADER,
      globalOutbound: env.OUTBOUND_WORKER,  // 走 OMA 凭据代理
    }),
  });
}
```

LLM 写的代码可以在一次调用里跨层操作：

- `state.glob()`、`state.readFile()` → Tier 0（毫秒、零容器）
- `sandbox.exec("npm test")` → Tier 4（秒级，按需启动容器）
- `fetch("https://api.github.com/...")` → 走 outbound proxy（凭据注入）

### 3.5 实现 —— TieredSandboxExecutor

`SandboxExecutor` 接口仍然是核心抽象，但 Tier 0 用 Workspace 直接实现，**不走容器**：

```typescript
import { Workspace } from "@cloudflare/shell";
import { createWorkspaceStateBackend } from "@cloudflare/shell";

class TieredSandboxExecutor implements SandboxExecutor {
  private workspace: Workspace;
  private backend: StateBackend;
  private container?: CloudflareSandbox;   // 懒启动

  constructor(env: Env, sessionId: string) {
    // Workspace 用 DO 的 SQLite + R2
    this.workspace = new Workspace({
      sql: env.SQL,
      r2: env.WORKSPACE_FILES,
      name: sessionId,
    });
    this.backend = createWorkspaceStateBackend(this.workspace);
  }

  async readFile(path: string): Promise<string> {
    return (await this.workspace.readFile(path)) ?? "";  // Tier 0
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.workspace.writeFile(path, content);       // Tier 0
    return "ok";
  }

  async exec(command: string, timeout?: number): Promise<string> {
    // 需要完整 shell 环境的命令 → Container
    if (this.needsContainer(command)) {
      return this.getOrCreateContainer().exec(command, timeout);
    }
    // 文件操作可以用 StateBackend 执行
    // 但 bash 命令的语义太复杂，不建议在 Workspace 层模拟
    // 推荐：用 `execute` 工具（codemode）替代复杂 bash
    return this.getOrCreateContainer().exec(command, timeout);
  }

  private needsContainer(command: string): boolean {
    // 所有 bash 命令默认走容器（简单方案）
    // 未来可以识别 grep/find/cat 等命令降级到 Workspace
    return true;
  }
}
```

**关键洞察：** **不要试图在 Workspace 层模拟 bash 命令的语义**（之前的设计过于激进）。正确的做法是：

- `read`/`write`/`edit`/`grep`/`glob` 这 5 个工具直接用 Workspace API 实现（不走 `exec()`）
- `bash` 工具继续走容器
- 新增 `execute` 工具用 codemode，处理复杂的多步操作

### 3.6 命令路由（简化版）

不再尝试路由 bash 命令，而是让不同工具走不同后端：

```
read/write/edit/grep/glob → Workspace（Tier 0，零容器）
execute                   → Dynamic Worker（Tier 1，V8 isolate）
bash                      → Container（Tier 4，懒启动）
web_fetch                 → Container（现有）或 DO 内 fetch（可优化）
web_search                → DO 内 fetch（已经不走容器）
```

### 3.7 Workspace ↔ Container 同步

R2 是两层共享的存储后端：

```
Workspace（DO）                      Container
  SQLite（文件树索引）                 /home/user/workspace
  R2（blob 存储）         ←────→     R2 mount（同一个桶）
```

- **Tier 0 → Tier 4 升级**：Container 挂同一个 R2 桶。Workspace 写过的文件已经在那里。
- **Tier 4 → Tier 0 降级**：容器销毁时，rsync 工作目录回 R2。Workspace SQLite 索引更新。
- **容器活着期间**：Workspace 变成只读代理避免冲突。容器拥有文件系统。

### 3.8 哪些会变、哪些不变

| 组件 | 会变？ | 备注 |
|---|---|---|
| `tools.ts` | **不** | 工具只调 `SandboxExecutor` 方法 |
| `default-loop.ts` | **不** | harness 调工具，不知道分层 |
| Harness 接口 | **不** | 与执行层解耦 |
| 事件日志 | **不** | 正交关切 |
| 凭据系统 | **小改** | 出站代理仍处理容器；Workspace 不需要它 |
| `session-do.ts` | **变** | `getOrCreateSandbox()` 返回 `TieredSandboxExecutor` 而非 `CloudflareSandbox` |
| `sandbox.ts` | **变** | 新增 `TieredSandboxExecutor` 实现 |
| `package.json` | **变** | 新增 `@cloudflare/shell`、`@cloudflare/codemode`、`@cloudflare/worker-bundler` |

### 3.9 预期影响

- **约 80% session 永不启动容器**（大部分 agent 工作是 read/write/grep）
- **亚秒级工具响应**用于文件操作（vs 等容器的秒级）
- **Workspace-only session 零空闲成本**
- **真正需要容器的 session 无回退** —— 行为相同，只是延后启动

---

## 4. 提案：基于 Fork 的事件日志

### 4.1 核心思路

给事件日志加分支。**Fork 是零拷贝指针**——不复制任何事件。

### 4.2 Schema 改动

```sql
-- 加一列
ALTER TABLE events ADD COLUMN branch TEXT DEFAULT 'main';

-- 加一张表
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  parent_branch TEXT NOT NULL DEFAULT 'main',
  fork_from_seq INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 4.3 操作

**Fork：**

```typescript
function fork(fromSeq: number, branchName: string) {
  db.exec(
    `INSERT INTO branches (id, parent_branch, fork_from_seq) VALUES (?, 'main', ?)`,
    branchName, fromSeq
  );
}
```

**读分支历史：**

```sql
SELECT * FROM events
WHERE (branch = :parent AND seq <= :fork_from_seq)
   OR (branch = :branch)
ORDER BY seq
```

**切换激活分支：**

```typescript
this.activeBranch = branchName;  // 只是切个指针
```

### 4.4 非破坏性压缩

当前 `SummarizeCompaction` 替换中间消息——它们消失了。有了 fork：

```
分支 "main"（不动）：
  seq 1:  user.message
  seq 2:  agent.message
  seq 3:  agent.tool_use        ─┐
  seq 4:  agent.tool_result      │ 20 条要压缩
  ...                             │
  seq 22: agent.message         ─┘
  seq 23: user.message
  seq 24: agent.message

分支 "main@compacted-1"（fork_from_seq=2）：
  seq 25: agent.message   → "[摘要 seq 3-22]：..."
  seq 26: user.message    → 复制 seq 23
  seq 27: agent.message   → 复制 seq 24

激活分支切换到 "main@compacted-1"
```

- **原始历史保留在 "main"** —— 始终可恢复
- **压缩分支用于推理** —— 上下文窗口更小
- **FTS5 搜索所有分支** —— 检索时不丢任何东西

### 4.5 `history.ts` 的变化

```typescript
// 现在
getMessages(): ModelMessage[] {
  const rows = this.db.exec("SELECT * FROM events ORDER BY seq");
  return eventsToMessages(rows);
}

// 新
getMessages(branch?: string): ModelMessage[] {
  const b = branch || this.activeBranch;
  const fork = this.getBranchFork(b);

  const rows = fork
    ? this.db.exec(`
        SELECT * FROM events
        WHERE (branch = ? AND seq <= ?) OR (branch = ?)
        ORDER BY seq
      `, fork.parentBranch, fork.forkFromSeq, b)
    : this.db.exec(`
        SELECT * FROM events WHERE branch = ? ORDER BY seq
      `, b);

  return eventsToMessages(rows);  // eventsToMessages 不变
}
```

### 4.6 解锁的能力

| 能力 | 怎么实现 |
|---|---|
| **非破坏性压缩** | Fork + 摘要事件，原文保留 |
| **A/B 探索** | 从同 seq fork，跑不同策略 |
| **回滚** | 把 `activeBranch` 切回父 |
| **全历史搜索** | `events` 表的 FTS5 索引覆盖所有分支 |
| **Thread 统一** | 现有 `session_thread_id` 可迁移到分支（未来） |
| **审计** | 每次压缩/fork 都通过 `branches` 表可追溯 |

### 4.7 改动范围

- `events` 表：+1 列
- 新 `branches` 表
- `history.ts`：`getMessages()` 加约 10 行查询逻辑
- `compaction.ts`：`compact()` 创建 fork 而非替换消息
- `eventsToMessages()`：**不变** —— 它只是把事件列表转成消息，不关心来源
- `tools.ts`、`default-loop.ts`、harness：**不变**

---

## 5. 采纳策略

### Track A：历史与压缩

**Phase A1：基于 fork 的历史**（低成本，高价值）

- 加 `branch` 列 + `branches` 表
- 更新 `getMessages()` 支持分支
- 用 fork 重写 `SummarizeCompaction` 替代「替换中间」
- 既有行为不变（默认分支 = "main"）

### Track B：分层执行

**Phase B1：Workspace 层**（中成本，高价值）

- 加 `@cloudflare/shell` 依赖
- 给 `readFile`/`writeFile`/`grep`/`glob` 实现 `WorkspaceSandbox`
- 文件类工具走 Workspace
- 容器变懒 —— 只有 `bash` 命中 `CONTAINER_PATTERNS` 时才启动

**Phase B2：代码执行层**（中成本，中价值）

- 加 `@cloudflare/codemode` + `@cloudflare/worker-bundler`
- 把简单计算路由到 Dynamic Worker
- agent 不需容器就能跑 JS

**Phase B3：完整 TieredSandboxExecutor**（集成）

- 把所有 tier 合到统一 executor
- 通过共享 R2 加 Workspace ↔ Container 同步
- 监控：发出 tier 选择决策事件

### Track C：子 Agent 架构

**Phase C1：并行委托**（低成本，高价值）

- 验证 `Promise.all` 在并发的 `runSubAgent()` 上能用
- 通过 `call_agents_parallel` 工具暴露，或依赖 AI SDK 多工具调用

**Phase C2：持久 thread**（中成本，高价值）

- `thread_events` SQLite 表替代 InMemoryHistory
- DO 唤醒时从 SQLite 恢复 `this.threads`
- 新增 `continue_thread` 工具用于跨 turn 复用

**Phase C3：结构化返回**（低成本，中价值）

- 用 `SubAgentResult` 替代纯文本（artifacts、status、thread_id）
- 父能基于结构化输出推理

**Phase C4：Facets 集成**（高成本，高价值，等条件成熟）

- 子 agent 变成 colocated Durable Object
- 每个子 agent 独立 SQLite + sandbox
- Typed RPC 替代字符串 tool call

### Track D：平台工具

**Phase D1：FTS5 历史搜索**（低成本，高价值）

- 给 events 加 FTS5 虚拟表
- 新增 `search_history` built-in 工具
- 与 fork-based 历史立即配合（所有分支可搜）

**Phase D2：Execute 工具（codemode）**（中成本，高价值）

- 加 `@cloudflare/codemode` 依赖
- 通过 `createCodeTool()` 新增 `execute` built-in 工具
- 把 workspace 接入为 `state.*` ToolProvider
- 需要 wrangler.jsonc 中的 `worker_loaders` binding

### Track E：环境快照模式

**Phase E1：Snapshot 缓存**（中成本，高价值）

- 新增 `build: "snapshot"` 模式
- Session warmup 时安装包 + `createBackup()` + 存 KV
- 后续 session `restoreBackup()` 秒级恢复
- 现有 pre-build 模式不变

### 并行性

Track A、B、C、D、E 互相独立，可并行推进。每个 track 内部 phase 顺序执行。

---

## 6. 提案：子 Agent 架构升级

### 6.1 当前状态

OMA 有三层多 agent 设计：

| 层级 | 状态 | 机制 | 通信 |
|---|---|---|---|
| **Hierarchical delegation** | 已实现 | `call_agent_*` → `runSubAgent()` → 同 session 内线程 | 同步 await，返回文本 |
| **Peer team messaging** | 已设计（agent-im-design.md） | TeamDO → HTTP push → SessionDO | 异步、tool-based |
| **Dynamic agent pool** | 未设计 | 按 capability 路由，自动实例化 | 动态 |

**现有线程模型的问题：**

1. **InMemoryHistory** —— 子 agent 历史在内存，线程结束即丢失，crash 不可恢复
2. **同步阻塞** —— 父 agent 必须 `await` 子 agent 完成，不能并发委派
3. **共享 sandbox** —— 子 agent 共享父 sandbox 所有文件，无隔离
4. **无持久化** —— 子 agent 状态不跨 turn 存活，不能被后续 turn 复用
5. **字符串通信** —— `delegateToAgent()` 返回纯文本，丢失结构化信息

### 6.2 三方对比

| | OMA（当前） | OpenAI Agents SDK | Project Think |
|---|---|---|---|
| **子 agent 创建** | `call_agent_*` tool | `agent.as_tool()` / Handoff | `this.subAgent(Class, name)` |
| **隔离** | 共享 sandbox + InMemoryHistory | 独立 sandbox config | **独立 SQLite + 独立执行上下文**（Facets） |
| **通信** | 同步 await，返回文本 | 同步 tool result / handoff | **Typed RPC**（编译时类型安全） |
| **并发** | 串行（一次一个 await） | 串行 | **`Promise.all()`** 原生并行 |
| **持久化** | 线程结束即销毁 | 取决于 provider | **跨 hibernation 存活** |
| **延迟** | 函数调用级（同进程） | 取决于 runner | **函数调用级**（Facets 同机房） |
| **peer 通信** | 计划中（TeamDO） | 无 | 无（仅 parent → child） |

### 6.3 Think Facets 的核心洞察

Think 的 Facets 解决了一个精确的问题：**子 agent 需要隔离但不需要分布式**。

```typescript
// Think 的写法
const researcher = await this.subAgent(ResearchAgent, "research");
const reviewer = await this.subAgent(ReviewAgent, "review");

// 并行执行，各自独立 SQLite + 工具 + 模型
const [research, review] = await Promise.all([
  researcher.search(task),
  reviewer.analyze(task)
]);

return this.synthesize(research, review);
```

关键特性：

- **Facets = 同机房的 Durable Object**，不是远程调用
- 每个子 agent 有**独立 SQLite**（不是 InMemoryHistory）
- **Typed RPC** —— TypeScript 编译时就能检查通信接口
- **存活 hibernation** —— 父 agent 醒来，子 agent 状态还在
- 父 agent **看不到子 agent 内部**（真正的封装）

### 6.4 OMA 应该有两种模式

OMA 计划的 TeamDO 与 Think 的 Facets **不是互斥的**，它们解决不同问题：

```
┌──────────────────────────────────────────────────────────┐
│  紧耦合（Facets 模式）                                    │
│  ─────────────────────                                    │
│  同一个 SessionDO 内，子 agent 作为 colocated DO           │
│  用于：分解当前任务、并行处理、结果合成                       │
│  特点：同步/并行、独立存储、typed RPC、低延迟               │
│  例：研究 agent + 评审 agent + 编码 agent 并行工作          │
│                                                           │
│  OMA 映射：升级现有 threads → Facets-style sub-agents      │
├──────────────────────────────────────────────────────────┤
│  松耦合（TeamDO 模式）                                    │
│  ─────────────────────                                    │
│  独立的 SessionDO，通过 TeamDO 协调                        │
│  用于：持续协作、异步任务、跨 session 通信                   │
│  特点：异步消息、共享任务列表、capability 路由               │
│  例：前端团队 + 后端团队 + QA 团队长期协作                   │
│                                                           │
│  OMA 映射：保持 agent-im-design.md 中的 TeamDO 设计        │
└──────────────────────────────────────────────────────────┘
```

### 6.5 紧耦合模式：升级现有 Threads

**目标：** 用 Facets 思路重构 `runSubAgent()`，解决 5 个现有问题。

#### 6.5.1 替换 InMemoryHistory → 独立 SQLite

```typescript
// 现在：线程结束即丢失
const subHistory = new InMemoryHistory();

// 改后：每个子 agent 有独立持久化存储
// 利用 Cloudflare Durable Object 的 Facets
const subAgent = await this.facet(SubAgentDO, threadId);
// subAgent 有自己的 SQLite，跨 hibernation 存活
```

如果不直接用 Facets（OMA 可能还没升级到支持 Facets 的 Workers runtime），可以用**同一个 DO 的 SQLite 分表**模拟：

```sql
-- 主 agent 事件
CREATE TABLE events (...);

-- 子 agent 事件（thread_id 做前缀）
CREATE TABLE thread_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_thread ON thread_events(thread_id, seq);
```

这样子 agent 历史**持久化在 SQLite 中**，crash 可恢复，跨 turn 可复用。

#### 6.5.2 支持并行委托

```typescript
// 现在：串行，一次只能 await 一个子 agent
const result1 = await this.delegateToAgent(agentA, msg1);  // 阻塞
const result2 = await this.delegateToAgent(agentB, msg2);  // 等 A 完成才开始

// 改后：并行（Think 的 Promise.all 模式）
const [result1, result2] = await Promise.all([
  this.delegateToAgent(agentA, msg1),
  this.delegateToAgent(agentB, msg2),
]);
```

**现有架构已经支持这个** —— `runSubAgent()` 是 async 函数，`Promise.all()` 直接可用。只需要在 `call_agent_*` 工具层面暴露并行能力。

方案 A —— 新增 `call_agents_parallel` 工具：

```typescript
tools["call_agents_parallel"] = tool({
  description: "Delegate tasks to multiple sub-agents in parallel",
  inputSchema: z.object({
    delegations: z.array(z.object({
      agent_id: z.string(),
      message: z.string(),
    })),
  }),
  execute: safe(async ({ delegations }) => {
    const results = await Promise.all(
      delegations.map(d => env.delegateToAgent(d.agent_id, d.message))
    );
    return delegations.map((d, i) => ({
      agent_id: d.agent_id,
      result: results[i],
    }));
  }),
});
```

方案 B —— 让 LLM 在一个 turn 内发多个 `call_agent_*`，AI SDK 的 `maxSteps` 循环天然并行处理同 step 的多个 tool call。**可能不需要新工具。**

#### 6.5.3 子 agent Sandbox 隔离（可选）

Think 的子 agent 有完全独立的存储。OMA 可以选择：

| 级别 | 隔离程度 | 实现 |
|---|---|---|
| **Level 0（现状）** | 共享 sandbox，共享所有文件 | 不变 |
| **Level 1** | 共享 sandbox，子 agent 有自己的工作目录 | `chdir` 到 `/workspace/threads/{threadId}/` |
| **Level 2** | 独立 Workspace（Tier 0 隔离） | 子 agent 用独立的 `@cloudflare/shell` 实例 |
| **Level 3（Think 级别）** | 完全独立 DO | Facets，独立 SQLite + 独立 sandbox |

**推荐 Level 1** 作为起点 —— 改动最小，已经提供了基本的文件隔离。

#### 6.5.4 结构化返回（替代纯文本）

```typescript
// 现在：返回拼接的文本
return responseText || "(sub-agent produced no text output)";

// 改后：返回结构化结果
interface SubAgentResult {
  text: string;
  artifacts?: Array<{ path: string; type: string }>;  // 产出的文件
  status: "completed" | "needs_input" | "error";
  thread_id: string;  // 可用于后续交互
}
```

这让父 agent 可以：

- 知道子 agent 创建/修改了哪些文件
- 判断子 agent 是否完成
- 通过 `thread_id` 继续与子 agent 对话（跨 turn 复用）

#### 6.5.5 跨 Turn 复用子 agent

```typescript
// Turn 1：创建子 agent，执行任务
const result = await delegateToAgent("coder", "implement feature X");
// thread_id = "thread_abc123" 存在 thread_events 表中

// Turn 2：用户说「让 coder 加个测试」
// 父 agent 识别出之前的 thread，继续对话
const result2 = await continueThread("thread_abc123", "add tests for feature X");
// 子 agent 的历史还在（SQLite），上下文完整
```

需要：

- `thread_events` 表持久化子 agent 历史
- 新增 `continue_thread` 工具（或在 `call_agent_*` 中支持 `thread_id` 参数）
- `this.threads` map 从内存改为从 SQLite 恢复

### 6.6 松耦合模式：TeamDO 增强

`agent-im-design.md` 中的 TeamDO 设计保持不变，但可以借鉴 Think 的几个点：

| Think 特性 | TeamDO 增强 |
|---|---|
| **独立 conversation tree** | 每个 team member 的 session 已经有独立 event log，符合 |
| **独立 model** | AgentConfig 已支持 per-agent model，符合 |
| **并行 spawn** | TeamDO 可以 `Promise.all` 创建多个 session，已经支持 |
| **RPC 流式回调** | TeamDO 可以在 `send_message` 响应中支持 streaming（考虑加入） |

**TeamDO 独有的优势（Think 没有的）：**

- 异步消息（子 agent 不阻塞父 agent）
- 共享任务列表（协调基础设施）
- Capability-based routing（动态分配）
- 跨机器分布（不要求同机房）

### 6.7 两种模式的选择标准

```
需要子 agent 的结果才能继续？ ──→ 紧耦合（Facets-style threads）
  - 研究 → 合成
  - 编码 → 测试 → 修复
  - 分析 → 报告

子 agent 可以独立工作？ ──→ 松耦合（TeamDO）
  - 前端 + 后端并行开发
  - 多 PR 同时处理
  - 长期运行的监控 agent
```

### 6.8 实现路线

**Phase 1：并行委托（最低成本）**

- AI SDK 的 `generateText` 已支持同 step 多 tool call 并行
- 验证 `Promise.all` 在 `runSubAgent` 上是否开箱即用
- 不行的话加 `call_agents_parallel` 工具

**Phase 2：子 agent 持久化**

- `thread_events` 表替代 InMemoryHistory
- `this.threads` 从 SQLite 恢复（跨 hibernation）
- 新增 `continue_thread` 工具

**Phase 3：结构化返回**

- `SubAgentResult` 接口替代纯文本
- 返回 artifacts、status、thread_id
- 父 agent 可以基于结构化结果做决策

**Phase 4：Facets 集成（当 Cloudflare 稳定后）**

- 子 agent 升级为 colocated DO
- 独立 SQLite + 独立 sandbox
- Typed RPC 替代字符串 tool call

---

## 7. 我们不采纳的

| Think 特性 | 决定 | 理由 |
|---|---|---|
| Think 基类 | **跳过** | OMA 的可插拔 `HarnessInterface` 比 Think 的 hook 覆盖更灵活 |
| Fibers（持久执行） | **延后** | OMA 的事件溯源恢复目前够用 |
| Facets（子 agent RPC） | **渐进采纳** | Phase 1-3 用 SQLite 分表模拟隔离 + 并行；Phase 4 等 Cloudflare Facets 稳定后迁移到 colocated DO（见 §6） |
| Context Blocks | **harness 职责** | 带 token 预算的持久化 system prompt 段，OMA 的 harness 可自行实现（见 §8） |
| Codemode（Tier 1） | **采纳** | 执行阶梯的一部分，作为 `execute` built-in 工具，天然访问 Workspace（Tier 0）+ Container（Tier 4）（见 §3.4） |
| 自我扩展 agent | **评估** | Think 的 `ExtensionManager` 让 agent 写 TypeScript 扩展持久化为 Dynamic Worker。安全模型成熟（权限声明 + workspace 访问控制），但需评估是否适合 OMA 的多租户场景 |

---

## 8. Context Blocks —— Harness 层记忆

Think 的 Context Blocks 是 system prompt 中的**结构化持久段**，带 token 预算：

```typescript
configureSession(session: Session) {
  return session
    .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
    .withContext("plan", { description: "Current plan", maxTokens: 1000 })
    .withCachedPrompt();
}
// System prompt 中显示：MEMORY (42%, 462/1100 tokens)
```

Agent 通过工具主动读写这些 block，空间满了自动淘汰旧内容。

**这是 harness 的职责**，不是平台的。OMA 中：

- 平台提供 `history.getMessages()` 和 system prompt 的拼接点
- Harness 在 `run()` 中决定 system prompt 怎么组装
- Context blocks = harness 在 system prompt 中管理的命名段落 + token 计数

与 OMA 现有 Memory Store（向量语义搜索）互补：

- Memory Store = 外部知识检索（跨 session）
- Context Blocks = 当前 session 内的持久化工作记忆

Harness 开发者可以在自定义 harness 中自行实现这个模式。

---

## 9. FTS5 历史搜索 —— 平台内置 Tool

Think 的 `search_context` 工具让 agent 搜索自己的全部历史（包括压缩前的原始消息）。

OMA 可以在 `tools.ts` 中新增一个内置工具：

```typescript
// 新增 search_history 工具
tools["search_history"] = tool({
  description: "Search conversation history for relevant context",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
  }),
  execute: safe(async ({ query }) => {
    // 对 events 表启用 FTS5
    // SELECT * FROM events_fts WHERE events_fts MATCH ?
    return history.search(query);
  }),
});
```

需要在 `session-do.ts` 初始化时创建 FTS5 虚拟表：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
USING fts5(content, content=events, content_rowid=seq);
```

配合 fork-based 历史（§4），所有分支的原始内容都可搜索 —— 即使当前分支已经压缩过。

---

## 10. Environment 双模式：Pre-build + Snapshot Cache

### 10.1 现状

OMA 用 GitHub Actions 预构建 Docker 镜像：

```
POST /v1/environments → status: "building" → CI 构建镜像 → build-complete → status: "ready"
POST /v1/sessions → 用预构建镜像启动（秒级）
```

Anthropic 没有 build 流程，推测是运行时安装 + 某种缓存。

### 10.2 发现：Cloudflare Sandbox 原生支持 Backup/Restore

Sandbox SDK 提供 Backups API —— 基于 squashfs + FUSE overlayfs + R2：

```typescript
// 快照：压缩目录 → 上传 R2
const backup = await sandbox.createBackup({ dir: "/", ttl: 604800 });

// 恢复：从 R2 下载 → FUSE overlay 挂载（copy-on-write）
await sandbox.restoreBackup(backup);
```

恢复后的文件系统是 Copy-on-Write：

- Lower layer（read-only）：snapshot 中的内容（已装好的包）
- Upper layer（writable）：新写入的文件
- 跨 session 共享同一个 snapshot，各 session 的 upper layer 独立

### 10.3 方案：保留两种模式

不砍掉 build 流程，而是**两种模式并存**，用户按需选择：

#### Mode A：Pre-build（现有方式）

```
POST /v1/environments
  { "config": { "type": "cloud", "build": "prebuild", "packages": {...} } }

→ 触发 CI → 构建自定义镜像 → status: "ready"
→ 每个 session 直接用镜像启动（最快）
```

**适用场景：**

- 大量系统包（apt）、复杂编译依赖
- 需要自定义 Dockerfile
- 高频使用的 environment（启动速度优先）
- 企业场景（镜像审计、安全扫描）

#### Mode B：Snapshot Cache（新增）

```
POST /v1/environments
  { "config": { "type": "cloud", "build": "snapshot", "packages": {...} } }

→ 直接存 config → status: "ready"（瞬间）

首次 session：
  → base container → 安装 packages → createBackup("/") → 存 KV
  → 标记 env snapshot ready

后续 session：
  → base container → restoreBackup() → 秒级就位
```

**适用场景：**

- 快速迭代（改个包不想等 CI build）
- 轻量依赖（几个 pip/npm 包）
- 开发/测试环境
- 一次性 / 临时 environment

#### 实现

```typescript
// session-do.ts —— sandbox 初始化时
async function warmupSandbox(sandbox: SandboxExecutor, envConfig: EnvironmentConfig) {
  const mode = envConfig.config.build || "prebuild";

  if (mode === "prebuild") {
    // 现有逻辑不变 —— 用预构建镜像
    return;
  }

  if (mode === "snapshot") {
    // 检查是否有缓存的 snapshot
    const snapshotKey = `env-snapshot:${envConfig.id}:${envConfig.version}`;
    const cached = await env.KV.get(snapshotKey);

    if (cached) {
      // 热启动：从 snapshot 恢复
      await sandbox.restoreBackup(JSON.parse(cached));
      return;
    }

    // 冷启动：安装包 + 创建 snapshot
    await installPackages(sandbox, envConfig.config.packages);
    const backup = await sandbox.createBackup({
      dir: "/",
      ttl: 604800,  // 7 天
      name: `env-${envConfig.id}-v${envConfig.version}`,
    });
    await env.KV.put(snapshotKey, JSON.stringify(backup), { expirationTtl: 604800 });
  }
}

async function installPackages(sandbox: SandboxExecutor, packages: PackageConfig) {
  // 按 Anthropic 的顺序：apt → cargo → gem → go → npm → pip
  if (packages?.apt?.length)   await sandbox.exec(`apt-get update && apt-get install -y ${packages.apt.join(" ")}`);
  if (packages?.cargo?.length) await sandbox.exec(`cargo install ${packages.cargo.join(" ")}`);
  if (packages?.gem?.length)   await sandbox.exec(`gem install ${packages.gem.join(" ")}`);
  if (packages?.go?.length)    await sandbox.exec(`go install ${packages.go.join(" ")}`);
  if (packages?.npm?.length)   await sandbox.exec(`npm install -g ${packages.npm.join(" ")}`);
  if (packages?.pip?.length)   await sandbox.exec(`pip install ${packages.pip.join(" ")}`);
}
```

#### Snapshot 生命周期

```
env config 变更 → version++ → snapshot key 变化 → 下次 session 自动重建 snapshot
snapshot TTL 过期 → 下次 session 重新安装 + 创建新 snapshot
手动清除 → DELETE /v1/environments/{id}/snapshot
```

### 10.4 vs Anthropic

| | Anthropic | OMA（Pre-build） | OMA（Snapshot） |
|---|---|---|---|
| Environment 创建 | 瞬间 | 分钟级（CI build） | 瞬间 |
| 首次 session | 慢（安装包） | 快（预构建镜像） | 慢（安装包 + snapshot） |
| 后续 session | 快（推测 snapshot） | 快（预构建镜像） | 快（restore snapshot） |
| 自定义 Dockerfile | 不支持 | **支持** | 不支持 |
| 改包后生效 | 下次 session | 重新 build（分钟） | 下次 session（自动） |
| 基础设施 | VM snapshot（推测） | CI pipeline | R2 + Sandbox Backups |

**两种模式并存 = Anthropic 的便利 + OMA 独有的 pre-build 能力。**

### 10.5 限制

- FUSE 挂载在 sandbox sleep/restart 后丢失，需要重新 `restoreBackup()`（每次 session warmup 都要调一次）
- Snapshot 默认 TTL 3 天，需要配置刷新策略
- 根目录 snapshot 可能几百 MB（apt 包大），R2 存储有成本
- `useGitignore: true` 可以排除不必要的文件减少体积

---

## 11. 参考

- [OpenAI Agents SDK —— Sandboxes](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [OpenAI —— Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)
- [Cloudflare —— Project Think](https://blog.cloudflare.com/project-think/)
- [OMA —— 架构](./architecture.zh-CN.md)
- [OMA —— 差距分析](./gap-analysis.zh-CN.md)
- [OMA —— Serverless Harness SDK](./serverless-harness-sdk.zh-CN.md)