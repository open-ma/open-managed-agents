# Tiered Execution & Fork-Based History

> Design insights from comparing OpenAI Agents SDK Sandboxes, Cloudflare Project Think, and OMA's current architecture.
>
> Date: 2026-04-16

---

## 1. Problem

OMA currently starts a Cloudflare Container on the **first tool call** of every session — even for `read`, `grep`, or `glob` operations that don't need a Linux environment. This means:

- **Every session pays container startup latency** (seconds) even for trivial file operations
- **Idle containers cost money** — a hibernated DO costs $0, a sleeping container does not
- **Compaction is destructive** — `SummarizeCompaction` replaces middle messages, making them unrecoverable

Both OpenAI Agents SDK and Cloudflare Project Think have solved parts of this differently. This doc captures what we can adopt and how.

---

## 2. Landscape Comparison

### 2.1 Sandbox Architecture

| | OMA (current) | OpenAI Agents SDK | Project Think |
|---|---|---|---|
| Execution model | All tools → Container | All tools → Provider (9 options) | Tiered: Workspace → Dynamic Worker → Container |
| Lightest execution | Container (always) | Depends on provider | Workspace in DO (zero cost) |
| Container required? | Yes, for any tool | Yes, for any tool | No — Tier 0-3 work without container |
| Provider switching | Environment config | Swap Client class | Additive tiers |

### 2.2 State & Compaction

| | OMA | OpenAI | Think |
|---|---|---|---|
| History structure | Linear event log | Linear | **Tree** (parent_id, forkable) |
| Compaction | Destructive (replace middle) | Black-box opaque item | **Non-destructive** (summarize, keep originals) |
| History search | None | None | FTS5 full-text search |
| Recoverability | Lost after compaction | Opaque, not recoverable | Full history always queryable |

### 2.3 Credential Isolation

| | OMA | OpenAI | Think |
|---|---|---|---|
| Model | Outbound Worker proxy | "Keep as runtime config" | Capability-based (zero ambient authority) |
| Strength | Strong — creds never enter sandbox | Guidance only | Strong — explicit grants per resource |

### 2.4 Harness Flexibility

| | OMA | OpenAI | Think |
|---|---|---|---|
| Replaceable? | **Fully** — implement `HarnessInterface` | No — `Runner` is fixed | Partially — override lifecycle hooks |

### 2.5 Tool Philosophy

