# Handoff: Unified Verifier Framework + Eval Infra

## Context

We spent this session on three things:
1. **Design doc** (`docs/tiered-execution-and-fork.md`) — comparing OMA vs OpenAI Agents SDK vs Cloudflare Project Think
2. **Eval framework** (`test/eval/`) — 22 tasks across 5 categories, CLI runner against live API
3. **Platform fixes** — async POST events, sandbox image, CI/CD issues

## Current State

### What works
- **Async POST /events** — `this.drainEventQueue()` fire-and-forget in DO, POST returns 202 immediately. Verified with `wrangler tail` logs.
- **Sandbox image** — `openma/sandbox-base:latest` on Docker Hub, based on `cloudflare/sandbox:0.8.11` + Python 3.12 (uv), Node 20, Go 1.22, Rust. Build pipeline: `.github/workflows/build-sandbox-image.yml`
- **Eval runner** — T2.1 (auth bypass fix, medium) PASS with Layer 1 (deterministic). `OMA_API_URL=... OMA_API_KEY=... npx tsx test/eval/runner.ts --task T2.1-auth-bypass-fix`
- **Model card** — `mdl-i8qlcoilr1868fu5` (MiniMax-M2.7, base_url: `https://api.example.com/anthropic/v1`)
- **CI callback** — GitHub secret `API_KEY` fixed, sandbox deploy callback works

### What's incomplete
- **Layer 2 judge** — `judge()` in `client.ts` implemented but not tested (API 529 during testing). Uses independent LLM call, NOT platform outcome.
- **Eval tasks T2.2-T2.5, T3.x, T4.x, T5.x** — defined but not run on live
- **Sandbox SDK version mismatch** — `@cloudflare/sandbox` 0.8.9 in package.json, container is 0.8.11. Needs `pnpm update`.

### Key insight: unify eval / outcome / RL

Platform outcome, eval judge, and RL reward are all the same thing:
```
Task + Agent execution + Verifier → Score
  Outcome: score → needs_revision/satisfied (supervisor loop)
  Eval:    score → pass/fail (quality report)
  RL:      score → reward signal (training)
```

One verifier interface, three consumers.

## Next Session TODO

### 1. Research: how do eval frameworks abstract their core interfaces?

Read the actual source code (not just docs) of:
- **Inspect AI** (`inspect_ai/`) — `Task`, `Solver`, `Scorer`, `Dataset` classes
- **EvalScope** (`evalscope/`) — `Benchmark`, `Metric`, `DataAdapter` interfaces
- **OpenAI Evals** — `DataSource`, `TestingCriteria`, `Grader` schemas
- **ms-swift** — GRPO reward function interface, how it connects to eval

Key questions:
- What's the common abstraction? (Task, Scorer/Verifier, Dataset)
- How do they load standard benchmarks (SWE-bench, HumanEval, GAIA)?
- Can the same scorer be used as RL reward?
- What's the data format for task definitions?

### 2. Design: unified verifier interface for OMA

Based on research, design:
```typescript
interface Verifier {
  check(trajectory: Trajectory): Score;  // deterministic
  judge(trajectory: Trajectory, rubric: string): Score;  // LLM-based
}

interface Score {
  value: number;      // 0~1
  pass: boolean;      // value > threshold
  reasoning?: string; // LLM judge explanation
  criteria?: Record<string, number>; // per-criterion breakdown
}
```

This should be compatible with:
- Platform outcome evaluator (supervisor mode)
- Eval framework (reporting mode)
- RL reward function (training mode)
- Standard benchmarks (SWE-bench, Tau-bench, etc.)

### 3. Run full eval suite

After verifier is designed, run all 22 tasks and report results.

## Files to know

| File | Purpose |
|---|---|
| `docs/tiered-execution-and-fork.md` | Design doc: Think/OpenAI comparison + proposals |
| `test/eval/runner.ts` | Eval orchestrator |
| `test/eval/client.ts` | API client + judge function |
| `test/eval/verify.ts` | Layer 1 deterministic checks |
| `test/eval/suites/*.ts` | 22 eval task definitions |
| `test/eval/observe-async.sh` | Async POST observation script |
| `apps/agent/src/runtime/session-do.ts` | Async drainEventQueue (line ~276) |
| `apps/agent/src/harness/default-loop.ts` | Retry logic (10 retries, 30s cap) |
| `apps/agent/Dockerfile` | Sandbox base image definition |
| `apps/agent/Dockerfile.sandbox` | Thin wrapper for wrangler deploy |
| `.github/workflows/build-sandbox-image.yml` | Docker Hub image build pipeline |
| `AGENTS.md` | Debugging protocol (observe→measure→diagnose) |
| `rl/` | Another agent's RL work, don't touch |

## Debugging protocol (from AGENTS.md)

```
1. Define Observation — what do I need to see?
2. Measure — add logs, deploy, collect data
3. Diagnose — compare observation with expectation
Do NOT change code based on guesses.
```

## Environment config

- API: `https://openma.dev`
- API Key: in `.dev.vars`
- Model card: `mdl-i8qlcoilr1868fu5` (MiniMax-M2.7)
- Environment: `env-qisw0fmtm88nqwyk` (eval-env, sandbox-default)
- Docker Hub: `openma/sandbox-base:latest` (user: openma, token in GitHub secrets)
- Anthropic proxy: `https://api.example.com/anthropic/v1` (key in `.dev.vars`)
