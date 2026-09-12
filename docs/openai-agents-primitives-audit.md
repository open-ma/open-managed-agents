# OpenAI Agents API 原语与 OpenMA 适配审计

本文保留实施前的逐项审计。当前代码落地、验收证据和运行能力缺口见
[实现与验收状态](./openai-agents-compatibility-status.md)。

审计日期：2026-09-11。目标是让官方 OpenAI SDK 通过 OpenMA 的兼容入口使用 Agents API；不是把 OpenAI 托管服务接成 OpenMA 的一个模型 provider。

本文对照当天实际读取的官方文档与当前工作区源码。`匹配` 表示核心语义已有承载点，仍需 HTTP 映射；`部分匹配` 表示可复用能力但合同不等价；`外层缺口` 表示当前未暴露对应合同，不意味着必须新增核心存储；`待验证` 表示需要 audit 证明现有行为或数据足以承载。此表不代表已经通过真实 OpenAI 服务联调，也不把文档存在等同于本地 SDK 已包含对应资源。

## 结论

**大部分适配可以在外层完成**：复用 Agent、Session、工具调用、Vault、执行沙箱与 EventLog，通过请求转换、应用编排及响应投影输出 OpenAI 合同。名称和资源粒度不同本身不构成修改核心模型的理由。需要审计的主要差异是：

1. OpenAI 明确区分 **Session、Turn、Item**。OpenMA 有 Session、SessionThread 和事件日志，其中已检查的 runtime `turn_id` 是运行标记，结束时清空；这只说明不能直接用该字段回答历史查询。应先验证能否从现有事件、线程身份与生命周期边界稳定投影 Turn，而不是立即加 Turn 表。
2. OpenAI 的 **Environment 是每个 Session 的执行实例**，另有可复用的 Environment Template。OpenMA 的 Environment 是可复用配置与 Work 队列入口，不能拿同一个 ID 直接充当这两层。
3. OpenAI 的 **required_actions 是可恢复的当前状态**，包括 function result 和 environment connection。OpenMA 的停机原因和 tool-use 事件可提供基础，可先从未匹配的 tool-use/result 和当前 Work 状态构造待办视图，再验证重启、重复提交与并发时是否正确。
4. OpenAI 的实时 **Events 与保存的 Items 是不同合同**。OpenMA 的 append-only EventLog 适合继续作为内部事实来源，再构造稳定的 Turn/Item 投影；不能把全部历史事件当成 OpenAI Items。