| | OMA & OpenAI | Think |
|---|---|---|
| Approach | Tool-calling: model emits `tool_use`, platform executes, returns `tool_result` | **Code-first**: model writes a program, executes in one shot |
| Token efficiency | N tool calls = N round trips | 1 program = 1 round trip (99.9% reduction in Think's benchmark) |
| Self-extension | No | Agent writes its own tools as TypeScript → Dynamic Worker → persisted |

---

## 3. Proposal: Tiered Execution

### 3.1 Core Idea

Replace the single `CloudflareSandbox` with a `TieredSandboxExecutor` that routes operations to the cheapest capable tier. Use Think's standalone packages (`@cloudflare/shell`, `@cloudflare/codemode`, `@cloudflare/worker-bundler`) as building blocks — they're independently usable without the Think base class.

### 3.2 Execution Ladder

```
Tier 0 — Workspace (@cloudflare/shell)
  SQLite + R2 virtual filesystem inside the DO
  Handles: read, write, edit, grep, glob
  Cost: zero (part of the DO)
  Startup: 0ms

Tier 1 — Dynamic Worker (@cloudflare/codemode)
  LLM-generated JS in a V8 isolate
  Handles: computation, JSON processing, simple scripts
  Cost: minimal (isolate, millisecond lifecycle)
  Startup: milliseconds

Tier 2 — Runtime npm (@cloudflare/worker-bundler)
  npm packages auto-bundled into Dynamic Worker
  Handles: structured data processing with libraries
  Cost: same as Tier 1
  Startup: seconds (first bundle), cached after

Tier 4 — Container (existing CloudflareSandbox)
  Full Linux with git/npm/python/cargo
  Handles: everything else
  Cost: container pricing
  Startup: seconds (lazy, on first need)
```

**Design principle: Tier 0 alone must be useful. Each tier is additive.**

### 3.3 Tier 0 — Workspace 的实际能力

`@cloudflare/shell` 的 `Workspace` 类 + `StateBackend` 接口提供 **40+ 个方法**，远超简单文件读写。这意味着 OMA 现有的 `read`/`write`/`edit`/`grep`/`glob` 工具 **全部可以脱离容器执行**：

| OMA 现有工具 | 现在怎么跑 | Workspace 替代 |
|---|---|---|
| `read` | `sandbox.readFile(path)` → 容器 | `workspace.readFile(path)` → DO SQLite+R2 |
| `write` | `sandbox.writeFile(path, content)` → 容器 | `workspace.writeFile(path, content)` → DO SQLite+R2 |
| `edit` | `sandbox.readFile` + `sandbox.writeFile` → 容器 | `backend.replaceInFile(path, old, new)` → DO 内 |
| `grep` | `sandbox.exec("grep -rn ...")` → 容器内 bash | `backend.searchFiles(pattern, query)` → DO 内纯 JS |
| `glob` | `sandbox.exec("bash -c 'shopt -s globstar ...'")` → 容器内 bash | `workspace.glob(pattern)` → DO 内 SQLite 查询 |

此外 Workspace 还提供 OMA 没有的能力：`diff`, `diffContent`, `walkTree`, `summarizeTree`, `planEdits`, `applyEdits`, `searchFiles` (grep+find 组合), `replaceInFiles` (批量替换), JSON 操作, 归档操作等。

### 3.4 Tier 1 — Codemode (代码执行层)

各 tier 不是层层包含，而是**并列暴露给 LLM 的工具**，LLM 根据任务选择用哪个。跨层访问需要显式配置：

```
LLM 可用的工具 (全部平级):
  ├─ read, write, edit, grep, glob  ← Tier 0 (直接操作 Workspace)
  ├─ execute                        ← Tier 1 (V8 isolate 执行代码)
  ├─ browser_*                      ← Tier 3 (浏览器自动化)
  └─ bash                           ← Tier 4 (Container shell)

跨层访问 (显式配置):
  Tier 1 (execute) ──stateTools()──→ Tier 0 (Workspace 文件操作)
  Tier 4 (container) ──bidirectional sync──→ Tier 0 (Workspace 存储)
  Tier 1 ──自定义 ToolProvider──→ Tier 4 (可选，不是默认行为)
```

"Additive" 的含义：每加一个 tier，agent 多一种能力，不是每个 tier 包含前一个。Workspace 是共享存储层，各 tier 通过它共享文件。

**对比 tool-calling (OMA 现在) vs codemode (Tier 1):**

```
Tool-calling: N 个操作 = N 次模型往返
  LLM → grep → LLM → read → LLM → write → LLM

Codemode: N 个操作 = 1 次模型往返 (代码通过 RPC 回调 Workspace)
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
    stateTools(workspace),           // → state.* 命名空间 (readFile, glob, searchFiles...)
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

`execute` 是 sandbox 阶梯的 Tier 1，作为 built-in tool 加到 `tools.ts` 中。它天然访问 Workspace (Tier 0)，也可以通过自定义 ToolProvider 回调 Container (Tier 4)：

```typescript
// tools.ts — 新增 execute 工具 (Tier 1)
if (env.LOADER) {
  tools["execute"] = createCodeTool({
    tools: [
      stateTools(workspace),       // → state.*   (Tier 0: Workspace 文件操作)
      containerTools(sandbox),     // → sandbox.* (Tier 4: Container shell, 懒启动)
    ],
    executor: new DynamicWorkerExecutor({
      loader: env.LOADER,
      globalOutbound: env.OUTBOUND_WORKER,  // 走 OMA 凭据代理
    }),
  });
}
```

LLM 写的代码可以在一次调用里跨层操作：
- `state.glob()`, `state.readFile()` → Tier 0 (毫秒, 零容器)
- `sandbox.exec("npm test")` → Tier 4 (秒级, 按需启动容器)
- `fetch("https://api.github.com/...")` → 走 outbound proxy (凭据注入)

### 3.5 Implementation — TieredSandboxExecutor

`SandboxExecutor` 接口仍然是核心抽象，但 Tier 0 用 Workspace 直接实现，不走容器：

```typescript
import { Workspace } from "@cloudflare/shell";
import { createWorkspaceStateBackend } from "@cloudflare/shell";

class TieredSandboxExecutor implements SandboxExecutor {
  private workspace: Workspace;
  private backend: StateBackend;
  private container?: CloudflareSandbox;   // lazy-started

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
    // 推荐：用 `execute` 工具 (codemode) 替代复杂 bash
    return this.getOrCreateContainer().exec(command, timeout);
  }

  private needsContainer(command: string): boolean {
    // 所有 bash 命令默认走容器（简单方案）
    // 未来可以识别 grep/find/cat 等命令降级到 Workspace
    return true;
  }
}
```

**关键洞察：** 不要试图在 Workspace 层模拟 bash 命令的语义（之前的设计过于激进）。正确的做法是：
- `read`/`write`/`edit`/`grep`/`glob` 这 5 个工具直接用 Workspace API 实现（不走 `exec()`）
- `bash` 工具继续走容器
- 新增 `execute` 工具用 codemode，处理复杂的多步操作

### 3.6 Command Routing (简化版)

不再尝试路由 bash 命令，而是让不同工具走不同后端：

```
read/write/edit/grep/glob → Workspace (Tier 0, 零容器)
execute                   → Dynamic Worker (Tier 1, V8 isolate)
bash                      → Container (Tier 4, 懒启动)
web_fetch                 → Container (现有) 或 DO 内 fetch (可优化)
web_search                → DO 内 fetch (已经不走容器)
```

### 3.5 Workspace ↔ Container Sync

R2 is the shared storage backend for both tiers:

```
Workspace (DO)                     Container
  SQLite (file tree index)         /home/user/workspace
  R2 (blob storage)       ←────→  R2 mount (same bucket)
