# Agent RL: Self-Improving Agents on Open Managed Agents

A platform that lets any agent improve itself through reinforcement learning — using the same sandbox, tools, and runtime it runs in production.

Cursor trains Composer in the same harness users interact with. Cognition trains Devin on its own Cascade runtime. Both are closed-source. **Agent RL makes this pattern open.**

## The Idea

```
Production                              Training
┌──────────────────────┐                ┌──────────────────────┐
│  OMA Runtime         │                │  OMA Runtime (same)  │
│  Agent harness       │   same code    │  Agent harness       │
│  Sandbox (container) │ ──────────── → │  Sandbox (container) │
│  Tools + MCP         │                │  Tools + MCP         │
│  Event log           │                │  Event log           │
└──────┬───────────────┘                └──────┬───────────────┘
       │                                       │
  user requests                          task set (20+ tasks)
       │                                       │
       ▼                                       ▼
  production trajectories               training trajectories
       │                                       │
       └──────── both feed RL ─────────────────┘
                      │
               ┌──────▼──────┐
               │ Verifier    │  deterministic reward
               │ GRPO        │  advantage estimation
               │ Trainer     │  gradient update (veRL / Tinker)
               └─────────────┘
```

## How It Differs

|  | Agent Lightning | Atropos + Hermes | AgentGym-RL | ARES | **OMA Agent RL** |
|--|----------------|-----------------|-------------|------|-----------------|
| What it is | Training bridge | Training env framework + agent product | Training framework | Async rollout infra | **Agent platform + training** |
| Sandbox | BYO | Docker (basic) | HTTP services | Docker | **Container (production-grade)** |
| Production runtime | No | Hermes only | No | No | **Yes (any agent)** |
| Multi-agent | No | No | No | No | **Yes** |
| Same runtime prod/train | No | Partially | No | No | **Yes** |
| Train any agent | Yes (framework-agnostic) | No (Hermes only) | Yes (5 domains) | Yes (coding only) | **Yes** |

**Key differentiator:** Others separate the training environment from the production runtime. OMA uses the same runtime for both — same harness, same sandbox, same tools. What you train on is what you deploy.

## Architecture

```
Training Cluster (GPU)                 OMA Runtime (CF / local)
┌─────────────────────┐                ┌──────────────────────┐
│  veRL / Tinker       │                │  Agent harness       │
│  vLLM (policy model) │── inference ──→│  ↕ tool routing      │
│  GRPO trainer        │                │  Sandbox (container) │
│                      │←─ trajectory ──│  Event log (SQLite)  │
└─────────────────────┘                └──────────────────────┘
```

OMA's `provider.ts` supports `oai-compatible` mode — point `baseURL` to vLLM and the agent uses the training model with zero code change.

## Quick Start

### Offline: collect trajectories + train later

```bash
# 1. Collect (uses any model — Claude, GPT, or local)
export OMA_API_URL=http://localhost:8787
npx tsx rl/cli.ts rollout --tasks rl/tasks --output trajectories.jsonl

# 2. Score
npx tsx rl/cli.ts reward --trajectories trajectories.jsonl --output scored.jsonl

# 3. Train (Mac MPS, CPU, or GPU)
python rl/verl/verl_trainer.py \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --from-file scored.jsonl --epochs 5
```

### Online: on-policy RL loop

```bash
# 1. Start local model server (wraps training model as OpenAI API)
python rl/verl/model_server.py --model Qwen/Qwen2.5-0.5B-Instruct --port 8000

# 2. OMA agent uses local model for inference
#    Configure agent with model_base_url=http://localhost:8000/v1

# 3. Run training loop (rollout → reward → GRPO → update weights → repeat)
python rl/verl/verl_trainer.py \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --oma-url http://localhost:8787 \
  --tasks rl/tasks/ --epochs 10
```

### Tinker (managed GPU, no infra)

```bash
python rl/verl/tinker_recipe.py \
  --model Qwen/Qwen2.5-7B \
  --oma-url http://localhost:8787 \
  --batch-size 64
```

