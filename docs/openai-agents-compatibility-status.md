# OpenAI Agents API 实现与验收状态

固定外部合同：官方 `openai@7.15.0`，审计日期 2026-09-11。

当前子代理兼容声明：**支持 OpenAI Agents API 子代理接口，采用 Codex 多代理
V1 默认的单层执行语义。** 主代理可创建、发送输入、等待、中断、关闭和恢复
子代理；子代理拥有独立上下文并共享父环境，不获得继续派生工具。
本阶段不包含递归执行，ACP / common 仍保留上游提供的嵌套关系。
这里的 V1 是所选子代理执行基线，不是 `OpenAI-Beta: agents=v1` 协议头的含义，
也不表示已经确认 OpenAI 托管服务内部使用 V1。其他运行能力按下表分别验收。

范围调整：按用户要求，官方 `codex exec-server` 的远程 executor 接入协议不在
本次目标内。执行继续复用 OpenMA 自己的 runtime / sandbox。后续优先复用原生
default harness，ACP 是可选执行路径；下面“当前 Node 限制”不代表整个平台
缺少相应原语或执行能力。

实现采用「官方 SDK audit → HTTP 合同 → 语义映射 → 原生应用 / SQL → Node
runtime」的顺序。主要转换在外层完成，没有新增 OpenAI 专用 Session / Turn /
Item 表，也没有复制执行器或维护第二套会话事实。

独立服务端回归入口：`pnpm run test:e2e:openai-agents`。测试与维护说明见
[OpenMA 自维护 E2E](../apps/main-node/test/openai-e2e/README.md)。

## 已落地的边界

| 层 | 实现 | 证据与限制 |
| --- | --- | --- |
| SDK inventory | 43 个 SDK 方法、44 个场景；42 个 HTTP operation | 固定官方 SDK 请求基线及新增方法检测；不是运行能力认证 |
| HTTP | 全部上述 operation；请求 / 响应 union 验证、分页、错误、SSE、二进制 | 真实 SDK 调用完整 Hono router；显式校验 JSON，不能依赖 SDK 替服务端校验 |
| 资源 | Agent、模板、Vault、Credential 复用原生 CRUD | 原生字段为准；仅补存无法直接表达的配置，不再维护资源镜像 |
| Session 语义 | 初始输入、继续、取消、function result、Turn / Item / 子线程视图 | 从有序原生事实重放；真实 SQL 重开连接后身份和归属稳定 |
| 并发与幂等 | 原生输入身份去重、Session revision 条件接收 | 相同 key 不二次执行；不同 payload / 已过期 pending 校验返回 409 |
| SSE | create-stream、独立订阅、官方 subscribe-before-input helper | 完整文本 done；断开只结束订阅；真实 HTTP 验证订阅不会阻塞后续 POST |
| Node 入口 | `/openai/v1`，现有认证和 workspace 范围 | 与现有 `/v1` Claude 路径并列挂载 |
| 无环境执行 | `none` 走无资源分配的 sandbox 适配对象 | 真实 Node 进程验证初始输入执行、函数暂停 / 续跑；不创建物理沙箱 |
| 动态子代理（V1 默认单层基线） | Node 的 create / send / wait / interrupt / close / resume 接到原生 Thread 和事件事实 | 官方 SDK 经真实 Node / SQL / 本地模型服务验证独立历史、继续执行、定向中断、关闭和恢复；函数工具不传给子代理，子代理不获得继续派生工具 |
| ACP 子代理投影 | 复用 common 的 WorkItem / 父子语义及 ACP 解码 | Claude / Codex 子代理证据、canonical agent work item 转为原生线程事件；跨层验证 native codec / 严格 history / OpenAI projection |
| 环境文件 | 连接到真实 SandboxPort 的二进制写入与目录列表 | 不连接时明确失败；不以本地内存文件表模拟成功 |
| Artifacts | 原生不可变 File 及明确 origin；列表 / 查询 / 下载 / 删除 | Node 在完成事实提交后发布 `/workspace/outputs`；仅精确 execution 完成的 root Turn 可发布，重试复用已有 origin |