```

- **Tier 0 → Tier 4 upgrade**: Container mounts the same R2 bucket. Files written by Workspace are already there.
- **Tier 4 → Tier 0 downgrade**: On container destroy, rsync working directory back to R2. Workspace SQLite index updated.
- **During container lifetime**: Workspace becomes read-only proxy to avoid conflicts. Container owns the filesystem.

### 3.6 What Changes vs. What Doesn't

| Component | Changes? | Notes |
|---|---|---|
| `tools.ts` | **No** | Tools only call `SandboxExecutor` methods |
| `default-loop.ts` | **No** | Harness calls tools, doesn't know about tiers |
| Harness interface | **No** | Decoupled from execution layer |
| Event log | **No** | Orthogonal concern |
| Credential system | **Minor** | Outbound proxy still handles container; Workspace doesn't need it |
| `session-do.ts` | **Yes** | `getOrCreateSandbox()` returns `TieredSandboxExecutor` instead of `CloudflareSandbox` |
| `sandbox.ts` | **Yes** | Add `TieredSandboxExecutor` implementation |
| `package.json` | **Yes** | Add `@cloudflare/shell`, `@cloudflare/codemode`, `@cloudflare/worker-bundler` |

### 3.7 Expected Impact

- **~80% of sessions never start a container** (most agent work is read/write/grep)
- **Sub-second tool response** for file operations (vs seconds waiting for container)
- **Zero idle cost** for Workspace-only sessions
- **No regression** for sessions that do need containers — same behavior, just delayed start

---

## 4. Proposal: Fork-Based Event Log

### 4.1 Core Idea

Add branching to the event log. A fork is a zero-copy pointer — no events are duplicated.

### 4.2 Schema Change

```sql
-- One column addition
ALTER TABLE events ADD COLUMN branch TEXT DEFAULT 'main';

-- One new table
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  parent_branch TEXT NOT NULL DEFAULT 'main',
  fork_from_seq INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 4.3 Operations

**Fork:**
```typescript
function fork(fromSeq: number, branchName: string) {
  db.exec(
    `INSERT INTO branches (id, parent_branch, fork_from_seq) VALUES (?, 'main', ?)`,
    branchName, fromSeq
  );
}
```

