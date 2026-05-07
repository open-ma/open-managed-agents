# 交接：统一 Verifier 框架 + 评测基础设施

## 背景

本次会话集中做了三件事：
1. **设计文档**（`docs/tiered-execution-and-fork.md`）—— 对比 OMA、OpenAI Agents SDK、Cloudflare Project Think
2. **评测框架**（`test/eval/`）—— 5 大类共 22 个任务，CLI runner 直接打线上 API
3. **平台修复** —— POST 事件异步化、sandbox 镜像、CI/CD 问题

## 当前状态

### 已经能跑

- **POST /events 异步化** —— DO 内部以 `this.drainEventQueue()` fire-and-forget，POST 立刻返回 202。已经用 `wrangler tail` 日志验证。
- **Sandbox 镜像** —— Docker Hub 上的 `openma/sandbox-base:latest`，基于 `cloudflare/sandbox:0.8.11`，预装 Python 3.12（uv）、Node 20、Go 1.22、Rust。构建流水线：`.github/workflows/build-sandbox-image.yml`。
- **Eval runner** —— T2.1（auth bypass fix，难度 medium）在 Layer 1（确定性检查）下 PASS：`OMA_API_URL=... OMA_API_KEY=... npx tsx test/eval/runner.ts --task T2.1-auth-bypass-fix`
- **Model card** —— `mdl-i8qlcoilr1868fu5`（MiniMax-M2.7，base_url：`https://api.minimaxi.com/anthropic/v1`）
- **CI 回调** —— GitHub secret `API_KEY` 已修，sandbox 部署回调能跑通

### 还没完成

- **Layer 2 judge** —— `client.ts` 里的 `judge()` 已实现但未跑通（测试时 API 返回 529）。它走的是独立的 LLM 调用，**不是平台的 outcome evaluator**。
- **Eval 任务 T2.2–T2.5、T3.x、T4.x、T5.x** —— 已定义但还没跑过线上。
- **Sandbox SDK 版本不一致** —— `package.json` 里 `@cloudflare/sandbox` 是 0.8.9，容器里是 0.8.11。需要 `pnpm update`。

### 关键洞察：把 eval / outcome / RL 统一起来

平台的 outcome 评测、eval 框架的 judge、RL 的 reward 本质是同一件事：

```
Task + Agent 执行 + Verifier → Score
  Outcome：score → needs_revision / satisfied（supervisor 循环）
  Eval：  score → pass / fail（质量报告）
  RL：    score → reward 信号（训练）
```

**一个 verifier 接口，三类消费者。**

## 下一会话的 TODO

### 1. 调研：评测框架是怎么抽象其核心接口的？

读源码（不只是文档）：
- **Inspect AI**（`inspect_ai/`）—— `Task`、`Solver`、`Scorer`、`Dataset` 类
- **EvalScope**（`evalscope/`）—— `Benchmark`、`Metric`、`DataAdapter` 接口
- **OpenAI Evals** —— `DataSource`、`TestingCriteria`、`Grader` schema
- **ms-swift** —— GRPO reward function 接口，它是怎么和评测衔接的

关键问题：
- 共同的抽象是什么？（Task、Scorer/Verifier、Dataset）
- 它们怎么加载标准 benchmark（SWE-bench、HumanEval、GAIA）？
- 同一个 scorer 能否当 RL reward 用？
- 任务定义的数据格式是什么？

### 2. 设计：OMA 的统一 verifier 接口

基于上面的调研，设计如下接口：

```typescript
interface Verifier {
  check(trajectory: Trajectory): Score;  // 确定性检查
  judge(trajectory: Trajectory, rubric: string): Score;  // LLM 评判
}

interface Score {
  value: number;       // 0~1
  pass: boolean;       // value > threshold
  reasoning?: string;  // LLM judge 的解释
  criteria?: Record<string, number>;  // 各项指标拆分
}
```

它需要兼容：
- 平台 outcome evaluator（supervisor 模式）
- 评测框架（报告模式）
- RL reward function（训练模式）
- 标准 benchmark（SWE-bench、Tau-bench 等）

### 3. 跑完整套评测

verifier 设计完之后，跑全部 22 个任务并产出报告。

## 重要文件

| 文件 | 用途 |
|---|---|
| `docs/tiered-execution-and-fork.md` | 设计文档：Think / OpenAI 对比 + 提案 |
| `test/eval/runner.ts` | 评测调度器 |
| `test/eval/client.ts` | API 客户端 + judge 函数 |
| `test/eval/verify.ts` | Layer 1 确定性检查 |
| `test/eval/suites/*.ts` | 22 个评测任务定义 |
| `test/eval/observe-async.sh` | 异步 POST 观测脚本 |
| `apps/agent/src/runtime/session-do.ts` | 异步 `drainEventQueue`（约 276 行） |
| `apps/agent/src/harness/default-loop.ts` | 重试逻辑（10 次重试，30s 上限） |
| `apps/agent/Dockerfile` | Sandbox base 镜像定义 |
| `apps/agent/Dockerfile.sandbox` | 给 wrangler deploy 用的薄包装 |
| `.github/workflows/build-sandbox-image.yml` | Docker Hub 镜像构建流水线 |
| `AGENTS.md` | 调试规程（observe → measure → diagnose） |
| `rl/` | 另一位 agent 的 RL 工作，别动 |

## 调试规程（来自 AGENTS.md）

```
1. 定义观察对象 —— 我需要看到什么？
2. 测量 —— 加日志、部署、收集数据
3. 诊断 —— 比较观察值与预期
不要凭猜测改代码。
```

## 环境配置

- API：`https://openma.dev`
- API Key：在 `.dev.vars`
- Model card：`mdl-i8qlcoilr1868fu5`（MiniMax-M2.7）
- Environment：`env-qisw0fmtm88nqwyk`（eval-env，sandbox-default）
- Docker Hub：`openma/sandbox-base:latest`（用户：openma，token 在 GitHub secrets 里）
- Anthropic 代理：`https://api.minimaxi.com/anthropic/v1`（key 在 `.dev.vars`）