# OpenAI Turn / Item 外层投影审计

本文保留实施前的问题分析。实施中已在现有事件 JSON 补充提交顺序与 execution
关联，并加入真实 SQL 重放、取消和幂等回归；当前结论见
[实现与验收状态](./openai-agents-compatibility-status.md)。

本审计依据当前代码与 `openai@7.15.0`。目标是在 OpenAI 协议适配层复用已有事件、输入批次和工具关联，不先向核心增加 Turn / Item 业务原语。以下结论不是运行时兼容认证。

结论：消息与工具调用有稳定身份，可作为 Item 投影的依据；Turn 可以在输入归属和事件顺序明确时从外层推导。**不能仅凭 `session.status_idle`，甚至 `stop_reason=end_turn`，判定成功完成。** 全量历史投影仍有信息缺口。

## 已证实的事实

| 信息 | 当前代码事实 | 对投影的意义 |
| --- | --- | --- |
| 应用事件 | [`HistorySessionEvent`](../packages/managed-agents-domain/src/sessions/event.ts) 有 `id`、`processedAt`、工具结果引用及 stopReason，没有持久化 Turn ID | 可复用事件身份；不能假定事件自带 Turn 归属 |
| 消息身份 | [`decodeRuntimeEvent`](../packages/managed-agents-adapters-runtime/src/index.ts) 将 `message_id` / `thinking_id` 保留为最终事件 `id` | 最终消息与 live delta 使用同一个 Item 身份 |
| 工具配对 | use 的 `id` 与 result 的 `toolUseId` / `mcpToolUseId` / `customToolUseId` 对应 | 可以可靠匹配调用和结果；custom result 不能直接当作新逻辑 Turn |
| 原始日志顺序 | [CF event-log](../packages/event-log/src/cf-do/index.ts) 使用自增 `seq`，明确记录 INSERT / drain 顺序 | 原始日志可提供有证据的排序 |
| 应用历史顺序 | [SQL event store](../packages/session-event-store-sql/src/index.ts) 与 [runtime history](../packages/session-runtime-sql/src/history.ts) 按 `processed_at, id` 排序；[事件 ID](../packages/shared/src/id.ts) 来自随机 nanoid | 排序稳定，但不保证同毫秒事件的真实发生顺序 |
| 执行批次 | [`SessionExecution`](../packages/session-runtime-contract/src/coordination.ts) 有稳定 `id`、输入 `events`、`laneId`、状态、attempt 和结算时间；批次 ID 来自首个可执行输入事件 | 可帮助确认输入归属，但 execution 不自动等于跨工具暂停的逻辑 Turn |
| ACP Turn | [`SessionHostEvent`](../../openma-common/src/session-kernel/index.ts) 有 `turnId`；[ACP → Managed projector](../packages/harness-runtime-acp/src/managed-event-projector.ts) 内部按 Turn 跟踪，但输出 Managed 事件未携带它 | 已存在运行时身份，当前历史表示没有完整保留 |
| Common canonical Turn | [`managedEventEnvelope`](../../openma-common/src/protocol/managed/index.ts) 的 `turn_id` 来自调用方 `context.turnId` | 不能把它当作从 Managed 历史自动恢复的原始证据 |

### 终态不能直接照搬

- **取消也产生 `end_turn`。** [SessionDO 的 `user.interrupt` 分支](../apps/agent/src/runtime/session-do.ts) 明确说明 Claude StopReason 没有 interrupted，因此在活动执行被中断或待处理输入被取消后写 `idle/end_turn`。日志中的 `user.interrupt` 才携带取消原因。无活动执行的 no-op interrupt 不能取消一个已完成 Turn。
- **终止错误后仍产生 `end_turn`。** [Node runner](../apps/main-node/src/lib/node-managed-session-runner.ts) 的 catch 发出 `session.error`（`retryStatus: "terminal"`）；finally 仍写 `session.status_idle` / `end_turn`。清理失败同样先发错误再写 idle。因此后续 idle 不能覆盖 failed。
- **执行器有独立取消证据。** [Node execution worker](../apps/main-node/src/lib/node-session-execution-worker.ts) 在 `runtime.run` 返回后检查 `active.cancelled`，异常路径也根据该标志选择 cancelled / failed；不能只看 runner 的 end_turn。这个标志的结算结果属于 execution，需要先确认它和待投影 Turn 的关联。
- **等待工具并未成功完成逻辑 Turn。** [SessionDO 正常收尾](../apps/agent/src/runtime/session-do.ts) 将待 custom tool result / permission confirmation 写成 `requires_action`，带待处理 `event_ids`。外层应保持 Turn `waiting`，收到结果后继续同一 Turn。execution 的 `completed` 仅说明 `runtime.run` 已返回，不能独立证明没有工具等待；这里是执行器契约的限制，不代表已经验证了每个 runtime 的暂停实现。
- **调度和恢复不等于成功。** SessionDO 的旧执行清理会写 `rescheduled` + 无 stop_reason 的 idle；异常兜底也会写无 stop_reason idle。这些记录没有成功完成的证据。
- **最终消息存在不等于完整输出。** [SessionDO stream 收尾](../apps/agent/src/runtime/session-do.ts) 会在 aborted 时把部分文本持久化为 `agent.message`，之后记录流结束。应用侧 decoder 不保留 stream-end 状态，单读最终消息不能区分完整输出和中断片段。