**Read branch history:**
```sql
SELECT * FROM events
WHERE (branch = :parent AND seq <= :fork_from_seq)
   OR (branch = :branch)
ORDER BY seq
```

**Switch active branch:**
```typescript
this.activeBranch = branchName;  // Just a pointer swap
```

### 4.4 Non-Destructive Compaction

Current `SummarizeCompaction` replaces middle messages — they're gone. With fork:

```
Branch "main" (untouched):
  seq 1:  user.message
  seq 2:  agent.message
  seq 3:  agent.tool_use        ─┐
  seq 4:  agent.tool_result      │ 20 messages to compress
  ...                             │
  seq 22: agent.message         ─┘
  seq 23: user.message
  seq 24: agent.message

Branch "main@compacted-1" (fork_from_seq=2):
  seq 25: agent.message   → "[Summary of seq 3-22]: ..."
  seq 26: user.message    → copy of seq 23
  seq 27: agent.message   → copy of seq 24

Active branch switches to "main@compacted-1"
```

- **Original history preserved** in "main" — always recoverable
- **Compacted branch used for inference** — smaller context window
- **FTS5 searches all branches** — nothing lost for retrieval

### 4.5 Changes to `history.ts`

```typescript
// Current
getMessages(): ModelMessage[] {
  const rows = this.db.exec("SELECT * FROM events ORDER BY seq");
  return eventsToMessages(rows);
}

// New
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

  return eventsToMessages(rows);  // eventsToMessages unchanged
}
```

### 4.6 Capabilities Unlocked

| Capability | How |
|---|---|
| **Non-destructive compaction** | Fork + summary event, originals preserved |
| **A/B exploration** | Fork from same seq, run different strategies |
| **Rollback** | Switch `activeBranch` back to parent |
| **Full-history search** | FTS5 index on `events` table covers all branches |
| **Thread unification** | Existing `session_thread_id` could migrate to branches (future) |
| **Audit trail** | Every compaction/fork is traceable via `branches` table |

### 4.7 Scope of Change

- `events` table: +1 column
- New `branches` table
- `history.ts`: `getMessages()` adds ~10 lines of query logic
- `compaction.ts`: `compact()` creates a fork instead of replacing messages
- `eventsToMessages()`: **unchanged** — it just converts a list of events, doesn't care about source
- `tools.ts`, `default-loop.ts`, harness: **unchanged**

---

## 5. Adoption Strategy

### Track A: History & Compaction

**Phase A1: Fork-based history** (low effort, high value)
- Add `branch` column + `branches` table
- Update `getMessages()` to support branches
- Rewrite `SummarizeCompaction` to use fork instead of replace
- All existing behavior preserved (default branch = "main")

### Track B: Tiered Execution

**Phase B1: Workspace tier** (medium effort, high value)
- Add `@cloudflare/shell` dependency
- Implement `WorkspaceSandbox` for `readFile`/`writeFile`/`grep`/`glob`
- Route file-only tools through Workspace
- Container becomes lazy — only started when `bash` hits a `CONTAINER_PATTERNS` match

**Phase B2: Code execution tier** (medium effort, medium value)
- Add `@cloudflare/codemode` + `@cloudflare/worker-bundler`
- Route simple computation to Dynamic Worker
- Agent can execute JS without container

**Phase B3: Full TieredSandboxExecutor** (integration)
- Combine all tiers into unified executor
- Add Workspace ↔ Container sync via shared R2
- Monitoring: emit events for tier selection decisions

### Track C: Sub-Agent Architecture

**Phase C1: Parallel delegation** (low effort, high value)
- Verify `Promise.all` on concurrent `runSubAgent()` calls
- Expose via `call_agents_parallel` tool or rely on AI SDK multi-tool-call

**Phase C2: Persistent threads** (medium effort, high value)
- `thread_events` SQLite table replaces InMemoryHistory
- `this.threads` recovered from SQLite on DO wake
- New `continue_thread` tool for cross-turn reuse

