# Agent RL: Post-Training Pipeline for Open Managed Agents

Agent platforms give you runtime. Training frameworks give you gradients. Neither gives you both.

**Agent RL** closes the loop: define tasks, collect trajectories from OMA's sandboxed agent runtime, compute rewards, and train with GRPO — on-policy, in the same environment your agents run in production.

## Architecture

```
Tinker / veRL (GPU)                    OMA Runtime
┌───────────────────────┐              ┌──────────────────────┐
│  GRPO training loop   │              │  Agent harness       │
│  vLLM (policy model)  │───HTTP API──→│  Sandbox (container) │
│  Advantage estimation │              │  Tools (bash, file,  │
│  Gradient update      │              │   grep, glob, web)   │
│                       │←─trajectory──│  Event log           │
└───────────────────────┘              └──────────────────────┘
```

The RL module talks to OMA via its Session API. It doesn't care whether OMA is on Cloudflare Workers or running locally — same API, same code, different latency profile.

## Quick Start

### 1. Collect trajectories (offline, no training)

```bash
# Point to your OMA instance and model
export OMA_API_URL=http://localhost:8787
export OMA_API_KEY=test-key

# Collect trajectories from 20 built-in tasks
npx tsx rl/cli.ts rollout \
  --tasks rl/tasks \
  --concurrency 4 \
  --output trajectories.jsonl
```

### 2. Score trajectories

```bash
npx tsx rl/cli.ts reward \
  --trajectories trajectories.jsonl \
  --output scored.jsonl
```

### 3. Train with GRPO

```bash
# Using standalone GRPO loop
python rl/verl/grpo_loop.py \
  --model Qwen/Qwen2.5-7B \
  --model-url http://localhost:8000/v1 \
  --tasks rl/tasks/ \
  --batch-size 16 \
  --epochs 10

# Or via Tinker
python rl/verl/tinker_recipe.py \
  --model Qwen/Qwen2.5-7B \
  --batch-size 64
```

### 4. Deploy to cloud GPU (optional)

```bash
# Via SkyPilot
sky launch rl/verl/skypilot.yaml
```

## How It Works

### Task Definition

Tasks are JSON files defining what to ask the agent and how to score the result:

```json
{
  "id": "file-01-create-text",
  "description": "Create a plain text file with specific content",
  "message": "Create a file at /workspace/hello.txt containing exactly: Hello, World!",
  "reward": {
    "type": "rule",
    "rules": [
      { "check": "file_exists", "path": "/workspace/hello.txt", "score": 0.3 },
      { "check": "file_contains", "path": "/workspace/hello.txt", "expected": "Hello, World!", "score": 0.7 }
    ]
  }
}
```

### Reward Strategies

| Strategy | Speed | Use case |
|----------|-------|----------|
| **Rule-based** | Fast | Deterministic checks: file exists, content matches, exit code |
| **LLM-as-judge** | Slow | Open-ended tasks via `outcome-evaluator.ts` |
| **Composite** | Medium | Weighted: rules (60%) + LLM (20%) + efficiency bonus (20%) |

### Training Platforms

| Platform | How to use |
|----------|-----------|
| **Tinker** (Thinking Machines Lab) | `tinker_recipe.py` — Atropos protocol, managed GPU |
| **veRL** (ByteDance) | `oma_env.py` — custom environment |
| **SkyPilot** | `skypilot.yaml` — self-managed cloud GPU |
| **Standalone** | `grpo_loop.py` — no framework dependency |

## Comparison

| Feature | OMA + Agent RL | Agent Lightning | AgentGym-RL | ARES | Hermes |
|---------|---------------|-----------------|-------------|------|--------|
| Built-in sandbox | Yes (containers) | No (BYO) | Partial (HTTP) | Docker | Docker |
| Production runtime | Yes | No | No | No | Yes |
| Multi-agent RL | Yes | No | No | No | No |
| On-policy training | Yes | Yes | Yes | Yes | Yes |
| veRL/Tinker support | Both | veRL | Custom | Neither | Tinker |
| Cloudflare-less option | Yes | N/A | N/A | N/A | N/A |

## Performance

Network latency between the training cluster and OMA is negligible (<2% of total time for 7B+ models). The bottleneck is LLM inference.

| Deployment | Latency/turn | Best for |
|-----------|-------------|----------|
| Co-located (cloudflare-less) | ~5ms | Production training, small models |
| Remote (Cloudflare Workers) | ~100ms | Quick validation, 7B+ models |

Session pool warmup amortizes sandbox cold starts across the batch.

## File Structure

```
rl/
├── types.ts              # Type definitions
├── trajectory.ts         # Event → trajectory conversion
├── reward.ts             # Reward computation (rule, LLM, composite)
├── rollout.ts            # Batch rollout orchestration + session pool
├── config.ts             # Configuration and env vars
├── cli.ts                # CLI entry point
├── tasks/
│   ├── file-ops.json     # 10 file operation tasks
│   ├── bash-ops.json     # 5 bash tasks
│   └── multi-step.json   # 5 multi-step tasks
└── verl/
    ├── oma_env.py        # veRL custom env + Tinker Atropos adapter
    ├── grpo_loop.py      # Standalone GRPO training loop
    ├── tinker_recipe.py  # Tinker integration recipe
    ├── config.yaml       # Training hyperparameters
    ├── skypilot.yaml     # Cloud GPU deployment
    └── requirements.txt  # Python dependencies
```