SDK 入口见 [compat README](../packages/openai-agents-compat/README.md)。
核心验收入口为 `pnpm run test:openai-agents`；Node 进程与 runtime 验收入口为
`pnpm run test:openai-agents:node`。测试中的本地模型服务用于确认真实调用链，
不等于已用 OpenAI 托管服务或每种部署 provider 完成联调。

发布候选在独立工作树中重新验证，排除了其他任务未提交的部署与 Memory 改动：

| 检查 | 结果 |
| --- | --- |
| 固定 SDK 审计 / HTTP / 语义适配 | 61 / 93 / 73 项通过 |
| Node 专项与 runner | 68 项通过；受影响的 18 项在补齐路径转换和启动等待后复测通过 |
| 自维护真实进程 E2E（包含在 Node 专项内） | 12 个场景：资源、函数回填、子代理、重启恢复、流式输出和取消 |
| ACP 子代理投影 | 4 项通过 |
| SQL 顺序、历史与 Session 持久化 | 23 项通过 |
| 原生 Thread、子事件、输入幂等与 File 合同 | 24 项通过 |
| 本地 sandbox 路径、进程与文件回归 | 8 项通过 |
| 网页 | 14 页构建、7 项测试及 Astro 类型检查通过 |

OpenAI API / compat、ACP、Node、E2E SDK 用法和 sandbox 类型检查通过。
冻结锁文件安装、核心依赖边界及 diff 检查通过。上述测试使用本地受控模型，
不计作真实 OpenAI 模型或物理沙箱供应商联调。
测试的运行方式见 [自维护 E2E](../apps/main-node/test/openai-e2e/README.md)，
公开测试的参考范围见 [上游测试审计](./openai-agents-upstream-test-audit.md)。

## 核心仅补现有事实的最小承载

- 现有事件 JSON 加入内部 `source_position`，保存提交 revision / 批内序号和
  execution 关联；公共原生事件响应移除该内部字段。无需新增事件表。
- 现有 Session revision 用于同快照 pending 校验和接收 CAS。
- 幂等 key 派生稳定的原生输入事件 ID，复用事件持久化与执行 outbox。
- Session 创建事务同时写入已有执行 outbox，修复初始输入只保存却不执行的
  缺口；多个初始消息属于同一次执行，不向普通事件日志重复追加输入。
- 现有 File JSON 可保存 session / environment / turn / path origin，与字节
  快照一起发布。普通上传文件不会自动成为 Artifact。
- 无法可靠恢复顺序的旧事件不做猜测：直接查询返回明确的 409，集合查询跳过
  此类旧会话；不把排序歧义解释成成功状态。

这些改动补充丢失的信息或使用已有并发控制。OpenAI 的 Turn / Item 仍然只是
确定性的外层视图。[原语审计](./openai-agents-primitives-audit.md)与
[事件投影审计](./openai-agents-event-projection-audit.md)保留最初的问题分析。

## 尚不能宣称完整运行兼容的能力

HTTP 面完整覆盖不代表下面能力已由当前 Node runtime 实现。创建配置可以完整
保留；使用未落实的配置创建 Session 时会明确拒绝，而不是忽略后返回成功。

| 能力 | 当前 Node 限制 |
| --- | --- |
| Hosted 高级环境配置 | packages、env、setup、输入文件注入、plugins、skills、capability directories 及限制网络配置尚未接通 |
| reasoning / service tier | 显式 effort、summary、fast 等需要现有模型执行链实际消费；仅保存原生字段不足以认证 |
| 输出与工具扩展 | structured output、非默认 verbosity、tool search、defer loading、programmatic tool calling 尚未接通 |
| MCP 扩展 | stdio、environment origin、显式 headers / credential selection、required initialization、request metadata 尚未接通 |
| Web search 扩展 | cached / 非默认 context size；无环境路径的原生 web search 尚未支持 |
| Webhooks | 不属于这版 SDK 的 42 个 HTTP operation；签名和持久投递仍需独立验收 |

## 补齐路线：原生能力优先，ACP 共用