**Phase C3: Structured returns** (low effort, medium value)
- `SubAgentResult` replaces plain text (artifacts, status, thread_id)
- Parent can reason about sub-agent outputs structurally

**Phase C4: Facets integration** (high effort, high value, when ready)
- Sub-agents become colocated Durable Objects
- Independent SQLite + sandbox per sub-agent
- Typed RPC replaces string-based tool calls

### Track D: Platform Tools

**Phase D1: FTS5 history search** (low effort, high value)
- Add FTS5 virtual table on events
- New `search_history` built-in tool
- Works immediately with fork-based history (all branches searchable)

**Phase D2: Execute tool (codemode)** (medium effort, high value)
- Add `@cloudflare/codemode` dependency
- New `execute` built-in tool via `createCodeTool()`
- Wire workspace as `state.*` ToolProvider
- Requires `worker_loaders` binding in wrangler.jsonc

### Track E: Environment Snapshot Mode

**Phase E1: Snapshot cache** (medium effort, high value)
- 新增 `build: "snapshot"` 模式
- Session warmup 时安装包 + `createBackup()` + 存 KV
- 后续 session `restoreBackup()` 秒级恢复
- 现有 pre-build 模式不变

### Parallelism

Tracks A, B, C, D, E are independent and can proceed in parallel. Within each track, phases are sequential.

---

## 6. Proposal: Sub-Agent Architecture Upgrade

### 6.1 Current State

OMA has three层 multi-agent 设计：

| 层级 | 状态 | 机制 | 通信 |
|---|---|---|---|
| **Hierarchical delegation** | 已实现 | `call_agent_*` → `runSubAgent()` → 同 session 内线程 | 同步 await，返回文本 |
| **Peer team messaging** | 已设计 (agent-im-design.md) | TeamDO → HTTP push → SessionDO | 异步，tool-based |
| **Dynamic agent pool** | 未设计 | 按 capability 路由，自动实例化 | 动态 |

**现有线程模型的问题：**

1. **InMemoryHistory** — 子 agent 的历史在内存中，线程完成即丢失，crash 不可恢复
2. **同步阻塞** — 父 agent 必须 `await` 子 agent 完成，不能并发委托
3. **共享 sandbox** — 子 agent 共享父 sandbox 的所有文件，无隔离
4. **无持久化** — 子 agent 状态不跨 turn 存活，不能被后续 turn 复用
5. **字符串通信** — `delegateToAgent()` 返回纯文本，丢失结构化信息

### 6.2 三方对比

| | OMA (current) | OpenAI Agents SDK | Project Think |
|---|---|---|---|
| **子 agent 创建** | `call_agent_*` tool | `agent.as_tool()` / Handoff | `this.subAgent(Class, name)` |
| **隔离** | 共享 sandbox + InMemoryHistory | 独立 sandbox config | **独立 SQLite + 独立执行上下文** (Facets) |
| **通信** | 同步 await，返回文本 | 同步 tool result / handoff | **Typed RPC** (编译时类型安全) |
| **并发** | 串行 (一次一个 await) | 串行 | **`Promise.all()`** 原生并行 |
| **持久化** | 线程完成即销毁 | 依赖 provider | **跨 hibernation 存活** |
| **延迟** | 函数调用级 (同进程) | 取决于 runner | **函数调用级** (Facets 同机房) |
| **peer 通信** | 计划中 (TeamDO) | 无 | 无 (仅 parent → child) |

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
- **Typed RPC** — TypeScript 编译时就能检查通信接口
- **存活 hibernation** — 父 agent 醒来，子 agent 状态还在
- 父 agent **看不到子 agent 内部**（真正的封装）

### 6.4 OMA 应该有两种模式

OMA 计划的 TeamDO 和 Think 的 Facets 不是互斥的，它们解决不同问题：