## Verifier (not outcome-evaluator)

RL reward is computed by `verifier.ts` — deterministic, fast, zero cost. This is separate from `outcome-evaluator.ts` which is a production-side LLM-as-judge.

| | outcome-evaluator (production) | verifier (training) |
|--|-------------------------------|---------------------|
| Purpose | Quality check: is the work good? | Training signal: how well did the policy do? |
| Speed | Slow (LLM call) | Fast (rule checks) |
| Cost | $$$ (API) | Free |
| Output | "satisfied" / "needs_revision" | Scalar 0.0–1.0 |
| Determinism | No (LLM varies) | Yes |

Three ways to define verifiers:

**Declarative** (JSON, zero code):
```json
{ "type": "verifiable", "checks": [
    { "type": "file_contains", "path": "/workspace/out.txt", "expected": "hello", "score": 1.0 }
]}
```

**Script** (sandbox command):
```json
{ "type": "script", "verify_script": "cd /workspace && python -m pytest -q" }
```

**Programmatic** (register function):
```typescript
registerVerifier("sql_check", (traj, task) => {
  const output = getLastToolOutput(traj, "bash");
  const match = output.includes(task.reward.ground_truth!) ? 1.0 : 0.0;
  return { raw_rewards: { sql: match }, final_reward: match };
});
```

## GRPO on Mac

veRL's core GRPO algorithm runs on Mac MPS without CUDA:

```bash
pip install verl torch transformers peft

# Verified: veRL 0.4.1, Qwen2.5-0.5B, LoRA, Mac M3 Pro
python rl/verl/verl_trainer.py \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --from-file trajectories.jsonl --epochs 3
```

veRL's SGLang/Megatron are optional — core algorithms (GRPO advantage, policy gradient) work on any PyTorch backend.

## Performance

Network overhead is <2% of total time for 7B+ models. LLM inference dominates. This applies equally to OMA, Atropos, and every other agent RL framework — the tight loop (generate → execute tool → generate) always calls the inference server over the network unless co-located.

| Deployment | Overhead/turn | When to use |
|-----------|-------------|-------------|
| Co-located (cloudflare-less + GPU) | ~5ms | Production training |
| Remote (CF Workers) | ~100ms | Validation, 7B+ models |

## File Structure

```
rl/
├── types.ts              # Trajectory, Completion, RewardResult, GroupStats
├── trajectory.ts         # SSEEvent[] → Trajectory (with completions, group_uuid)
├── verifier.ts           # RL reward: deterministic checks, ground_truth, efficiency
├── verifier-registry.ts  # User-defined custom verifiers
├── reward.ts             # Backward-compat wrapper over verifier
├── rollout.ts            # Batch rollout + SessionPool warmup
├── config.ts             # Configuration + env vars
├── cli.ts                # CLI: rollout, reward, collect
├── __tests__/rl.test.ts  # 22 tests
├── tasks/                # 20 built-in tasks (file-ops, bash-ops, multi-step)
└── verl/
    ├── verl_trainer.py   # veRL GRPO + LoRA (Mac/CPU/CUDA)
    ├── oma_env.py        # OMA as Python rollout environment
    ├── model_server.py   # Local OpenAI-compatible inference server
    ├── grpo_loop.py      # Standalone training loop
    ├── tinker_recipe.py  # Tinker API integration
    ├── config.yaml       # Training hyperparameters
    ├── skypilot.yaml     # Cloud GPU deployment
    └── requirements.txt
```

## Roadmap

- [ ] Production trajectory auto-collection (Cursor/Hermes self-improvement loop)
- [ ] User feedback (thumbs up/down) as reward signal
- [ ] Model hot-swap (deploy new model without service interruption)
- [ ] Multi-agent RL (train coordinator + specialist agents jointly)
- [ ] Hierarchical credit assignment (Agent Lightning pattern)
- [ ] Process reward model (per-step rewards, not just outcome)
