# Linear 集成 —— 部署 SOP

**目标**：把代码库从「编译通过、测试通过」的状态，推到「Linear publish 流程在生产端到端跑通」。

**耗时**：一切顺利的话约 15 分钟。**Linear App 注册表单**最耗时，因为它只能在 web 上填（没 CLI）。

**负责人**：每个环境（dev / prod）一次性配置。配完之后，唯一需要手动操作的就是怀疑泄露时轮换 secret。

---

## 0. 前置条件

- Wrangler 已登录：`wrangler whoami` 能显示 Cloudflare 账号
- Linear workspace **管理员**权限——注册 OAuth app 必须
- D1 数据库 `openma-auth` 已存在（main worker 在用）
- `managed-agents`（main）worker 已部署
- 当前分支构建干净：`pnpm typecheck && pnpm test` 都过

---

## 1. 决定 gateway 公网 URL

gateway worker（`apps/integrations`）会部署到下面两种 URL 之一：

- **默认 workers.dev**：`https://managed-agents-integrations.<YOUR_SUBDOMAIN>.workers.dev`
  - 查你的子域：`wrangler subdomain`（或者看任意已部署 worker 的 URL）
- **自定义域名**：`https://integrations.<your-domain>` —— 需要 Cloudflare DNS + wrangler routes 配置

不论哪种，把它存为 `<GATEWAY>` 在后续步骤里用。例：

```bash
export GATEWAY="https://managed-agents-integrations.acme.workers.dev"
```

---

## 2. 生成两个 secret（一次性）

```bash
# 32 字节随机，base64。**跑两次——两次的值必须不同**。
openssl rand -base64 32   # MCP_SIGNING_KEY
openssl rand -base64 32   # INTEGRATIONS_INTERNAL_SECRET
```

两个都存进密码管理器。同样的 `MCP_SIGNING_KEY` 和 `INTEGRATIONS_INTERNAL_SECRET` 要在 **gateway worker 和 main worker 双方**都配。**两边不一致就会报「401 unauthorized」或「invalid token」。**

---

## 3.（每个 agent）注册一个 Linear App

每个你要 publish 的 agent 都需要它**独立的** Linear OAuth App。Console 的 publish 向导会逐项告诉你贴什么值——下面是参考表：

| 字段 | 值 |
|---|---|
| **Name** | agent 的人格名（在 Linear 的 `@` 自动补全和 assignee 列表里显示） |
| **Description** | 自由文本 |
| **Developer URL** | 任意 HTTPS URL —— 你的主页 / repo |
| **Callback URL** | `${GATEWAY}/linear/oauth/app/<APP_ID>/callback`（Console 在第 2 步之后会用真实 `<APP_ID>` 重新生成） |
| **Webhook URL** | `${GATEWAY}/linear/webhook/app/<APP_ID>` |
| **Webhook secret** | Console 自动生成一个 —— 把它贴进 Linear |
| **Webhook events** | ✅ **App user notification**（必选）；可选 ✅ Issue、✅ Comment |
| **Public** | 关闭（Private —— 仅你自己安装时用） |
| **Scopes** | ✅ `read`、✅ `write`、✅ `app:assignable`、✅ `app:mentionable` |

Linear 只会展示 `client_id` + `client_secret` **一次**。把它们贴回 Console 向导。

---

## 4. 在 gateway 配置里设 `GATEWAY_ORIGIN`

编辑 `apps/integrations/wrangler.jsonc` —— 把占位值替换掉：

```diff
   "vars": {
-    "GATEWAY_ORIGIN": "https://managed-agents-integrations.example.workers.dev"
+    "GATEWAY_ORIGIN": "<GATEWAY>"        // 第 1 步定的真实 URL
   },
```

提交这次修改。（多环境？用 `[env.production]` 块；单环境直接改顶层即可。）

---

## 5. 部署 gateway worker

```bash
cd apps/integrations

# 设置 2 个 secret（提示输入时贴值进去）
wrangler secret put MCP_SIGNING_KEY                # 第 2 步生成
wrangler secret put INTEGRATIONS_INTERNAL_SECRET   # 第 2 步生成

# 部署
wrangler deploy
```