原生 default harness 已有 subagent：
[tools.ts](../apps/agent/src/harness/tools.ts) 注册 `call_agent_*` 和
`general_subagent`；[SessionDO.runSubAgent](../apps/agent/src/runtime/session-do.ts)
创建持久线程、独立消息上下文和中断控制，子代理共享 sandbox，可选择 default
或其他 harness。本轮 Node Managed Session 已向 `buildTools` 传入
`delegateToAgent` 和原生线程控制，`archiveThread` 接到定向停止；OpenAI 的
动态子代理工具调用这些原生控制，继续复用 Session / Thread / Event 存储。

| 补齐项 | 实施路径 |
| --- | --- |
| Node 原生委派 | 已接入委派回调、独立线程历史、共享 sandbox、定向停止及父执行的取消 / 完成屏障；线程配置保存在原生 Thread，生命周期从原生事件重放 |
| OpenAI 动态子代理 | 已接六种控制与官方 coordination Items，落实并发上限和独立上下文。OpenAI 子代理保留父代理 MCP / web 配置，移除客户端 function；旧 SessionDO general 工具配置保持原有行为 |
| Skills / plugins | Node 与 ACP 都已有技能下载 / 解包 / 挂载基础。把 OpenAI inline / reference 配置接入它们；插件 ZIP 解析 manifest 后展开成 files、skills、MCP，再由对应 harness 加载 |
| MCP | 复用现有 gateway / Vault，补 headers、credential selection、required 初始化；environment-origin stdio 在环境启动。ACP 可通过 `mcpServers` 接入，原生 default 走现有工具注册 |
| 模型与输出配置 | 原生 harness / 模型 adapter 落实 effort、output schema 等；ACP 初始化后通过实际返回的 `configOptions` / `setConfigOption` 设置支持项。`_meta` 仅传输配置不证明执行，strict schema / service tier 需由具体 provider 保证 |
| tool search / deferred loading / programmatic calling | 在所选 harness 的工具注册、检索和执行回路补语义，复用原生事件；ACP 负责连接该 harness，不能仅因接入 ACP 就视为已有这些工具能力 |
| 环境和发布 | env、files、setup、packages、network 接现有环境准备与 provider；Artifacts 和 webhooks 继续由 host 负责，不放进 ACP transport |

插件的来源格式见 [OpenAI 官方插件文档](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins)，
子代理独立上下文、共享环境与工具继承见
[OpenAI 官方多代理文档](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)。
`capability_directories` 需要能力发现与加载，不能只改名为 ACP 的
`additionalDirectories`（额外工作目录）。

`@openma/common/session-events/openma` 已有 harness-neutral 的统一语义：
`WorkItemKind = "agent"`、`work_item.*` 生命周期、`session_thread_id` /
`work_item_id` / `parent_id` 关联，以及带去重、排序和终态处理的 WorkItem reducer。
子代理适配应复用这些定义和已有线程事实，不另建一套子代理领域模型。

ACP 也已有子代理适配：共享 runtime 声明 `subagent-transcript`，共享
`session-events/acp.ts` 对文本、思考和工具保留 `parentToolUseId`，并有对应回归
测试。应复用这些实现，不能把下游漏接描述为“ACP 没有 subagent 适配”。
统一事件语义并不自行执行 create / send / wait / interrupt；这些操作需要接到
已有线程控制和对应 harness，并以实际生命周期行为验收。

`ManagedAcpEventProjector` 已保留 child / parent 关联，并区分子线程完成、
中断和关闭。对未提供身份与生命周期证据的未知 ACP 扩展，不推断子代理成功。
ACP 外部 function result 在控制适配中仍是普通提示文本，需要独立补正确回填；
原生 default 的 function 暂停 / 续跑继续复用已有验证路径。

