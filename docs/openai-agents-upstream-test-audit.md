# OpenAI 上游测试与本地 Node 验收

审计日期：2026-09-11。子代理执行采用 [Codex V1 默认单层兼容基线](./openai-agents-compatibility-status.md)。
下列上游测试为源码审计，本轮没有运行 OpenAI 线上测试，也没有编译运行上游 Rust 测试。

## Codex harness 的公开测试

固定源码：`openai/codex@02a8f038b87ad34d4a1dc5058eda26972ed7aa6c`。

| 测试 | 实际边界 | 对本项目的用途 |
| --- | --- | --- |
| [subagent_notifications.rs](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/tests/suite/subagent_notifications.rs#L424-L488) | 运行真实 Codex harness，通过本地 WireMock / SSE 生成模型的 spawn 调用及子代理响应；V1 场景包括子代理创建、上下文和完成通知 | 可对照行为设计本地测试；测试入口是 Rust harness，不能直接改成我们的 Agents API baseURL 来运行 |
| [multi_agent_resume.rs](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/tests/suite/multi_agent_resume.rs#L168) | 真实 harness 配合本地模型响应，验证冷恢复后的身份、角色及后续消息；该文件使用 V2 场景 | 可参考持久化和恢复断言；V2 嵌套等场景不算本阶段 V1 范围 |
| [live_cli.rs](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/tests/suite/live_cli.rs#L1-L4) | 可选、默认忽略的真实 CLI / 模型 smoke；调用 OpenAI `/v1/responses`，检查创建文件和输出工作目录 | 是真实模型测试，但不是托管 Agents API 的 `/v1/agents/sessions` 兼容测试 |

V1 完成通知用例的明确断言见
[`subagent_notification_is_included_without_wait`](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/tests/suite/subagent_notifications.rs#L949-L976)。
这是可参考的上游行为，不表示本项目已通过该 Rust 测试或已验证完全相同的模型提示协议。

上游真实模型 smoke 的源码给出如下运行方式，需要其完整构建环境及有效的 API key：

```sh
just test -p codex-core --test all --run-ignored only live_cli
```

## 官方 JavaScript SDK 的公开测试

固定源码：`openai/openai-node` 的 `v7.15.0`，commit
`50eb4b26fc4a70ac355aff5d822e250602faa1e5`。

| 测试 | 实际边界 | 能否直接指向 OpenMA |
| --- | --- | --- |
| [beta.agents 资源测试](https://github.com/openai/openai-node/blob/50eb4b26fc4a70ac355aff5d822e250602faa1e5/tests/api-resources/beta/agents/sessions/subagents/subagents.test.ts) | 官方 SDK 对 Steady OpenAPI mock 的生成测试，检查调用与响应包装；[启动脚本](https://github.com/openai/openai-node/blob/50eb4b26fc4a70ac355aff5d822e250602faa1e5/scripts/test#L136-L166)确认 mock 边界 | 有 `TEST_API_BASE_URL`，但凭证、资源 ID 和模型是占位符；必须补实际资源创建、认证和行为断言，不能只换 URL 就视为生命周期 E2E |
| [agent-session-stream.test.ts](https://github.com/openai/openai-node/blob/50eb4b26fc4a70ac355aff5d822e250602faa1e5/tests/lib/agent-session-stream.test.ts#L51-L98) | 注入自定义 `fetch` 和合成 SSE；验证订阅先于输入、选定协调者终态、function handler、重试幂等及取消清理 | 是 SDK helper 单测；自定义传输截获所有请求，修改 baseURL 不会转为服务端验收 |

SDK helper 测试可在上游依赖安装完成后运行：

```sh
pnpm test:unit tests/lib/agent-session-stream.test.ts
```

在上述已核对的公开代码中，没有找到一套只替换 Agents API baseURL 就能完整验收
OpenMA 的真实服务 E2E。可复用上游测试的场景与断言；本项目仍需通过官方 SDK
访问实际 Node 服务，验证持久化、工具执行与生命周期。上游测试存在不等于本项目
已经通过上游测试，本轮也未运行这些上游 SDK 测试。

## OpenMA 自维护 E2E

本项目自行维护服务端验收，不依赖复制上游生成测试。运行入口：

```sh
pnpm run test:e2e:openai-agents
```

该命令先用固定版本官方 SDK 检查测试类型，再运行真实 Node 进程、SQLite 和
本地脚本模型构成的完整调用链。场景包含资源持久化与删除、配置快照、敏感字段
脱敏、函数调用重启恢复、同一子代理重启后继续对话、SDK 自动回填工具结果、
流式输出与取消。测试通过官方 SDK 访问 HTTP 服务，不拦截 SDK 的 fetch。

事件流按官方接口提供新事件；断线期间的历史通过 Items/Turns 补读，不增加官方
SDK 没有声明的 `after` 参数。模型响应由本地服务控制，无环境场景不会启动真实
沙箱，不计作真实模型或托管 OpenAI 服务联调。测试路径、维护方法及覆盖范围见
[E2E 说明](../apps/main-node/test/openai-e2e/README.md)。

发布候选的 12 个真实进程场景均通过，包含在 68 项 Node 专项与 runner 回归中。
最初的启动超时已调整测试等待预算；遗漏的本地路径转换已补齐，受影响的
18 项复测通过。E2E 用法同时通过固定版本官方 SDK 的类型检查。

## 首轮本地 Node 验收记录

从本仓库根目录运行：

```sh
pnpm run test:openai-agents:node
```

本轮实际运行其等价命令，避免依赖安装隐式变更：

```sh
cd apps/main-node
../../node_modules/.bin/vitest run --config vitest.config.ts test/openai test/acp-subagents-openai.test.ts test/managed-host-tool-errors.test.ts test/managed-session-subagents.test.ts
../../node_modules/.bin/tsc --noEmit
```

结果：9 个测试文件、46 项通过，Node 类型检查通过。生产 Node 入口、临时 SQLite、
本地 HTTP 脚本模型和官方 OpenAI SDK 构成实际调用链；模型响应受控生成，不是线上模型。
随后在真实进程测试中补充 V1 工具开放断言：父模型收到 `create_subagent`，全部
子模型请求都不含六种子代理控制工具；仅重跑该测试文件，3 项通过。

[`openai-agents-node.test.ts`](../apps/main-node/test/openai-agents-node.test.ts)
验证六种子代理控制、独立父子历史、三个完成 Turn 和一个取消 Turn、函数工具不继承，
以及无环境启动、函数暂停 / 恢复和幂等。
[`managed-session-subagents.test.ts`](../apps/main-node/test/managed-session-subagents.test.ts)
补充共享 sandbox、后续父 Turn 恢复子代理、排队、定向中断、并发、父取消和失败隔离。
ACP 的嵌套测试验证事件投影，不计为 Node 递归执行验收。
