# OMA 密钥分层设计：自举秘钥 vs 租户出站凭据

**Date**: 2026-08-12
**Status**: Draft for engineering review

> 配套阅读：Layer B 的内部机制（OAuth 刷新、并发去重、审计）见
> [mcp-credential-architecture.md](./mcp-credential-architecture.md)；私有化部署总览与
> `oma-vault` sidecar runbook 见 [self-host.md](./self-host.md)。本文不重复这两篇，只讲
> **哪些秘钥该放哪一层**——这件事它们都没单独说清。

---

## TL;DR

OMA 的 **vault** 不是通用秘钥库。它的目标安全模型是 **不可信 agent/sandbox 永不在内存里持有明文**。
Managed harness-in-sandbox 的 MCP 走带当前 Work capability 的
`/v1/oma/mcp-proxy/<session>/<server>`；Cloudflare 透明出站走 runtime-fenced handler。
旧 `apps/oma-vault` 只按 hostname 注入，是本地/单操作员兼容路径，不是多租户安全边界。详见
`mcp-credential-architecture.md`。所以 vault
只覆盖一类秘钥：**agent/sandbox 代用户出站调外部服务时的凭据**（GitHub PAT、Linear/Slack OAuth、
MCP token）。

进程自举/平台身份秘钥——**飞书 App Secret、模型 provider key、DB 口令、服务间 internal token、
网关→main-node 的 API key**——不进 vault，走外部 secret manager 注入进程 env。其中最特殊的"根
密钥"（`PLATFORM_ROOT_SECRET` 等）甚至不能放进它所加密的那个数据库。

一句话判定法：**这份秘钥是"agent 代用户出站用"的吗？是 → vault。否则 → 自举层。**

---

## 为什么是两层（而不是"所有秘钥都进 vault"）

`docs/feishu-multi-agent-integration-prd.md` 的 Executive Summary 里有一句"飞书凭据和内部系统凭据
均由 OMA Vault 管理，不向 Agent 沙箱暴露"。后半句（不向沙箱暴露）是对的；前半句把范围说大了。
真相是分两层，理由有两条：

1. **vault 的注入模型对不上自举秘钥的用法。** vault 是 `apps/oma-vault`（mockttp MITM 代理，端口
   14322）按出站请求的 hostname 匹配 `mcp_server_url`、注入 header。而飞书 App Secret 是网关进程
   连飞书 WebSocket 的**自身身份**，模型 provider key 是 main-node 调 LLM 的**自身身份**——这里没有
   sandbox、没有 hostname 匹配，vault 根本插不上手。

2. **自举秘钥不能存它自己保护的库里（循环依赖）。** 决定性证据：vault 服务自己启动都是从 env 读
   配置的——`apps/oma-vault/src/index.ts:51-61` 读 `DATABASE_URL` / `OMA_VAULT_PORT` / `OMA_TENANT`。
   如果"进程启动需要的秘钥"要存在 vault 里，那 vault 自己启动时又去哪拿它的 DB 口令？所以自举层
   必然在 vault 之外。

---

## 两层模型

```
                    ┌─────────────────────────────────────────────┐
                    │  外部 secret manager / KMS                  │  ← Tier 0 根密钥也在这
                    │  (k8s Secret+Sealed / Vault Transit /       │
                    │   Infisical / Doppler / docker secret)      │
                    └───────────────┬─────────────────────────────┘
                                    │ 启动时注入 env
                       ┌────────────▼────────────────────┐
                       │  进程自举层 (Layer A)            │  main-node / 网关 / oma-vault 自己
                       │  • 模型 provider key             │  → env，或 /v1/model_cards 入库
                       │  • DB 口令                       │
                       │  • 飞书 App Secret（bot 身份）   │
                       │  • 服务间 internal token         │
                       │  • 网关→main-node API key        │
                       └────────────┬────────────────────┘
                                    │ main-node / oma-vault 持有
                    ┌───────────────▼─────────────────────────────┐
                    │  OMA vault (Layer B)                        │  D1 / PG / sqlite
                    │  type = static_bearer | mcp_oauth           │
                    └───────────────┬─────────────────────────────┘
                                    │ agent 出站时按 hostname 实时查库注入
                                    ▼
                              外部服务 (api.github.com …)
                    ┲━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┲
                      agent / sandbox 进程地址空间里没有任何明文凭据
```