Node 动态子代理与 ACP 子代理事件桥接已落地；后续仍需补
skills / plugins / MCP 的配置与准备，并按每个 harness 的实际能力补模型与工具
扩展。每项都用官方 SDK 触发真实行为，验证后解除对应配置限制。
嵌套子代理有明确的接口依据：固定的 `openai@7.15.0` SDK 在
`resources/beta/agents/sessions/subagents/subagents.d.ts` 的 `Subagents.list`
注释中写明列表包含 nested / closed subagents；`Subagent.parent_agent_id`
记录创建者。这证明接口需要保留嵌套关系，但不能据此推断允许无限递归，
已核对的 [multi-agent 指南](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)
和上述 SDK 类型未明确派生深度规则。
本轮 Node 执行控制覆盖主代理派生一层子代理，子代理继续派生尚未接入；
ACP / common 投影则已可保留上游提供身份的嵌套父子关系。
本阶段已选择 V1 默认单层行为作为兼容基线，递归执行不在本阶段范围内。
列表支持嵌套数据、开源代码存在递归分支，都不能单独证明托管 API 向子代理
开放了 spawn 工具。未来扩展递归时仍复用现有线程控制与父子语义。

开源 harness 执行边界已核对到 `openai/codex` commit
`02a8f038b87ad34d4a1dc5058eda26972ed7aa6c`。其
[子代理创建路径](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/agent/control/spawn.rs#L684-L720)
向新 Thread 传入同一个 `AgentControl`，并
[继承父 Thread 的 environment 绑定](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/agent/control.rs#L780-L800)。
`ThreadManager` 为各 Thread 创建独立的内部 `Session`，各自的
[Session loop 由 `tokio::spawn` 启动](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/session/mod.rs#L863-L880)。
这条开源路径是同一 harness 进程内的多个独立运行时；内部 `Session` 不能与
Agents API 的 Session 资源混为一谈。API 子代理仍归属同一个 API Session，
官方指南明确主代理与子代理共享 environment 文件系统，创建子代理不会新建
environment。当前原生 Session / Thread / 共享 sandbox 的映射与这一边界一致，
递归本身不要求跨节点调度，也不要求创建新的 API Session。

该提交的递归策略还区分 V1 / V2：V1 校验 `agent_max_depth`（默认 1，可配置），
按默认值，一级子代理不会注册协作工具组，因此拿不到 spawn 工具；
[配置注释明确 V2 忽略该深度项](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/config/src/config_toml.rs#L691-L692)，
V2 子代理的[协作工具准入](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/tools/spec_plan.rs#L648-L658)
则检查模型是否支持 MultiAgentV2；源码也有
[V2 子代理继续派生的测试](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L2370-L2420)。
该测试直接调用 handler，证明特定配置下的实现能力，不是线上模型获得并调用
spawn 工具的证据。此前引用的共享 environment / 新 Thread 创建路径也只证明
子代理被创建，不能单独用来证明子代理能继续创建下一层。
这些是固定开源提交的实现证据；尚无证据确认 Agents API 线上使用哪个分支及配置，
不能把 V1 默认一层或 V2 忽略该深度项直接写成托管 API 的保证。

子线程配置写入受父 execution fence 约束，线程生命周期与 Session 事件在现有
SQL 投影事务内更新。配置插入和 `thread_created` 事件仍是两个提交：若租约在
二者之间失效，可能留下未公布的原生线程快照；后续事件与执行仍会被 fence 拒绝。
这不应表述成子代理创建端到端 exactly-once。OpenAI 子代理视图以已提交事件为准。

Artifact 发布还有明确的可靠性边界：Turn 提交与逐个 File 上传不是一个原子
事务，fence 检查也不与 File 写入共用事务；现有 origin 查询去重不能证明跨
进程 exactly-once。发布中断可能留下部分文件，目前没有崩溃后的持久发布重试。
发布失败会记录服务端错误，不将已完成的模型执行改成 failed。

本次 API、compat 和 Node 的类型检查通过。原生 application 全包类型检查仍有
既有 `environment-work-application.test.ts` fixture 缺少 `generation` 的错误；
本次未修改这些无关测试，不能据此声称整个工作区所有检查均通过。

因此当前应表述为「完整 SDK / HTTP 面已建立，原生语义适配及 Node 文本 / 函数 /
子代理主链路已验证」，不能标为「所有 Agents API 运行能力 100% 兼容」。后续工作应补上述
具体执行能力并加入 audit，不需要先引入一套 OpenAI 领域模型。