上述行为在源代码中可直接观察。**同毫秒排序可能导致错误分组**是由当前存储契约推导的风险，本审计没有声称已经复现线上误分组。

## 建议的外层映射规则

1. **先确认归属和顺序。** 按 session + thread / lane 投影，使用原始 `seq`、已知有序输入或明确的批次关联。不要把 `processedAt,id` 的稳定分页顺序等同于发生顺序。来源缺少这些证据时，标记该历史范围无法可靠投影。
2. **生成可重放的协议身份。** 对明确的新输入批次，用首个已接受输入事件 ID 派生稳定 OpenAI Turn ID。不要把每条 `user.message` 都默认当作新 Turn；应按原生 execution 关联区分当前执行中的输入和下一次执行，具体 harness 的 steering 能力另行验证。不要因进程重启或重新读取而生成随机新 ID。
3. **开始和继续分开。** 第一个明确的 running 记录提供 `started_at`。requires_action 后的工具结果、重试及恢复 running 继续原先未终结的逻辑 Turn；execution attempt / generation 变化本身不创建新 Turn。
4. **先实现有证据的 Item。** 消息使用规范化后的事件 ID；custom function call 使用 use.id 作为 call_id，结果按现有引用配对。live delta 与最终消息合并。消息 `phase` 无证据时用协议允许的 null；thinking 没有正文时不要编造 reasoning summary。内置工具、MCP 和子代理各自的 Item 形状需要独立核对，不统一伪装为 function call。
5. **待操作保持非终态。** requires_action → Turn `waiting` + Session `requires_action`；保留待解决调用 ID，工具结果只解除对应调用的等待。OpenAI `tool_result.turn_id` 必须与原调用归属一致。
6. **终态必须有原因。** 已确认影响当前 Turn 的 interrupt / execution cancellation → cancelled；关联明确的 terminal / exhausted error → failed。retrying error 或 rescheduled 不直接终结 Turn。只有明确 end_turn，且没有未解决工具、取消、失败或恢复歧义时，才可 completed。`completed_at` 使用终态证据时间，不能用读取时间或当前 Session 状态补齐。
7. **终态具有单调性。** 已确定 cancelled / failed 后不能被后续 idle 改成 completed；一次 Turn 只发布一次终态。未知状态不补造 `turn.completed`，也不为了让 SDK stream helper 退出而补造成功事件。应给出明确的兼容能力错误，或在仍有活动证据时保持非终态与 null completed_at。

## 尚未决定的最小信息缺口

这些问题需要用具体适配路径和测试收敛，尚不构成增加核心原语的决定。

| 缺口 | 已有事实 | 下一步需要证明什么 |
| --- | --- | --- |
| 跨重启的事件顺序 | 原始 seq 与应用历史排序不同 | 外层是否能使用现有有序来源；若只能读取应用历史，哪些同时间记录必须拒绝推断 |
| 输入与输出批次关联 | [`RecordSessionRuntimeEventsCommand`](../packages/managed-agents-application/src/session-execution/port.ts) 接收 execution fence；当前历史事件没有明确保存该关联 | 能否从现有 execution / receipt / runtime 通道恢复归属；必要的协议投影状态是否只放外层 |
| 逻辑 Turn 与多次 execution | custom result 可触发续跑；执行完成不证明逻辑 Turn 完成 | 证明调用 ID 链能够跨暂停、重试和重启归并，避免拆成两个 OpenAI Turn |
| 中断与失败优先级 | runner 事件和 worker cancellation 结算是不同证据 | 选择哪条已有证据作为最终原因；缺少关联时不强行覆盖 |
| Item 完整状态 | 部分消息会持久化；stream-end 状态未进入应用事件历史 | 哪些路径允许确定 completed / incomplete，哪些需使用实时流或拒绝强推断 |
| Turn usage | 有 session 累计 usage 与模型 span usage；并非统一的 Turn 结算数据 | 如何关联 span、避免累计快照重复相加，以及哪些缺项必须返回 null |
| 多代理归属 | 有 session thread 事件和输入 lane；并非所有 History 类型都显式声明 thread 字段 | 逐项验证 root / subagent 隔离，不能把子代理完成当作 root Turn 完成 |

不直接复用旧 UI 的 [`normalizeSessionEvent` / `projectConversationTurns`](../../openma-common/src/session-events/managed.ts)：它把任意 idle 当作 turn_complete，是展示层简化规则，不满足上述协议语义。

## 下一层的最小验收案例

- 自然完成：有序输入 → running → message → end_turn，仅发一次 completed。
- 工具暂停：call → requires_action → result → running → end_turn，全程同一个 Turn ID。
- 用户取消：interrupt + idle/end_turn，结果是 cancelled；no-op interrupt 不改历史终态。
- 运行失败：terminal error + finally idle/end_turn，结果仍是 failed。
- 重试与恢复：retrying error / rescheduled / 无原因 idle 不产生成功终态。
- 并发与重放：相同时间戳、不同 lane、重复事件、重连后历史重读，不误归属、不重复 Item、不补造终态。

这些验收应从真实官方 SDK → OpenAI 外层适配器 → 现有应用接口逐层进行；本文件仅固定审计事实与下一步映射规则，没有修改生产实现。
