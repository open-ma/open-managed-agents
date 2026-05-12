# OMA Trajectory v1 —— Schema 规格

**状态**：草稿
**Schema 版本**：`oma.trajectory.v1`
**负责人**：平台 / verifier 框架工作流
**日期**：2026-04-17

## 这份文档为什么存在

OMA 真正的平台杠杆**不是**「统一的 scorer 接口」——而是 **agent 执行轨迹**：SSEEvent 流 + sandbox + 多 agent + supervisor loop。这种形态没有别人有。

本文把这条轨迹固化为 **OMA Trajectory 的规范格式**：稳定、版本化，并附带向行业主流形态（Anthropic Messages、OpenTelemetry GenAI、Inspect AI TaskState、RL TurnRecord）的投影定义。

> **设计原则**：拥有底层 substrate，而不是上面的抽象。Eval / RL / 监控 / outcome 评测都只是 Trajectory 的*消费者*。

## 非目标

- 不打算统一 scorer / verifier / reward function 的接口（这是有意为之——见 `docs/archive/handoff-verifier-framework.md` 的讨论）。
- 不把 OTel GenAI 当作*内部*格式（太通用了；多 agent / supervisor / sandbox 不是一等公民）。它仅作为*投影*被采用。
- 不设计 benchmark（SWE-bench、GAIA loader 等）——那些是*产生* Trajectory 的数据集适配器。

## 我们已有的（锁为 v1）

`packages/shared/src/types.ts:350` 定义了 `SessionEvent` —— runtime 发出的所有事件的联合类型。词汇表如下：

| 类别 | 事件 | 用途 |
|---|---|---|
| 用户输入 | `user.message`、`user.interrupt`、`user.tool_confirmation`、`user.custom_tool_result`、`user.define_outcome` | 用户/调用方发进来的内容 |
| Agent 行为 | `agent.message`、`agent.thinking`、`agent.tool_use`、`agent.tool_result`、`agent.custom_tool_use`、`agent.mcp_tool_use`、`agent.mcp_tool_result` | LLM 产出 + 工具执行 |
| 多 Agent | `session.thread_created`、`agent.thread_message`、`agent.thread_message_sent`、`agent.thread_message_received`、`agent.thread_context_compacted`、`session.thread_idle` | 子 agent / supervisor 线程 |
| Outcome | `user.define_outcome`、`outcome.evaluation_end`、`session.outcome_evaluated`、`span.outcome_evaluation_*` | Supervisor 模式的修订 loop |
| 生命周期 | `session.status_running`、`session.status_idle`、`session.status_rescheduled`、`session.status_terminated`、`session.error` | session 状态 |
| Span | `span.model_request_start`、`span.model_request_end`、`span.outcome_evaluation_*` | 可观测性（耗时、token 用量）。`span.model_request_end` 还带 `finish_reason` + `final_text_length`，便于发现「静默截断」 |
| Aux | `aux.model_call` | 工具内部的 LLM 调用，按 `agent.aux_model` 计费（如 `web_fetch` 的页面摘要）。与 `span.model_request_*` 区分，方便成本看板单独归类 |

`StoredEvent`（`types.ts:495`）是持久化信封：`{seq, type, data, ts}`。

**v1 承诺**：上面列的每种事件类型**都属于稳定的 v1 词汇表**。废弃需要升 v2。

## Trajectory 信封

Trajectory 把一个 session 的事件流连同重放、评测、训练、审计所需的元数据一起包起来。

```typescript
export interface Trajectory {
  // --- 标识 ---
  schema_version: "oma.trajectory.v1";
  trajectory_id: string;          // ULID —— 全局唯一
  session_id: string;             // 来自哪个 OMA session
  group_id?: string;              // RL：同一任务被采样 N 次共享的 group_id
  task_id?: string;               // RL/eval：本轨迹跑的是哪个任务

  // --- 配置快照（在 session 启动时冻结） ---
  agent_config: AgentConfig;      // 见 types.ts:41 —— 完整快照，**不是**引用
  environment_config: EnvironmentConfig; // 见 types.ts:62
  model: { id: string; provider: string; base_url?: string };

  // --- 生命周期 ---
  started_at: string;             // ISO-8601
  ended_at?: string;              // 运行中为空
  outcome: TrajectoryOutcome;     // 见下

  // --- 事件 ---
  events: StoredEvent[];          // 见 types.ts:495

  // --- RL 扩展（可选，非 RL 场景省略） ---
  completions?: Completion[];     // 每次 LLM 调用的 token 级数据
  reward?: RewardResult;          // 由 verifier 事后填充
  group_stats?: GroupStats;       // 由 GRPO advantage 估计器填充

  // --- 聚合（end 时算一次缓存，便于快速评测） ---
  summary: TrajectorySummary;
}

export type TrajectoryOutcome =
  | "success"          // session.status_idle 且无错
  | "failure"          // session.error 或 supervisor 失败
  | "timeout"          // 触达墙钟或回合上限
  | "interrupted"      // user.interrupt
  | "running";         // 还没结束

export interface TrajectorySummary {
  num_events: number;
  num_turns: number;              // agent.message 事件数
  num_tool_calls: number;
  num_tool_errors: number;
  num_threads: number;            // 多 agent 线程数
  duration_ms: number;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}
```

