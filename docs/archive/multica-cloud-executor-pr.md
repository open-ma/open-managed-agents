# PR: Multica Cloud Runtime Executor

## Context

Multica 项目的数据库和 API 已经为 cloud runtime 预留了完整架构（`runtime_mode IN ('local', 'cloud')`），但缺少实际的云端任务执行器。当前只有本地 daemon 能执行任务。本 PR 填补这一空白，实现一个可以在 Docker 容器中运行的 Cloud Executor 服务。

## Architecture Decisions

1. **新 binary，不是 daemon 的模式** — daemon 与本地环境深度耦合（PID 文件、health port 冲突检测、CLI 自动更新、config 文件监听），分开更干净
2. **直接运行 CLI，不用 Docker-in-Docker** — 容器内预装 agent CLI，作为子进程执行，和 daemon 模式一致
3. **Ephemeral workdir** — 任务完成后清理工作目录，不做 session 恢复（MVP）
4. **最小 server 改动** — 仅让注册接口接受 `runtime_mode` 参数（原来硬编码 `"local"`）
5. **水平扩展** — 多实例各用不同 executor ID，数据库原子 claim 防重

## Changes

### Phase 1: Server-side (约 20 行改动)

**修改 `server/internal/handler/daemon.go`**
- `DaemonRegisterRequest` 添加 `RuntimeMode string` 字段
- `DaemonRegister()` 中将硬编码 `"local"` 改为从请求读取，默认 `"local"`

**添加测试 `server/internal/handler/daemon_test.go`**
- `TestDaemonRegister_CloudMode` — 验证 cloud 注册
- `TestDaemonRegister_DefaultMode` — 验证向后兼容

### Phase 2: Cloud Executor 核心 (约 400-500 行)

**新建 `server/internal/cloudexec/config.go`**
- `Config` 结构体，所有配置来自环境变量
- `LoadConfig()` 函数

**新建 `server/internal/cloudexec/executor.go`**
- `Executor` 结构体，复用 `daemon.Client`、`daemon.Task` 等类型
- `Run()` — 注册 → poll loop + heartbeat loop → 退出时 deregister
- `pollLoop()` — 与 daemon 同构，用 semaphore 控制并发
- `handleTask()` — start → run → report → complete/fail
- `runTask()` — 复用 `execenv.Prepare`、`daemon.BuildPrompt`、`agent.New` / `agent.Execute`
- 与 daemon 的差异：不复用 PriorWorkDir，任务完成后清理

**新建 `server/internal/cloudexec/executor_test.go`**
- LoadConfig 必填项验证、默认值验证

### Phase 3: Binary + Build

**新建 `server/cmd/cloudexecutor/main.go`**
- 从环境变量加载配置，创建 Executor，信号处理，Run()

**修改 `Makefile`**
- 添加 `cloudexecutor` 构建目标

### Phase 4: Docker 集成

**修改 `Dockerfile`**
- 添加 `cloudexecutor` binary 构建

**修改 `docker-compose.selfhost.yml`**
- 添加 `cloud-executor` 服务，`profiles: [cloud]`（需手动 `--profile cloud` 启动）

### Phase 5: 文档

- 更新 `SELF_HOSTING.md`，添加 cloud executor 配置说明

## Key Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MULTICA_SERVER_URL` | Yes | - | Backend URL |
| `MULTICA_TOKEN` | Yes | - | Daemon token 或 PAT |
| `MULTICA_WORKSPACE_ID` | Yes | - | 要服务的 workspace |
| `MULTICA_EXECUTOR_ID` | No | hostname | 唯一实例 ID |
| `MULTICA_CLAUDE_PATH` | No | `claude` | Claude CLI 路径 |
| `MULTICA_MAX_CONCURRENT_TASKS` | No | `5` | 最大并发 |
| `MULTICA_POLL_INTERVAL` | No | `3s` | 轮询间隔 |
| `MULTICA_AGENT_TIMEOUT` | No | `2h` | 单任务超时 |

## Key Files Reference

| File | Role |
|---|---|
| `server/internal/handler/daemon.go:119,209` | 注册接口，需改 runtime_mode |
| `server/internal/daemon/daemon.go` | 主循环参考（pollLoop, handleTask, runTask） |
| `server/internal/daemon/client.go` | HTTP 客户端，直接复用 |
| `server/internal/daemon/types.go` | 共享类型，直接复用 |
| `server/internal/daemon/execenv/` | 执行环境设置，直接复用 |
| `server/pkg/agent/` | Agent backend 接口，直接复用 |

## Verification

1. `make test` — 所有 Go 测试通过
2. `make build` — cloudexecutor binary 编译成功
3. `docker compose --profile cloud up` — 服务启动正常
4. 手动集成测试：创建 workspace → 注册 cloud runtime → 分配 issue → 验证执行

## Commit Convention

```
feat(cloud): add cloud runtime executor for remote task execution
```

## Out of Scope (Future Work)

- Container-per-task 隔离（Docker SDK）
- Session 恢复（PriorSessionID / PriorWorkDir）
- Repo 缓存
- 自动扩缩容
- Browser use 集成