| | Layer A：进程自举 | Layer B：租户出站 |
|---|---|---|
| **是什么** | 进程自己的身份与启动配置 | agent 代用户调外部服务时的凭据 |
| **谁在用** | main-node / 网关 / oma-vault 自身 | sandbox 里的 bash、agent 的 MCP 调用 |
| **注入点** | 进程启动时从 env 读 | 出站 HTTPS 按 hostname 实时注入 header |
| **OMA 现状** | env（`ANTHROPIC_API_KEY` 见 `apps/main-node/src/index.ts:526`） | OMA vault + `oma-vault` sidecar |
| **私有化落位** | 外部 secret manager → env；模型 key 可走 `/v1/model_cards` | 复用 OMA vault（白送） |
| **能否进 vault** | **否** | **就是 vault** |

---

## Layer A：进程自举秘钥（不进 vault）

### 子类与落位

| 子类 | 例 | 私有化落位 |
|---|---|---|
| 模型 provider key | Anthropic / MiniMax / OpenAI | `/v1/model_cards` 入库（替 env，见下），或 secret manager |
| DB 口令 | `DATABASE_URL` 里的密码 | secret manager → env |
| 平台身份 | 飞书 App Secret（bot 自身） | secret manager → env（单 org 一份） |
| 服务间身份 | 网关→main-node 的 API key | `/v1/api_keys` 签发（SHA-256 哈希），别用 `AUTH_DISABLED=1` / `oma_local_dev` |
| internal token | `INTEGRATIONS_INTERNAL_TOKEN` 等 | secret manager → env |

### Tier 0：根密钥（Layer A 内最特殊的子类）

`PLATFORM_ROOT_SECRET`（OAuth token 等落库敏感字段的静态加密根，见 `self-host.md:592`）、
`BETTER_AUTH_SECRET`、KMS master key——这一类是"王国的钥匙"，**绝不能放进它们所加密的那个数据库**。
只能放：

- 外部 KMS：HashiCorp Vault Transit / AWS KMS / GCP KMS / 阿里云 KMS；
- 或 k8s Sealed Secrets / SOPS（git 可存密文，集群内解密）；
- 高保障场景上 HSM。

判定：**如果某秘钥是用来加密库里其它敏感字段的，它就是 Tier 0，独立于一切。**

### 机制选项（按私有化成熟度递增）

1. `.env` + gitignore —— 仅本地 dev / spike（**当前飞书 spike 的层级，对的，但只到此为止**）。
2. k8s Secret —— 最小代价的私有化起点；配 Sealed Secrets / SOPS 可入 Git。
3. docker secret / Infisical / Doppler —— 多主机、有轮换与审计。
4. 外部 KMS + 短时凭据 —— 最终态，爆炸半径最小。

### 模型 key 的可选升级：从 env 挪进 `/v1/model_cards`

main-node 现在从 env 读 `ANTHROPIC_API_KEY`（`apps/main-node/src/index.ts:526`）。私有化可改为把
provider key 作为 model card 入库（`/v1/model_cards` CRUD，`/key` 取明文，见 `self-host.md:545`），
好处：可轮换、可审计、可按租户分配。落地前需确认 model card 的静态加密用的是哪个根密钥（应纳入
Tier 0 管控）。

---

## Layer B：租户出站凭据（OMA vault）