**验证**：

```bash
curl $GATEWAY/health
# → {"status":"ok"}
```

如果返回的是 HTML 而不是 JSON，说明 URL 错了（多半打到 main worker 上了）。重新检查。

---

## 6. 部署 main worker

```bash
cd apps/main

# 同样的两个 secret —— 必须与第 2 步的值**完全一致**
wrangler secret put MCP_SIGNING_KEY
wrangler secret put INTEGRATIONS_INTERNAL_SECRET

wrangler deploy
```

**顺序很关键**：必须先部署 gateway，main 的 `INTEGRATIONS` service binding 才能解析。

**验证**（需要登录 session cookie，没有可跳过）：

```bash
curl -b 'session=...' https://<MAIN>/v1/integrations/linear/installations
# → {"data":[]}
```

如果看到 `INTEGRATIONS binding missing`，说明 gateway 还没部署 —— 回去跑第 5 步，再重新部署 main。

---

## 7. 应用 D1 迁移

```bash
# repo 根或 apps/main 都行：
wrangler d1 migrations apply openma-auth --remote

# 本地开发用 --local
```

应用的迁移：

```
0002_integrations_tables.sql        新增 6 张 linear_* 表 + 索引
0003_publications_environment.sql   增加 environment_id 列
0004_installations_vault.sql        增加 vault_id 列
0005_drop_b_plus_columns.sql        删除 slash_command + is_default_agent
```

如果某次迁移因「表已经从上次半途而废的尝试中存在」而失败，手动用 `wrangler d1 execute openma-auth --remote --command 'DROP TABLE linear_xxx'` 把残留表删掉，再重新应用。

---

## 8. 端到端冒烟测试

### 8a. 打开 Console

打开你的 Console URL，登录。侧边栏现在应当出现 **Integrations / Linear**。点进去。

应当看到：
- 「No Linear workspaces connected yet.」
- 一个 `+ Publish agent to Linear` 按钮。

### 8b. 发布一个 agent

1. 点 `+ Publish agent to Linear`
2. 挑任意一个已有 agent
3. 挑任意一个 environment
4. 人格名：默认就是 agent 名，OK
5. 点 `Continue →`

向导会给你一个 Linear app 注册表单（App name、Callback URL、Webhook URL、Webhook secret）—— 把这些贴到 <https://linear.app/settings/api/applications/new>，再把 Linear 给你的 `client_id` + `client_secret` 贴回 Console。点安装链接，在 Linear 里授权，最后会跳到 `/integrations/linear?install=ok&publication_id=...`。

### 8c. 在 Linear 里验证安装

在你的 Linear workspace：
- Settings → Members 应当能看到这个 agent（显示为你设置的人格名），它是个 bot user
- 在任意 issue 里试 `@<persona-name>` —— 自动补全应该能找到它
- 把 issue assign 给它

约 10 秒内你应当看到：
- OMA Console `/sessions` 里出现一个新 session，带 🔗 ENG-XXX 徽标
- Linear issue 里可能出现一条 agent 评论（如果你的 agent 会评论的话）

### 8d. 测试时同步 tail 日志

开两个终端：

```bash
wrangler tail managed-agents-integrations
wrangler tail managed-agents
```

注意看：
- Gateway：`POST /linear/webhook/app/<APP_ID>` 返回 200
- Main：`POST /v1/internal/sessions` 返回 200，并有 sessionId 返回

常见失败：

- **gateway webhook 返回 401** —— App 行里存的 webhook secret 与 Linear 那边的不一致。回 Linear 的 app 设置里重贴。
- **main internal endpoint 返回 401** —— `INTEGRATIONS_INTERNAL_SECRET` 在 gateway 与 main 上不一致。两边重新设置，重新部署。
- **webhook 完全没到** —— Linear 没认 URL。回 Linear 的 app 设置里重新检查 webhook URL，必须**严格等于** `${GATEWAY}/linear/webhook/app/<APP_ID>`。