```
┌──────────────────────────────────────────────────────────┐
│  紧耦合 (Facets 模式)                                     │
│  ─────────────────────                                    │
│  同一个 SessionDO 内，子 agent 作为 colocated DO           │
│  用于：分解当前任务、并行处理、结果合成                       │
│  特点：同步/并行、独立存储、typed RPC、低延迟               │
│  例子：研究 agent + 评审 agent + 编码 agent 并行工作        │
│                                                           │
│  OMA 映射：升级现有 threads → Facets-style sub-agents      │
├──────────────────────────────────────────────────────────┤
│  松耦合 (TeamDO 模式)                                     │
│  ─────────────────────                                    │
│  独立的 SessionDO，通过 TeamDO 协调                        │
│  用于：持续协作、异步任务、跨 session 通信                   │
│  特点：异步消息、共享任务列表、capability 路由               │
│  例子：前端团队 + 后端团队 + QA 团队长期协作                │
│                                                           │
│  OMA 映射：保持 agent-im-design.md 中的 TeamDO 设计        │
└──────────────────────────────────────────────────────────┘
```

### 6.5 紧耦合模式：升级现有 Threads

**目标：** 用 Facets 思路重构 `runSubAgent()`，解决 5 个现有问题。

#### 6.5.1 替换 InMemoryHistory → 独立 SQLite

```typescript
// 现在: 线程完成即丢失
const subHistory = new InMemoryHistory();

// 改后: 每个子 agent 有独立持久化存储
// 利用 Cloudflare Durable Object 的 Facets
const subAgent = await this.facet(SubAgentDO, threadId);
// subAgent 有自己的 SQLite，跨 hibernation 存活
```

如果不直接用 Facets（OMA 可能还没升级到支持 Facets 的 Workers runtime），可以用 **同一个 DO 的 SQLite 分表** 模拟：

```sql
-- 主 agent 事件
CREATE TABLE events (...);

-- 子 agent 事件 (thread_id 做前缀)
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
// 现在: 串行，一次只能 await 一个子 agent
const result1 = await this.delegateToAgent(agentA, msg1);  // 阻塞
const result2 = await this.delegateToAgent(agentB, msg2);  // 等 A 完成才开始

// 改后: 并行 (Think 的 Promise.all 模式)
const [result1, result2] = await Promise.all([
  this.delegateToAgent(agentA, msg1),
  this.delegateToAgent(agentB, msg2),
]);
```

**现有架构已经支持这个** — `runSubAgent()` 是 async 函数，`Promise.all()` 直接可用。只需要在 `call_agent_*` 工具层面暴露并行能力。

方案 A — 新增 `call_agents_parallel` 工具：

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

方案 B — 让 LLM 在一个 turn 内发多个 `call_agent_*`，AI SDK 的 `maxSteps` 循环天然并行处理同 step 的多个 tool call。**可能不需要新工具。**

#### 6.5.3 子 agent Sandbox 隔离（可选）

Think 的子 agent 有完全独立的存储。OMA 可以选择：

| 级别 | 隔离程度 | 实现 |
|---|---|---|
| **Level 0 (现状)** | 共享 sandbox，共享所有文件 | 不变 |
| **Level 1** | 共享 sandbox，子 agent 有自己的工作目录 | `chdir` 到 `/workspace/threads/{threadId}/` |
| **Level 2** | 独立 Workspace (Tier 0 隔离) | 子 agent 用独立的 `@cloudflare/shell` 实例 |
| **Level 3 (Think 级别)** | 完全独立 DO | Facets，独立 SQLite + 独立 sandbox |

**推荐 Level 1** 作为起点 — 改动最小，已经提供了基本的文件隔离。

#### 6.5.4 结构化返回（替代纯文本）

```typescript
// 现在: 返回拼接的文本
return responseText || "(sub-agent produced no text output)";

// 改后: 返回结构化结果
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
// Turn 1: 创建子 agent，执行任务
const result = await delegateToAgent("coder", "implement feature X");
// thread_id = "thread_abc123" 存在 thread_events 表中

// Turn 2: 用户说 "让 coder 加个测试"
// 父 agent 识别出之前的 thread，继续对话
const result2 = await continueThread("thread_abc123", "add tests for feature X");
// 子 agent 的历史还在（SQLite），上下文完整
```

