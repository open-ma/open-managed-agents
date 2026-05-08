# 端到端的 GitHub PR 流程

记录 managed agent 从 session 创建到提交 PR 的完整流程。

## 架构

```
用户 API 请求                         Sandbox（容器）
─────────────                         ───────────────
POST /v1/sessions
  { resources: [{
      type: "github_repository",
      url: "https://github.com/…",
      authorization_token: "ghp_…"   ← 仅写入，永不返回
    }],
    vault_ids: ["vault_xxx"]
  }
       │
       ▼
   SessionDO.warmup()
       │
       ├─ mountResources()
       │   ├─ git clone（token 拼到 URL，仅一次）
       │   ├─ git remote set-url origin CLEAN_URL（去掉 token）
       │   ├─ git config credential.helper → 从 $GITHUB_TOKEN 读
       │   ├─ registerCommandSecrets("git", { GITHUB_TOKEN })
       │   ├─ registerCommandSecrets("gh",  { GH_TOKEN })
       │   └─ ensureGhCli() → apt install gh（如果挂了 github_repository）
       │
       ├─ 加载 vault 凭据
       │   └─ command_secret 类型：
       │       registerCommandSecrets("wrangler", { CF_API_TOKEN })
       │
       └─ Harness 准备就绪
```

## 凭据安全模型

```
Secret 注入路径：

  Vault / Resource API       KV 存储                Sandbox exec()
  ─────────────────────      ───────                ──────────────
  authorization_token  ───►  secret:{sid}:{rid}
                             （独立 key，
                              不进 resource
                              metadata）
                                    │
                                    ▼
                             secretStore Map
                                    │
                                    ▼
                             registerCommandSecrets()
                                    │
                                    ▼
                             sandbox.exec(cmd, {
                               env: { GITHUB_TOKEN: "ghp_…" }  ← 按 exec 注入
                             })
```

**关键性质：**

- `authorization_token` 与 `value` 都是**仅写入**——任何 API 响应里都不会出现
- Secret 存放在独立 KV key（`secret:{sessionId}:{resourceId}`），不会进 resource metadata
- `registerCommandSecrets(prefix, secrets)` 只在命令前缀匹配时注入对应环境变量
- `echo $GITHUB_TOKEN` → 空（没有全局环境变量，只有针对 `git` / `gh` / `cd` 这些命令的 per-exec 注入）
- `git remote -v` → 干净 URL（clone 之后 token 已被剥离）
- credential helper 从 per-exec 环境读 `$GITHUB_TOKEN`：`git config credential.helper '!f() { echo "password=${GITHUB_TOKEN}"; }; f'`

## 三种凭据类型

| 类型 | 用途 | 匹配方式 | 注入形式 |
|------|------|----------|----------|
| `static_bearer` | MCP server 鉴权 | `mcp_server_url` | Bearer token 头 |
| `mcp_oauth` | MCP OAuth 流 | `mcp_server_url` | OAuth token 刷新 |
| `command_secret` | CLI 工具鉴权 | `command_prefixes` | per-exec 环境变量 |

### command_secret 示例

```json
POST /v1/vaults/{id}/credentials
{
  "display_name": "Wrangler Token",
  "auth": {
    "type": "command_secret",
    "command_prefixes": ["wrangler", "npx wrangler"],
    "env_var": "CLOUDFLARE_API_TOKEN",
    "token": "cf_xxx"                    // 仅写入
  }
}
```

当 agent 跑 `wrangler deploy` 时，sandbox 仅在那次 exec 调用上注入 `CLOUDFLARE_API_TOKEN=cf_xxx`。

## GitHub 资源流（逐步）

### 1. 创建 Session

```json
POST /v1/sessions
{
  "agent": "agent_xxx",
  "environment_id": "env_xxx",
  "resources": [{
    "type": "github_repository",
    "url": "https://github.com/org/repo",
    "authorization_token": "ghp_xxx",
    "checkout": { "type": "branch", "name": "main" }
  }]
}
```

响应里包含资源的 `url`，但**不会**包含 `authorization_token`。

### 2. Warmup（SessionDO）

```
sandbox.gitCheckout(url_with_token, { branch: "main", targetDir: "/workspace" })
  或
sandbox.exec("git clone https://TOKEN@github.com/… /workspace")

sandbox.exec("git remote set-url origin https://github.com/…")     // 干净 URL
sandbox.exec("git config credential.helper '!f() { … }; f'")       // 基于环境变量的 auth
sandbox.exec("git config user.name Agent && git config user.email …")

registerCommandSecrets("git", { GITHUB_TOKEN: token, GH_TOKEN: token })
registerCommandSecrets("gh",  { GITHUB_TOKEN: token, GH_TOKEN: token })
registerCommandSecrets("cd ", { GITHUB_TOKEN: token, GH_TOKEN: token })

ensureGhCli()  // 镜像没装就 apt install gh
```

### 3. Agent 创建 PR（通过 harness + 工具）

Agent（Claude）用 bash 工具：

```bash
cd /workspace
git checkout -b fix/improve-readme
echo "..." >> README.md
git add README.md
git commit -m "docs: improve readme"
git push origin fix/improve-readme
gh pr create --title "docs: improve readme" --body "..."
```

每条 `git` / `gh` 命令在 exec 时都会被注入 `GITHUB_TOKEN` 与 `GH_TOKEN`。

## 全局环境秘密（env_secret）

如果 agent 需要的不是命令级 secret，而是要全局可见：

```json
POST /v1/sessions
{
  "resources": [{
    "type": "env_secret",
    "name": "TAVILY_API_KEY",
    "value": "tvly_xxx"           // 仅写入
  }]
}
```

通过 `sandbox.setEnvVars()` 注入——所有命令都能看到（与 Anthropic 的模型一致）。

## wrangler.jsonc 环境配置

```jsonc
{
  "name": "managed-agents",
  "containers": [{
    "class_name": "Sandbox",
    "image": "./node_modules/@cloudflare/sandbox/Dockerfile",
    "instance_type": "lite",
    "max_instances": 10
  }],

  "env": {
    "dev": {
      // 本地开发：用预构建镜像，避免依赖 Docker Hub
      "containers": [{
        "class_name": "Sandbox",
        "image": "/tmp/Dockerfile.sandbox",
        "instance_type": "lite",
        "max_instances": 2
      }]
    }
  }
}
```

- `npx wrangler dev` → 走顶层配置（从 Docker Hub 拉镜像）
- `npx wrangler dev --env dev` → 走本地缓存的镜像
- `npx wrangler deploy` → build 并推到 Cloudflare 镜像仓库

## 当前差距

1. **gh CLI 不在基镜像里** —— 在 warmup 时由 `ensureGhCli()` 运行时安装（约 30s 开销）。生产环境应直接打到 Dockerfile。
2. **依赖 Docker Hub** —— `wrangler dev` 与 `wrangler deploy` 都会触发 `docker build`，构建时需要 Docker Hub 拉基镜像。离线开发请用 `--env dev` + 本地缓存。
3. **workers.dev DNS** —— 部分网络环境（如中国大陆）会污染 `*.workers.dev` 的 DNS。生产环境请用自定义域名。