完全复用现成能力，不在本文展开。完整 runbook（建 vault → 加 `static_bearer` 凭据 → sandbox 自动
注入）见 `self-host.md:386-435`；OAuth 刷新 / 并发去重 / 审计日志见 `mcp-credential-architecture.md`。

**飞书集成什么时候才会用到 Layer B？** 只有当 triage 专家 / Supervisor 将来要**替用户**调外部 MCP
（GitHub、内部 CMDB API 等）时。当前专家只调 LLM（走 Layer A 的模型 key），不需要 vault。

---

## 飞书集成的具体落位

| 秘钥 | 层 | 私有化动作 |
|---|---|---|
| `FEISHU_APP_SECRET` | A | secret manager → 注入网关 env。**别再让它出现在任何 `.env` 里被工具读屏** |
| `FEISHU_APP_ID` | A | 同上（非密钥，但一并走配置） |
| 网关→main-node 鉴权 | A | `/v1/api_keys` 签发真 key，**去掉 `AUTH_DISABLED=1` 与 `oma_local_dev`** |
| 模型 provider key | A | 优先 `/v1/model_cards`；否则 secret manager |
| 专家/Supervisor 调外部 MCP（将来） | B | OMA vault + `oma-vault` 注入 |

---

## 已知限制 / 不在范围内

- **`oma-vault` 跨租户串 token / 可绕过**：两个租户都给同一 host（如 `api.github.com`）注册凭据时，
  hostname-only 查询无法安全归因；进程还可以忽略 proxy env。即使设置 `OMA_TENANT`，也只适用于
  单租户、可信本地调试。多租户必须走 Work-scoped HTTP MCP gateway，或使用经过网络隔离与 runtime
  fence conformance 的 provider adapter。
- **`command_secret` 仍进沙箱 env**：如 `GIT_TOKEN` 这类按命令注入 env 的，仍是沙箱内可见（AST 门控，
  但定向 prompt injection 仍可能泄）。详见 `mcp-credential-architecture.md` 的 "What this DOESN'T
  cover"。**别**把高爆炸半径的凭据（组织级 PAT、生产 DB 口令）挂到处理不可信输入的 agent 上。
- **`.env` 防的是 commit，不防"会话读屏"**：`.env` + gitignore 只挡住误提交；挡不住工具在会话里把
  文件内容读出来贴进 transcript。本轮飞书 App Secret 就是通过 file-modification 自动展示 hook 进入
  上一段 transcript 的。缓解：(1) 泄漏后立即轮换；(2) 会话里不 `cat` / 不 Read `.env`，需要值时用
  `read -s` 由人输入；(3) 私有化用 secret manager + 短时凭据缩小爆炸半径。

---

## 与其他文档的关系

- [mcp-credential-architecture.md](./mcp-credential-architecture.md) —— Layer B 内部机制（OAuth 刷新、
  并发去重、审计、deploy 顺序）。
- [self-host.md](./self-host.md) —— 私有化部署总览、Postgres/多副本、`oma-vault` sidecar runbook。
- [feishu-multi-agent-integration-prd.md](./feishu-multi-agent-integration-prd.md) —— 本设计修正该 PRD
  Executive Summary 中"飞书凭据和内部系统凭据均由 OMA Vault 管理"的表述：分清"平台身份（Layer A，
  不进 vault）"与"agent 代用户出站（Layer B，进 vault）"。PRD 的"不向 Agent 沙箱暴露"目标不变，只是
  不同秘钥类用不同手段达成。

## 参考

- `apps/oma-vault/src/index.ts` —— Layer B 注入代理；自举 env 读取（L51-61）、跨租户限制（L194-203）
- `apps/main-node/src/index.ts` —— Layer A 模型 key 读取（L526）
- `packages/vaults-store` / `packages/credentials-store` —— Layer B 存储
- `packages/vault-forward` —— hostname 匹配 + 注入 + 401 刷新的纯函数
- `packages/http-routes/src/vaults/index.ts` —— `/v1/vaults` + `/credentials` REST