---

## 9.（可选）从 CLI 冒烟

如果你已经在第 8 步发布过 agent，可以从终端验证：

```bash
# 确认 Console 看到这个安装
curl -b 'session=...' https://<MAIN>/v1/integrations/linear/installations
# → {"data":[{"workspace_name":"...","install_kind":"dedicated",...}]}
```

在 Linear 里，这个 agent 表现为一个独立用户，带 `@<persona>` 自动补全和 assignee 下拉选项。

---

## 10. 轮换 / 拆除

### 轮换 per-app 的 `client_secret` 或 `webhook_secret`

这些 per-app secret 存在 D1（`linear_apps.client_secret_cipher` / `webhook_secret_cipher`），用 `MCP_SIGNING_KEY` 加密。要轮换某一个 publication 的 secret 而不动 `MCP_SIGNING_KEY`：

1. 在 Linear app 设置里，对该 secret 点「Regenerate」。
2. 在 Console 重新走一次 publish（向导会用新值重新加密并写入）。

### 轮换 `MCP_SIGNING_KEY`

⚠️ **破坏性**：轮换它会让所有静态加密的 token 全部成「孤儿」（`linear_installations.access_token_cipher`、`linear_apps.client_secret_cipher` 等）。已有的 publication 都会因「missing client secret」失败，直到重新安装。

流程：

1. 在**两个 worker**上 `wrangler secret put MCP_SIGNING_KEY`。
2. 两个 worker 都 `wrangler deploy`。
3. 通知用户从 Console 重新发布 Linear 集成。

### 轮换 `INTEGRATIONS_INTERNAL_SECRET`

直接在两边设新值并重新部署。**不会丢数据。**

### 完全卸载 OMA Linear App

1. Linear → Settings → Apps，从每个 workspace 卸载「OpenMA」。
2. Linear → Settings → API，删除 app 注册。
3. 想清空状态的话，删掉 D1 里的 linear_* 表：
   ```bash
   wrangler d1 execute openma-auth --remote --command \
     'DROP TABLE linear_apps; DROP TABLE linear_installations;
      DROP TABLE linear_publications; DROP TABLE linear_webhook_events;
      DROP TABLE linear_setup_links; DROP TABLE linear_issue_sessions;'
   ```

---

## 附录 A —— 本地开发

跳过第 1 步（不需要公网 URL）。两个 worker 都用 `wrangler dev`：

```bash
# 终端 1 —— gateway
cd apps/integrations
echo 'GATEWAY_ORIGIN = "http://localhost:8788"' > .dev.vars
echo 'MCP_SIGNING_KEY = "..."' >> .dev.vars
echo 'INTEGRATIONS_INTERNAL_SECRET = "..."' >> .dev.vars
wrangler dev --port 8788

# 终端 2 —— main
cd apps/main
echo 'MCP_SIGNING_KEY = "..."' > .dev.vars
echo 'INTEGRATIONS_INTERNAL_SECRET = "..."' >> .dev.vars
wrangler dev --port 8787
```

Linear 没法 webhook 到 localhost，所以端到端 OAuth + webhook 流程需要 **cloudflared tunnel** 或 **ngrok** 把 gateway 暴露到公网。然后临时把 Linear app 的 callback / webhook URL 改成 tunnel URL。

只是「点点 Console UI、不需要真实 Linear 流量」的话，localhost 就够——安装按钮会在 OAuth 跳转那一步失败，但之前的所有交互都能跑。

---

## 附录 B —— 预填值速查表（贴 Linear app 表单用）

```
App name:           <publish 向导里的 persona 名>
Description:        Make this OMA agent a teammate in Linear
Developer URL:      https://github.com/yourorg/open-managed-agents
Callback URL:       <GATEWAY>/linear/oauth/app/<APP_ID>/callback
Webhook URL:        <GATEWAY>/linear/webhook/app/<APP_ID>
Webhook events:     App user notification, Issue（可选）, Comment（可选）
Scopes:             read, write, app:assignable, app:mentionable
Public:             No
```