### 信封明确**不**包含什么

- **Sandbox 状态快照**（文件系统 diff、进程列表）。v1 不在范围内——会让体积爆炸。校验时用 `agent.tool_result` 的内容 + `bash` 退出码。
- **压缩 / 脱敏变体**。Trajectory 是原始制品；压缩是传输层的事。
- **Scorer 输出**。Score 单独存放，通过 `trajectory_id` 引用。**同一条 trajectory 可以有很多个 score。**

## 因果关系

为了支持 replay、多 agent 调试、supervisor 修订归因，每个事件通过 `EventBase` 上已有的三个字段隐式带因果：

| 字段 | 来源 | 含义 |
|---|---|---|
| `id` | `EventBase.id`（已存在） | 事件唯一 |
| `seq` | `StoredEvent.seq`（已存在） | session 内单调递增——总顺序 |
| `processed_at` | `EventBase.processed_at` | 摄入时墙钟 |

**v1 给 `EventBase` 增加一个可选字段**：

```typescript
export interface EventBase {
  id?: string;
  processed_at?: string;
  parent_event_id?: string;       // 新增：因果前驱
}
```

约定：

- `agent.tool_result.parent_event_id` → 它回答的那个 `agent.tool_use`
- `agent.thread_message_received.parent_event_id` → 来自对端的那条 `agent.thread_message_sent`
- `outcome.evaluation_end.parent_event_id` → 被评测的那条 `agent.message`

`parent_event_id` **可选**（保持向后兼容），但**只要关系明确就应当填**。重放工具必须能在没有它的情况下工作（回落到 `tool_use_id` 匹配等）。

## RL 扩展

上面的 trajectory 捕获的是*外部*执行。RL 训练器还需要*内部*（每次 LLM 调用的）token 数据。我们用一条**独立的并行数组**保存它，**不**和事件交叉。

```typescript
export interface Completion {
  completion_id: string;          // ULID
  span_id?: string;               // 关联 span.model_request_start.id
  turn_index: number;             // 0-based，对应第 N 个 agent.message
  prompt_ids: number[];           // 输入 token 化
  response_ids: number[];         // 输出 token 化
  logprobs: number[];             // 每个响应 token（行动 logprob）
  ref_logprobs?: number[];        // 参考模型 logprob（KL 项）
  finish_reason: "stop" | "length" | "tool_calls" | "error";
  model_id: string;               // 实际使用的模型（A/B 时可能与 agent_config 不同）
  // 给带 token 级 reward 的 PPO/GRPO：
  token_advantages?: number[];    // 长度 === response_ids.length
  token_rewards?: number[];       // 长度 === response_ids.length
}

export interface RewardResult {
  raw_rewards: Record<string, number>;  // 命名分量（test_pass、format、efficiency …）
  final_reward: number;                  // 聚合标量 [0, 1]
  // 调试可选元数据
  verifier_id?: string;                  // 哪一个 scorer 算的
  computed_at?: string;
}

export interface GroupStats {
  group_id: string;
  reward_mean: number;
  reward_std: number;              // 不为 0（除法时夹到 1e-8）
  finished_num: number;
  pass_rate: number;
  // GRPO advantage = (reward - mean) / std，消费时按 trajectory 计算
}
```

### 为什么用并行数组、不交叉

- 事件流是**产品规格**（始终存在，UI / outcome eval / 监控都用）。
- completions 是**仅训练用**数据（仅在为 RL 收集时存在）。
- 分开就意味着：信封一致，非 RL 场景下 `completions === undefined`。零浪费。

### 命名尽量与 verl / TRL / OpenRLHF 对齐

| OMA 字段 | verl 名 | TRL 名 |
|---|---|---|
| `prompt_ids` | `prompt_input_ids` | 同 |
| `response_ids` | `response_input_ids` | 同 |
| `logprobs` | `old_log_prob` | `old_per_token_logps` |
| `ref_logprobs` | `ref_log_prob` | `ref_per_token_logps` |
| `token_advantages` | `advantages` | 同 |
| `token_rewards` | `token_level_rewards` | 同 |