需要：
- `thread_events` 表持久化子 agent 历史
- 新增 `continue_thread` 工具（或在 `call_agent_*` 中支持 `thread_id` 参数）
- `this.threads` map 从内存改为从 SQLite 恢复

### 6.6 松耦合模式：TeamDO 增强

agent-im-design.md 中的 TeamDO 设计保持不变，但可以借鉴 Think 的几个点：

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
需要子 agent 的结果才能继续？ ──→ 紧耦合 (Facets-style threads)
  - 研究 → 合成
  - 编码 → 测试 → 修复
  - 分析 → 报告

子 agent 可以独立工作？ ──→ 松耦合 (TeamDO)
  - 前端 + 后端并行开发
  - 多 PR 同时处理
  - 长期运行的监控 agent
```

### 6.8 实现路线

**Phase 1: 并行委托 (最低成本)**
- AI SDK 的 `generateText` 已支持同 step 多 tool call 并行
- 验证 `Promise.all` 在 `runSubAgent` 上是否开箱即用
- 如果不行，加 `call_agents_parallel` 工具

**Phase 2: 子 agent 持久化**
- `thread_events` 表替代 InMemoryHistory
- `this.threads` 从 SQLite 恢复（跨 hibernation）
- 新增 `continue_thread` 工具

**Phase 3: 结构化返回**
- `SubAgentResult` 接口替代纯文本
- 返回 artifacts、status、thread_id
- 父 agent 可以基于结构化结果做决策

**Phase 4: Facets 集成 (当 Cloudflare 稳定后)**
- 子 agent 升级为 colocated DO
- 独立 SQLite + 独立 sandbox
- Typed RPC 替代字符串 tool call

---

## 7. What We Don't Adopt

| Think feature | Decision | Reason |
|---|---|---|
| Think base class | **Skip** | OMA's pluggable `HarnessInterface` is more flexible than Think's hook overrides |
| Fibers (durable execution) | **Defer** | OMA's event-sourced recovery is sufficient for now |
| Facets (sub-agent RPC) | **Adopt incrementally** | Phase 1-3 用 SQLite 分表模拟隔离 + 并行；Phase 4 等 Cloudflare Facets 稳定后迁移到 colocated DO (see Section 6) |
| Context Blocks | **Harness responsibility** | 带 token 预算的持久化 system prompt 段，OMA 的 harness 可自行实现 (see Section 8) |
| Codemode (Tier 1) | **Adopt** | 执行阶梯的一部分，作为 `execute` built-in tool，天然访问 Workspace (Tier 0) + Container (Tier 4) (see Section 3.4) |
| Self-extending agents | **Evaluate** | Think 的 `ExtensionManager` 让 agent 写 TypeScript 扩展持久化为 Dynamic Worker。安全模型成熟（权限声明 + workspace 访问控制），但需要评估是否适合 OMA 的多租户场景 |

---

## 8. Context Blocks — Harness 层记忆

Think 的 Context Blocks 是 system prompt 中的**结构化持久段**，带 token 预算：

```typescript
configureSession(session: Session) {
  return session
    .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
    .withContext("plan", { description: "Current plan", maxTokens: 1000 })
    .withCachedPrompt();
}
// System prompt 中显示: MEMORY (42%, 462/1100 tokens)
```

Agent 通过工具主动读写这些 blocks，空间满了自动淘汰旧内容。

**这是 harness 的职责**，不是平台的。OMA 中：
- 平台提供 `history.getMessages()` 和 system prompt 的拼接点
- Harness 在 `run()` 中决定 system prompt 怎么组装
- Context blocks = harness 在 system prompt 中管理的命名段落 + token 计数

与 OMA 现有 Memory Store（向量语义搜索）互补：
- Memory Store = 外部知识检索（跨 session）
- Context Blocks = 当前 session 内的持久化工作记忆

Harness 开发者可以在自定义 harness 中自行实现这个模式。

---

## 9. FTS5 历史搜索 — 平台内置 Tool

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

配合 fork-based history（Section 4），所有分支的原始内容都可搜索 — 即使当前分支已经压缩过。

---

## 10. Environment 双模式：Pre-build + Snapshot Cache

### 10.1 现状

OMA 用 GitHub Actions 预构建 Docker 镜像：

```
POST /v1/environments → status: "building" → CI 构建镜像 → build-complete → status: "ready"
POST /v1/sessions → 用预构建镜像启动 (秒级)
```

Anthropic 没有 build 流程，推测是运行时安装 + 某种缓存。

### 10.2 发现：Cloudflare Sandbox 原生支持 Backup/Restore

Sandbox SDK 提供 Backups API — 基于 squashfs + FUSE overlayfs + R2：

```typescript
// 快照：压缩目录 → 上传 R2
const backup = await sandbox.createBackup({ dir: "/", ttl: 604800 });