这些首先是外部合同的转换与投影问题。SDK audit 应先固定预期，再用现有 Port/EventLog 走通；只有真实测试证明信息已丢失、状态不可恢复或执行行为缺失时，才提出最小核心改动。官方产品提供托管 Codex harness；这说明完整行为兼容还涉及编排与恢复，不能用模型 API 可调用来代替。[产品介绍](https://openai.com/index/introducing-the-agents-api/)

## 原语对照

| OpenAI 原语 | 当前 OpenMA 承载点 | 结论 | 适配要求与证据 |
|---|---|---|---|
| Saved Agent；也可在 Session 中内联 Agent | `Agent` / `AgentModel` / `AgentTool`；Session 创建只接受已有 agent 的 selector | 部分匹配 | `instructions` 可映射 `system`；补内联配置入口。保留内部版本化，但不要输出未经官方合同定义的版本语义。[配置](https://developers.openai.com/api/docs/guides/agents-api/configuration)、[领域定义](../packages/managed-agents-domain/src/agents/definition.ts)、[创建入口](../packages/managed-agents-application/src/ports/sessions.ts) |
| `agent_id` + Session 级覆盖 | `SessionAgentSelector.overrides` | 部分匹配 | 已有覆盖承载点；OpenAI 明确对象/数组是整字段替换。要覆盖遗漏、显式 `null`、空数组、`tools` 替换及不可修改原 Agent 的测试；reasoning/output 配置不能静默丢失。[配置](https://developers.openai.com/api/docs/guides/agents-api/configuration) |
| Session；初始输入；异步执行；继续输入/取消 | `Session`、`initialEvents`、`user.message`、`user.interrupt` | 部分匹配 | 有核心会话能力；OpenAI 创建可直接 SSE，活跃期间的 message 是当前 Turn 的 steering，idle 时才开启新 Turn。取消 Turn 应保留 Session。需用真实 runtime 验证，而非只测试字段映射。[会话](https://developers.openai.com/api/docs/guides/agents-api/sessions)、[Session](../packages/managed-agents-domain/src/sessions/session.ts) |
| 历史 Turn：ID、状态、时间、usage、error、`subagent_id` | `RuntimeAdapter.beginTurn/endTurn`，`sessions.turn_id` | 外层缺口；投影待验证 | 先由 EventLog 的生命周期边界、线程与 usage/error 关联投影稳定 Turn。`endTurn` 清空运行标记不等于历史数据必然丢失。仅在无法重建 ID/归属/结果时补最小事实记录；不能从一个 `idle` 推断成功。[事件与 Items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)、[runtime adapter](../packages/session-runtime/src/adapter.ts) |
| 保存的 Item：message、tool/coordination call | `HistorySessionEvent`、`EventLogRepo`、`StreamRepo` | 外层缺口 | 优先把现有事件 ID 与最终内容投影为 Item；无需因此复制一套 Item 存储。为 `item_id`、索引、状态与 Turn 归属建立确定映射；仅在事实不足时补记录，不能每次 GET 生成新 ID。[事件与 Items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)、[事件领域](../packages/managed-agents-domain/src/sessions/event.ts)、[事件持久化](../packages/event-log/src/ports.ts) |
| live Events：完整文本与 delta；不回放遗漏流事件 | 公共 `event_start/event_delta`、历史事件查询；内部递增 seq | 部分匹配 | 输出 OpenAI 的事件 envelope；保留内部 seq 用于恢复，但外部按文档使用 session/items 快照恢复。done 携带完整文本、delta 可缺席；流关闭不等于取消或成功。[事件与 Items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events) |
| 当前 `required_actions`：`function_call` / `environment_connection` | `SessionStopReason.requires_action.eventIds`、custom tool-use、Environment Work | 部分匹配 | 由已有 tool-use/result 与 Work 投影可恢复的 pending actions，并测试完成后的消除；Session 的 `requires_action` 不能折叠成普通 idle；连接等待与函数等待不可互换。[管理会话](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage)、[停机原因](../packages/managed-agents-domain/src/sessions/event.ts) |
| Function 定义及客户端返回结果 | `AgentCustomTool`、`user.custom_tool_result` | 部分匹配 | `parameters` 映射 `inputSchema`；success/output/error 映射结果。OpenAI 用 `turn_id + call_id` 关联，OMA 当前为 `customToolUseId`；补跨 Turn 校验、重复提交及 pending action 清除。历史里有 call 不代表仍待执行。[Functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions) |
| `environment.type: none` | Session 要求 `environmentId`；`SessionMachineDeps` 要求 sandbox | 执行语义待验证 | 先检验现有 harness/工具组合能否不分配真实沙箱执行；只有强制依赖阻挡该路径时才改运行入口。不能偷偷创建默认沙箱。远程 MCP、客户端 functions 可工作；bash、patch、环境文件及环境内 MCP 不可用。[架构](https://developers.openai.com/api/docs/guides/agents-api/architecture)、[runtime dependencies](../packages/session-runtime/src/machine.ts) |
| 托管 Environment 实例与可复用 Template | `EnvironmentConfig.cloud`、Environment store、SandboxPort/provider | 部分匹配 | OpenMA Environment 更接近模板；先用已有 Session/Work/sandbox handle 组合映射实例 ID 与状态，不预设新增实例存储。`python/system/npm` 到 `pip/apt/npm` 可转换；setup、env、files、network 的完整语义要逐字段审计。[托管沙箱](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)、[Environment](../packages/managed-agents-domain/src/environments/environment.ts) |
| `self_hosted` Environment；executor 注册和 WebSocket 连接 | `EnvironmentConfig.self_hosted`、Work poll/ack/heartbeat/stop、Sandbox lifecycle ports | 部分匹配 | 执行和资源管理可复用；OpenAI `codex exec-server` 的注册/远程连接协议并不等于 CMA Work。若未实现协议不能返回可连接的 `remote_url` 或宣称兼容官方 executor。[自托管沙箱](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)、[Work port](../packages/managed-agents-application/src/ports/environment-work.ts)、[Sandbox ports](../packages/sandbox/src/ports.ts) |
| Environment 生命周期；连接等待与会话状态分离 | Work lease/fence、sandbox runtime/backup、Session status | 部分匹配 | 内部 lease/fence 可继续保护资源。外部需要 provisioning/connection/failure 的独立状态与错误。连接等待不是 durable input queue；Session 删除和客户 compute 退出分别处理。[生命周期](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle) |
| MCP：HTTP/stdio、连接来源、认证、工具筛选、初始化策略 | `AgentMcpServer` 仅 `name/type:url/url`；`AgentMcpToolset` 与权限配置 | 部分匹配 | 需要表达 `transport`、`connection_origin`、`allowed_tools`、`required`、`credential_id` 等。保留 service 与 environment 来源，stdio 不可伪装成远程 URL。[MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)、[工具领域](../packages/managed-agents-domain/src/agents/definition.ts) |
| Vault 与 bearer/OAuth Credential | `Vault`、`CredentialAuth.static_bearer/mcp_oauth`，refresh 配置，`vaultIds` | 匹配（核心类型） | 类型非常接近；仍要测试名称映射、secret 不回显、按 URL 选 credential、刷新/轮换。OpenAI Vault 针对 service-origin MCP，不可将 OMA 环境变量凭证隐式暴露给该合同。[Vaults](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults)、[Credential](../packages/managed-agents-domain/src/credentials/credential.ts) |
| Files 输入、Environment live files、Session immutable Artifacts | FilesApplicationPort、session resource 文件、Sandbox 二进制读写、session outputs mount | 部分匹配 | Files CRUD 能复用；Artifacts 需按完成 Turn 发布不可变副本并关联 turn/path。`/workspace/outputs` 与 OMA `/mnt/session/outputs` 不是同一路径合同；self_hosted 不通过 OpenAI Artifacts API 发布。[Files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files)、[Files port](../packages/managed-agents-application/src/ports/files.ts) |
| 动态 Subagent；并发上限；独立 context；共享环境 | `AgentMultiagent.coordinator` roster、`SessionThread`、thread events | 部分匹配 | 当前有真实线程原语，不需从零做多代理；但固定 roster 不等于 `enabled/max_concurrent_subagents`。补动态创建、message/wait/interrupt、分开的 Item/Turn 查询；与根共享一个环境；子代理不支持 function tools。[Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)、[SessionThread](../packages/managed-agents-domain/src/sessions/thread.ts) |
| Skills、Plugin archive、capability directories、环境模板 | AgentSkill、Skill/SkillVersion；环境包配置 | 部分匹配 | Skill 能复用；plugin 清单/ZIP、MCP 合并来源与目录发现需独立解析，不能将整个插件只当 prompt。模板复用配置，不复用执行实例。[Plugins](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins) |
| Web search、tool search、programmatic tool calling | `agent_toolset_20260401`；MCP/custom 工具；可替换 harness | 部分匹配 | 已有 web search 不等于所有工具协议匹配；`defer_loading`/tool discovery、代码编排等需要显式 capability 支持。未支持项必须明确拒绝，不能接受后忽略。[Functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)、[产品介绍](https://openai.com/index/introducing-the-agents-api/) |
| Webhooks 与 SSE 的不同 event families | 现有事件/Work wakeup 基础设施 | 部分匹配 | 单独审计签名、envelope、投递与幂等。Webhook 是 `agent.session.action_required`，SSE 是 `agent.session.requires_action`；不能共用改名表后直接发布。[Session webhooks](https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks) |
| Session/Turn token usage、推理/缓存分类 | `SessionUsage`、`SpanModelUsageView` | 部分匹配 | 补 Turn/子代理归属和 reasoning token 分类。unknown 保留 `null`，不变为零；避免缓存/推理重复求和。公开 trace retrieval 不能由 dashboard 私有接口反推。[Observability](https://developers.openai.com/api/docs/guides/agents-api/observability) |

MemoryStore、Outcome/Evaluation、Dream、Deployment、Tunnel 是 OpenMA 现有能力。本次读取的 Agents API 指南未给它们逐一对应的公开原语；保留为 OpenMA 自身能力，不为凑映射而制造 OpenAI 字段，也不能据此断言整个 OpenAI 平台完全没有相关功能。

## 外层转换优先；核心改动以失败证据为准

保留领域核心与 provider SDK 的隔离，HTTP adapter 接收官方 wire 格式，应用层只接收平台无关命令。现有 [API port 导出](../packages/managed-agents-api/src/ports.ts) 已把应用层作为边界来源，继续沿用。

下面列出的是外部合同需要的视图/行为，不是必须新增的持久层：

| 合同能力 | 优先复用的外层实现 | 何时才需修改核心 |
|---|---|---|
| 历史 Turn | 从 EventLog 的执行边界、thread 归属、usage/error 投影稳定 ID 与结果 | audit 证明重启后无法重建边界/身份，或缺少区分 completed/cancelled/failed 的事实 |
| Item | 使用已有事件 ID、内容、StreamRepo 状态构造 SDK Item 与分页 | audit 证明必要的内容/归属已被丢弃，且无法从现有事实恢复 |
| Required actions | 配对 tool-use/result，结合 Work 连接状态输出当前待办 | audit 证明重试、并发或恢复无法判定是否已完成，需要补最小幂等/关联事实 |
| Environment instance | 组合 Session、Work、SandboxRuntimeHandle 与模板配置输出执行实例 | audit 证明连接身份/状态无现有承载点，或官方 executor 协议要求缺失执行能力 |
| Artifact | 复用现有 Blob/Files/output 发布能力，输出 turn/path 关联与下载合同 | audit 证明现有输出只保留可变文件、无法提供不可变版本，才补发布快照/索引 |

不得因为 OpenAI 多一个资源 endpoint，就自动新增同名 domain aggregate、Port、表或服务。能在兼容层确定性转换的字段和资源视图，保持在外层；需要补公共应用查询时，也不等于必须改持久化结构。

一个内部事件可以生成多个外部视图，前提是 ID、归属和最终状态稳定。例如一次 `agent.message` 可对应 Item 的完成状态与 text-done 事件；不能为了拼出 API 返回值，临时伪造一个已经成功的 Turn。

## SDK audit：由外到内的验收层

现有 Claude 路径已用**官方 SDK → 自定义 fetch → 真 Hono adapter → 应用 Port fixture**做合同测试。可参见 [直接应用 Port 合同](../packages/managed-agents-api/test/direct-application-port.contract.test.ts)、[完整事件变体测试](../packages/managed-agents-api/test/session-events-exhaustive.contract.test.ts)。OpenAI 应平行建立同类入口，不让 OpenAI DTO 渗入 Claude adapter 或平台领域类型。

### 第 0 层：固定外部 oracle

- 固定官方 `openai` SDK 的可用版本，以及用于校验的官方源码/类型基线；检查真实 `beta.agents` namespace 和方法，不能以自写同名 client 代替。
- 生成/维护 method inventory：saved agents、sessions、events、items、turns、subagents、environments/templates/files、vaults/credentials、artifacts。
- 每个方法分别记录：SDK 存在、请求合同已审计、响应合同已审计、Port 适配、应用实现、runtime 实现、真实联调。用一项通过不能代表全部通过。
- TypeScript SDK 往往按类型返回 JSON，而不验证所有运行时字段；因此 audit 必须对响应必填字段、枚举、空值与分页 envelope 显式断言。

已发现一处指南/SDK 差异：Events 指南描述 root session items 可按 `turn_id` 过滤，但本次官方 `openai@7.15.0` 的 `sessions/items.ts` 中 `ItemListParams` 仅包含 cursor、limit、order。当前 audit 以固定 SDK 的实际请求面为准，单独记录该差异，不把指南描述当作该版本已支持的参数。

### 第 1 层：HTTP 与 SDK 可见合同

| 测试组 | 必测内容 |
|---|---|
| 入口隔离 | OpenAI `Authorization: Bearer` 与 `OpenAI-Beta: agents=v1`；base URL、route 与 HTTP method；不改变既有 Claude 入口 |
| 路由冲突 | 双方 saved agents 都使用 `/v1/agents`；明确独立 base path 或协议分流；`/agents/sessions` 不能被 `/agents/:id` 当作 agent ID 捕获 |
| JSON | request/response envelope、`object` 等 discriminators、SDK 正式字段、缺省/`null`/空列表区分；未支持字段明确失败 |
| 分页 | `after` / `limit` / `order`、`has_more` / `first_id` / `last_id`；用 SDK 自身 next-page/自动迭代跨页验证 |
| 错误 | SDK 可识别的错误 envelope；validation、not-found、conflict 的状态码；跨 session 的 turn/item/call 不可越界 |
| Streaming | create-stream 与独立 events stream；SSE framing；event family；delta 缺席仍有完整 done；订阅后再发输入不漏首事件 |
| 能力范围 | 不支持 environment、工具、plugin、reasoning/output 字段时返回清晰错误；不能以 2xx 丢弃用户配置 |

Quickstart 的最小合同包括 `beta.agents.sessions.create`、内联 agent、environment、initial input、`stream: true` 以及 beta header；这应成为首个外层用例。[Quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart)

### 第 2 层：应用语义

优先完成 Saved Agent/Vault 等可复用 CRUD，然后用现有应用与 EventLog 实现 Session、Turn/Item 查询投影，并验证无环境执行。针对生命周期至少覆盖以下轨迹：

1. 初始输入 → running → completed；重新读取可见同一 Turn 与 Items。
2. 运行中追加 message → 同一 Turn 的 steering；结束后追加 → 新 Turn。
3. function call → required action → 成功/错误结果 → 同一 Turn 继续；重复结果不二次执行；错误 call/turn 关联被拒绝。
4. cancel → turn cancelled；Session 保留且可继续。普通 idle、tool failure、stream close 都不伪造 completed。
5. 中断连接/应用重启 → session + items + pending actions 恢复；稳定 Item ID 不重复显示内容。
6. SDK 跨页检索所有 root/subagent turns/items，保证归属与 ordering。

### 第 3 层：runtime、沙箱与真实联调

先跑 `environment:none` 的文本/function 完整链路，再增加 hosted 环境实例、网络与 setup、live files 与 artifacts、MCP 来源/凭证、subagents。最后单独验证官方 self-hosted executor 的连接协议；这项不能从 CMA Work 测试成功推导。

安全边界直接属于合同：network `disabled` 不能映射 unrestricted；模板 override 不能拓宽网络权限；service-origin Vault secret 不得回显或进入 executor 文件/环境。相应测试应落在 adapter/应用和 provider 实现层，不能仅检查 JSON 字段存在。[托管沙箱](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)、[MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)

## 对工期与交付口径的影响

“SDK 能调用 Agent/Vault CRUD”与“Agents API 核心会话可用”应分开验收，但不能因资源名不一致就把后者估为核心重构。先交付 SDK audit 与外层转换，通过现有应用/事件数据验证 Turn、Item、required actions 和 Environment 视图；真正的核心工作量取决于这些测试暴露出的缺失事实或行为。

完整兼容还包括 self-hosted executor、发布 artifacts、动态 subagents、插件和工具发现。后续排期应以 audit 的实际覆盖与失败项目为依据；未实现项应保持显式缺口，不通过临时假数据把 audit 变绿。