适配器（`projections/`）负责具体改名以适配各家训练器。

## 投影（即「出口」）

每个投影都放在 `packages/shared/src/trajectory/projections/`，单文件 30–100 行。纯函数，无 I/O。

| 投影 | 输出 | 消费者 | 体量 |
|---|---|---|---|
| `toAnthropicMessages(traj)` | `AnthropicMessage[]`（role + content blocks） | HF datasets、SWE-bench scorer、社区 Anthropic 工具 | ~50 行 |
| `toOTelGenAISpans(traj)` | `OTelSpan[]`（`gen_ai.*` 语义约定） | Datadog、Honeycomb、Grafana Tempo | ~80 行 |
| `toInspectTaskState(traj)` | 类似 Inspect AI 的 `TaskState` dict | Inspect AI scorer | ~60 行 |
| `toRLTurnRecords(traj)` | `TurnRecord[]`（当前 `rl/types.ts` 形态） | rl/verifier.ts、GRPO trainer | ~40 行（基本是恒等） |

投影是**单向有损**的（如 OTel 没法干净表达 supervisor 修订）——**原始 trajectory 始终是真理之源**。

### 反向投影

v1 不范围。**我们不承诺把 OTel span → Trajectory 反向解析。**用户要重放外部 trace 请自带 loader。

## 版本策略

- **加法变更**（新事件类型、新可选字段）→ 仍是 v1。**消费者必须忽略未知字段/类型。**
- **破坏性变更**（重命名、删除、改语义）→ 升 `schema_version` 到 `oma.trajectory.v2`。两版必须共存 ≥1 个发布周期。
- **存储**：每条持久化的 Trajectory **必须**带 `schema_version`。Runtime 在读取时校验，不匹配直接报错。

## 实施时代码会改什么（最少）

绝大多数工作只是给*已经存在的东西*命名：

1. **`packages/shared/src/types.ts`** —— 新增 `Trajectory`、`TrajectoryOutcome`、`TrajectorySummary`、`Completion`、`RewardResult`、`GroupStats` 导出。给 `EventBase` 加 `parent_event_id?`。
2. **`packages/shared/src/trajectory/build.ts`**（新增，约 80 行）—— `buildTrajectory(session_id) → Trajectory`：读已存事件 + agent + env，算 summary，输出信封。
3. **`packages/shared/src/trajectory/projections/`**（新增，总计约 250 行）—— 上述四个文件。
4. **`rl/types.ts`** —— 用 shared 里的 import 替换本地 `Trajectory`。`TurnRecord` 保留为 RL 投影形态。
5. **`test/eval/types.ts`** —— `EvalTask.verify` 签名新增 Trajectory 选项（events 兼容保留）。
6. **API**：新增 `GET /v1/sessions/:id/trajectory`，返回完整信封。

事件格式不变。Runtime 发事件的逻辑也不变（只多一个可选 `parent_event_id`）。

## 待解决的问题（实施前定）

1. **Sandbox 快照** —— 信封里要不要带「session 结束时的 fs 状态」的*某种*版本？（建议：不要，v1 不带。）
2. **Token 用量归因** —— 当前 `span.model_request_end.model_usage` 是 per-call。要不要在 summary 里留累计值？（建议：要——已经在 `TrajectorySummary` 里了。）
3. **压缩** —— `agent.thread_context_compacted` 会移除早期消息。trajectory 还包含它们吗？（建议：包含—— trajectory 是原始历史；压缩是 runtime 关心的事，不是存储。）
4. **PII / secret 脱敏** —— 投影可能需要清洗。v1 不范围，单独的脱敏层。

## v1 验收

- [ ] 规格已 review 并通过
- [ ] `Trajectory` 类型已加到 `packages/shared`
- [ ] `buildTrajectory()` 能跑现有 session，已用 T2.1 验证
- [ ] `toAnthropicMessages` 投影对一个已知 session 能正确往返
- [ ] 至少有一个外部 scorer（Inspect AI hello-world）能通过投影无修改地消费

## 参考

- `packages/shared/src/types.ts` —— 当前事件词汇表
- `rl/types.ts` —— 当前 RL trajectory 形态（将成为投影目标）
- `test/eval/types.ts` —— 当前 eval 形态
- `apps/agent/src/harness/outcome-evaluator.ts` —— 当前 outcome evaluator
- `docs/archive/handoff-verifier-framework.md` —— 上一会话的上下文
- Inspect AI `TaskState`：https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/solver/_task_state.py
- OTel GenAI 语义约定：https://opentelemetry.io/docs/specs/semconv/gen-ai/
- verl / SkyRL / OpenRLHF —— RL trajectory 形态参考