// 恢复：从 R2 下载 → FUSE overlay 挂载 (copy-on-write)
await sandbox.restoreBackup(backup);
```

恢复后的文件系统是 Copy-on-Write：
- Lower layer (read-only): snapshot 中的内容（已装好的包）
- Upper layer (writable): 新写入的文件
- 跨 session 共享同一个 snapshot，各 session 的 upper layer 独立

### 10.3 方案：保留两种模式

不砍掉 build 流程，而是**两种模式并存**，用户按需选择：

#### Mode A: Pre-build (现有方式)

```
POST /v1/environments
  { "config": { "type": "cloud", "build": "prebuild", "packages": {...} } }

→ 触发 CI → 构建自定义镜像 → status: "ready"
→ 每个 session 直接用镜像启动 (最快)
```

**适用场景：**
- 大量系统包 (apt)、复杂编译依赖
- 需要自定义 Dockerfile
- 高频使用的 environment（启动速度优先）
- 企业场景（镜像审计、安全扫描）

#### Mode B: Snapshot Cache (新增)

```
POST /v1/environments
  { "config": { "type": "cloud", "build": "snapshot", "packages": {...} } }

→ 直接存 config → status: "ready" (瞬间)

首次 session:
  → base container → 安装 packages → createBackup("/") → 存 KV
  → 标记 env snapshot ready

后续 session:
  → base container → restoreBackup() → 秒级就位
```

**适用场景：**
- 快速迭代（改个包不想等 CI build）
- 轻量依赖 (几个 pip/npm 包)
- 开发/测试环境
- 一次性 / 临时 environment

#### 实现

```typescript
// session-do.ts — sandbox 初始化时
async function warmupSandbox(sandbox: SandboxExecutor, envConfig: EnvironmentConfig) {
  const mode = envConfig.config.build || "prebuild";

  if (mode === "prebuild") {
    // 现有逻辑不变 — 用预构建镜像
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

| | Anthropic | OMA (Pre-build) | OMA (Snapshot) |
|---|---|---|---|
| Environment 创建 | 瞬间 | 分钟级 (CI build) | 瞬间 |
| 首次 session | 慢 (安装包) | 快 (预构建镜像) | 慢 (安装包 + snapshot) |
| 后续 session | 快 (推测 snapshot) | 快 (预构建镜像) | 快 (restore snapshot) |
| 自定义 Dockerfile | 不支持 | **支持** | 不支持 |
| 改包后生效 | 下次 session | 重新 build (分钟) | 下次 session (自动) |
| 基础设施 | VM snapshot (推测) | CI pipeline | R2 + Sandbox Backups |

**两种模式并存 = Anthropic 的便利 + OMA 独有的 pre-build 能力。**

### 10.5 限制

- FUSE 挂载在 sandbox sleep/restart 后丢失，需要重新 `restoreBackup()`（每次 session warmup 都要调一次）
- Snapshot 默认 TTL 3 天，需要配置刷新策略
- 根目录 snapshot 可能几百 MB（apt 包大），R2 存储有成本
- `useGitignore: true` 可以排除不必要的文件减少体积

---

## 8. References

- [OpenAI Agents SDK — Sandboxes](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [OpenAI — Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)
- [Cloudflare — Project Think](https://blog.cloudflare.com/project-think/)
- [OMA — Architecture](./architecture.md)
- [OMA — Gap Analysis](./gap-analysis.md)
- [OMA — Serverless Harness SDK](./serverless-harness-sdk.md)
