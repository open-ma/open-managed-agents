# Lanes —— 临时性的并行部署

**Lane** 是把 OMA 的三个 Cloudflare Worker（`main`、`agent`、`integrations`）以独立的 worker 名复制一份部署出来，用于短期的、按 PR / 按特性维度的测试。**Lane 的代码是隔离的；Lane 的数据则与 staging 共享**（绝不与 prod 共享）。

## TL;DR

```bash
# 从当前分支部署一条名为 "pr-123" 的 lane
gh workflow run deploy-lane.yml \
  -F lane_name=pr-123 \
  -F confirm_shared_data=true

# Lane 的访问地址：
#   https://managed-agents-lane-pr-123.<CF_SUBDOMAIN>.workers.dev

# 用完后回收
gh workflow run teardown-lane.yml \
  -F lane_name=pr-123 \
  -F confirm=true
```

## 隔离了什么、共享了什么

| 资源 | Lane 表现 | 备注 |
|---|---|---|
| Worker 代码 | **隔离** | 每条 lane 跑自己的 `git_ref` |
| `SESSION_DO` 存储 | **隔离** | 每个 worker 有独立的 DO namespace；lane 的会话对 staging / prod 不可见 |
| `Sandbox` 容器 | **隔离** | 每条 lane 都构建并运行自己的 sandbox 镜像 |
| `CONFIG_KV` | 与 staging 共享 | 租户数据、agent 配置、vault 快照 |
| `AUTH_DB`（D1） | 与 staging 共享 | 用户、agents、environments、sessions 元数据（库名 `openma-auth-staging`） |
| Integrations D1 | 与 staging 共享 | OAuth token、GitHub 安装凭据 |
| `FILES_BUCKET` / `WORKSPACE_BUCKET` / `BACKUP_BUCKET`（R2） | 与 staging 共享 | （R2 桶在物理上和 prod 是同一个，但 lane 这边的写入只来自 staging 代码路径） |
| `VECTORIZE`（memory-search） | 与 staging 共享 | 记忆库的 embedding |
| `AI`、`BROWSER`、`SEND_EMAIL` | 共享（账号级 CF binding） | |
| 限流 namespace | 与 staging 共享 | Lane 流量计入 staging 的限流计数，而不是 prod 的 |
| Analytics dataset（`oma_events_staging`） | 与 staging 共享 | 所有 lane 的事件都落到这里，与 prod 的 `oma_events` 隔离 |
| Cron 触发器（`* * * * *`） | **lane 上禁用** | Lane 的 main worker 不会跑 eval-runner |

## 风险（部署 lane 之前你必须读懂这些）

1. **Lane 写 staging 数据是真实的 staging 写入。** Lane 上的一次问题迁移会和「上线一个有 bug 的 staging 版本」一样污染 staging KV / D1。**别在 lane 上跑你不敢在 staging 上跑的破坏性代码。**
2. **D1 schema 必须与 staging 已部署的兼容。** Lane 代码只能看到 `openma-auth-staging` 中已经存在的列。先在 lane 上加列、再部署读取它的代码——lane 会直接 500。
3. **Linear / GitHub / Slack 的 OAuth 回调** 由你 lane 的 `integrations` worker 接收时，会写入 staging 的 integrations D1。如果 lane 代码动了 token 存储相关逻辑，可能会把 staging 的会话搞挂。
4. **限流是按 `namespace_id` 全局计的。** 一条行为异常、不停打 `/v1/sessions` 的 lane，会吃掉 staging 的 `RL_SESSIONS_TENANT` 配额。
5. **Sandbox 容器成本会被放大。** 每条 lane 都会有一个独立的 `sandbox-default-lane-<name>` worker，自己的容器镜像，`max_instances: 50`。同时活着的 5 条 lane = 最多 250 个潜在容器实例。
6. **及时回收。** Lane 不会自动过期（除非 `reclaim-lanes` 在 UTC 03:17 跑、且阈值是 7 天）。否则陈旧的 lane worker 会一直留着 DO 存储行。

## 工作原理

[`scripts/lane-generate.mjs`](scripts/lane-generate.mjs) 会读取每个生产环境的 `wrangler.jsonc`，把 `env.staging` 块以深合并方式覆盖到顶层（替换资源 binding 与 analytics dataset），然后做一系列改写：

- 给每个 worker 设置唯一的 `name`（带 `*-lane-<name>` 后缀）
- 重新绑定 `services` 数组，让 lane worker 之间互相指向 lane 同伴
- 把 `vars.INTEGRATIONS_ORIGIN` / `vars.GATEWAY_ORIGIN` 设为 lane 自己的 workers.dev URL（lane 的 Linear webhook 落到 lane，而不是 staging）
- 把 `vars.TURNSTILE_SITE_KEY` 设成 Cloudflare 官方的「永远通过」测试值
- 移除 `routes`（lane 用 workers.dev，没有自定义域名）
- 移除 `triggers.crons`（lane 上不跑 eval-runner）
- 移除 `env.*`（lane 配置是扁平的，不再嵌套 env）

输出文件落在 `apps/<worker>/wrangler.lane-<name>.jsonc`（已 gitignore）。

## 本地 dry-run

```bash
CF_SUBDOMAIN=youraccount node scripts/lane-generate.mjs my-test --check
```

`--check` 只打印「将会写什么」，不会动磁盘。在真正花 deploy 钱之前用它来验证 lane 配置长什么样很有用。

不带 `--check` 时，同一条命令就会写出三个 lane 的 jsonc 文件；可以再用 `cat apps/main/wrangler.lane-my-test.jsonc | jq .` 检查。

## 部署机制

`deploy-lane.yml` 工作流做的事：

1. Checkout 指定的 `git_ref`
2. `pnpm install` + 构建 console（lane 的 main 需要 `apps/console/dist`）
3. 用 repo vars 里的 `CF_SUBDOMAIN` 调用 `lane-generate.mjs`
4. 按 integrations → agent → main 的顺序 `wrangler deploy`（这个顺序保证 service binding 在部署时能解析）
5. 通过 `wrangler secret put` 把必要的 secret（`API_KEY`、`ANTHROPIC_API_KEY` 等）从 repo secrets 注入
6. 对 lane 的 main URL `curl /health` 确认绿

CI 必须配置（`deploy.yml` 也已经在用）：
- `vars.CF_SUBDOMAIN` —— 你 Cloudflare 账号的 workers.dev 子域
- `vars.CLOUDFLARE_ACCOUNT_ID`
- `secrets.CLOUDFLARE_API_TOKEN`
- `secrets.API_KEY`、`secrets.ANTHROPIC_API_KEY`、`secrets.BETTER_AUTH_SECRET`、`secrets.INTEGRATIONS_INTERNAL_SECRET`、`secrets.MCP_SIGNING_KEY`、`secrets.INTERNAL_TOKEN`
- 可选：`secrets.ANTHROPIC_BASE_URL`、`secrets.TAVILY_API_KEY`

Lane 使用 Cloudflare 公开的「永远通过」Turnstile key（site `1x00000000000000000000AA` / secret `1x0000000000000000000000000000000AA`），这两个值硬编码在 `lane-generate.mjs` 和 `deploy-lane.yml` 里，让 `/auth/*` 流程不依赖把 prod 的真实 Turnstile secret 暴露到 lane。**不要在 lane 上用敏感凭据注册账号——AUTH_DB 与 prod 共享，用户记录会持久存在。**

如果某个 secret 不在 repo 里，部署步骤会静默跳过它，lane 会以缺失该能力的状态启动——你可以事后手动 `wrangler secret put` 补上。

## 回收机制

`teardown-lane.yml` 以反向顺序（main → agent → integrations）对三个 lane worker 执行 `wrangler delete --force`。DO 存储随 worker 一起删除。共享资源（KV / D1 / R2 / Vectorize）**不会**被动到——lane 写入的内容会留下来。

## 限制与后续（MVP 不做）

- 没有「PR 触发自动部署」。Lane 仅 `workflow_dispatch` 触发。
- 没有通配 DNS / 漂亮的子域名——lane 用裸 workers.dev URL。
- 没有按 lane 隔离的限流 namespace——lane 与 prod 共享限流计数器（注：实际是与 staging 共享）。
- 没有 lane 注册表 / 索引——通过 `wrangler list` 找你的 lane。
- 不会自动过期——操作者必须记得回收。
- Console 资源每次部署都重新构建（lane 之间不复用缓存）。