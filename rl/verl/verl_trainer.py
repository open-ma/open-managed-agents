"""
End-to-end GRPO training using veRL's core algorithms + HuggingFace model.

Runs on Mac (MPS), CPU, or CUDA. No SGLang/Megatron required.
Uses veRL's compute_grpo_outcome_advantage for advantage estimation.

Full loop:
  OMA rollout → trajectory → verifier reward → veRL GRPO advantage → train step → repeat

Usage:
    # Full online loop (OMA rollout + train)
    python verl_trainer.py \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --oma-url http://localhost:8787 \
        --oma-key <key> \
        --tasks rl/tasks/ \
        --epochs 3 --batch-size 4 --group-size 4

    # Offline (pre-collected trajectories)
    python verl_trainer.py \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --from-file trajectories.jsonl \
        --epochs 5

    # Dry run (collect only)
    python verl_trainer.py --dry-run --epochs 1
"""

import argparse
import asyncio
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model, TaskType
from verl.trainer.ppo.core_algos import compute_grpo_outcome_advantage


def get_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class PolicyModel:
    def __init__(self, model_name: str, lr: float = 1e-5, lora_r: int = 16):
        self.device = get_device()
        self.tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        dtype = torch.float32 if self.device.type == "cpu" else torch.float32
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name, torch_dtype=dtype, trust_remote_code=True,
        )
        lora_config = LoraConfig(
            task_type=TaskType.CAUSAL_LM, r=lora_r, lora_alpha=lora_r * 2,
            lora_dropout=0.05, target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
        )
        self.model = get_peft_model(self.model, lora_config)
        self.model.to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=lr, weight_decay=0.01)
        self.version = 0

        trainable = sum(p.numel() for p in self.model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in self.model.parameters())
        print(f"[model] {model_name} on {self.device}")
        print(f"[model] {total/1e6:.1f}M params, {trainable/1e6:.1f}M trainable (LoRA r={lora_r})")

    def tokenize_trajectory(self, turns: list[dict], max_len: int = 512):
        """Convert trajectory turns to tokenized input."""
        messages = []
        for turn in turns:
            role = turn.get("role", "user")
            content = turn.get("content", "")
            if role == "tool":
                messages.append({"role": "user", "content": f"[Tool Result] {content}"})
            elif role == "assistant":
                tc = turn.get("tool_calls")
                if tc:
                    messages.append({"role": "assistant", "content": f"{content}\n[Tool Call] {json.dumps(tc)}"})
                else:
                    messages.append({"role": role, "content": content})
            else:
                messages.append({"role": role, "content": content})

        if not messages:
            return None, None, None

        text = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        encoded = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=max_len, padding=False)
        input_ids = encoded["input_ids"].to(self.device)

        # Build response mask: 1 for response tokens, 0 for prompt
        # Heuristic: find the last user message boundary
        prompt_len = max(1, int(input_ids.shape[1] * 0.5))
        response_mask = torch.zeros(1, input_ids.shape[1], device=self.device)
        response_mask[0, prompt_len:] = 1.0

        return input_ids, response_mask, prompt_len

    def compute_log_probs(self, input_ids: torch.Tensor) -> torch.Tensor:
        outputs = self.model(input_ids=input_ids)
        logits = outputs.logits[:, :-1, :]
        labels = input_ids[:, 1:]
        log_probs = torch.log_softmax(logits, dim=-1)
        token_log_probs = log_probs.gather(2, labels.unsqueeze(-1)).squeeze(-1)
        return token_log_probs

    def train_step(self, batch: list[dict], advantages_tensor: torch.Tensor, kl_coeff: float = 0.01):
        """One training step over a batch of trajectories with pre-computed advantages."""
        self.model.train()
        total_loss = 0.0
        total_pg = 0.0
        n = 0

        for i, traj in enumerate(batch):
            input_ids, resp_mask, _ = self.tokenize_trajectory(traj.get("turns", []))
            if input_ids is None or input_ids.shape[1] < 3:
                continue

            # Get current log probs
            log_probs = self.compute_log_probs(input_ids)

            # Align advantage with response tokens
            seq_len = log_probs.shape[1]
            resp_mask_aligned = resp_mask[:, :seq_len]
            adv = advantages_tensor[i].item()

            # Policy gradient loss: -advantage * log_prob over response tokens
            pg_loss = -(adv * log_probs * resp_mask_aligned).sum() / resp_mask_aligned.sum().clamp(min=1)
            loss = pg_loss

            loss.backward()
            total_loss += loss.item()
            total_pg += pg_loss.item()
            n += 1

        if n > 0:
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
            self.optimizer.step()
            self.optimizer.zero_grad()

        self.version += 1
        return {"loss": total_loss / max(n, 1), "pg_loss": total_pg / max(n, 1), "n_samples": n, "version": self.version}

    def save(self, path: str):
        self.model.save_pretrained(path)
        self.tokenizer.save_pretrained(path)


def prepare_grpo_batch(trajectories: list[dict], group_size: int = 4):
    """Prepare data for veRL's GRPO advantage computation."""
    rewards = []
    for t in trajectories:
        r = t.get("reward", 0)
        if isinstance(r, dict):
            r = r.get("final_reward", r.get("total", 0))
        rewards.append(float(r))

    n = len(rewards)
    max_resp_len = 1  # outcome reward: single token

    # Build token_level_rewards: (n, 1) — outcome reward at last token
    token_rewards = torch.zeros(n, max_resp_len)
    response_mask = torch.zeros(n, max_resp_len)
    for i, r in enumerate(rewards):
        token_rewards[i, -1] = r
        response_mask[i, -1] = 1.0

    # Group index: every group_size trajectories share a group
    index = np.array([i // group_size for i in range(n)])

    # Use veRL's GRPO
    advantages, returns = compute_grpo_outcome_advantage(
        token_rewards, response_mask, index, epsilon=1e-6,
    )

    # Extract per-trajectory scalar advantage
    adv_scalars = advantages[:, -1]
    return adv_scalars, rewards


async def collect_from_oma(args) -> list[dict]:
    from oma_env import OMAEnvironment
    env = OMAEnvironment(args.oma_url, args.oma_key, args.tasks)
    trajectories = await env.rollout(
        model=args.rollout_model or "claude-sonnet-4-6",
        batch_size=args.batch_size,
        concurrency=args.concurrency,
    )
    return [
        {"task_id": t.task_id, "turns": t.turns, "reward": t.reward,
         "outcome": t.outcome, "num_turns": t.num_turns, "token_usage": t.token_usage}
        for t in trajectories
    ]


def load_from_file(path: str) -> list[dict]:
    data = []
    with open(path) as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))
    return data


async def main():
    parser = argparse.ArgumentParser(description="veRL GRPO trainer (Mac/CPU/CUDA)")
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--rollout-model", help="Model for OMA rollout (default: claude-sonnet-4-6)")
    parser.add_argument("--oma-url", default="http://localhost:8787")
    parser.add_argument("--oma-key", default="test-key")
    parser.add_argument("--tasks", default="rl/tasks/")
    parser.add_argument("--from-file", help="Pre-collected trajectories JSONL")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--group-size", type=int, default=4)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=1e-5)
    parser.add_argument("--output-dir", default="rl/output")
    parser.add_argument("--save-model", help="Save final model to path")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    policy = None if args.dry_run else PolicyModel(args.model, lr=args.lr)

    print(f"\n{'='*60}")
    print(f"veRL GRPO Trainer {'(dry run)' if args.dry_run else ''}")
    print(f"{'='*60}")
    print(f"Train model:    {args.model}")
    print(f"Rollout model:  {args.rollout_model or 'claude-sonnet-4-6'}")
    print(f"Device:         {get_device()}")
    print(f"Batch/Group:    {args.batch_size}/{args.group_size}")
    print(f"Epochs:         {args.epochs}")
    print(f"{'='*60}\n")

    all_metrics = []

    for epoch in range(args.epochs):
        t0 = time.time()
        print(f"\n--- Epoch {epoch+1}/{args.epochs} ---")

        # 1. Collect trajectories
        if args.from_file:
            all_data = load_from_file(args.from_file)
            data = random.sample(all_data, min(args.batch_size, len(all_data)))
        else:
            print("[1/4] Collecting from OMA...")
            data = await collect_from_oma(args)

        if not data:
            print("No data, skip")
            continue

        # Pad to group_size multiple
        while len(data) % args.group_size != 0:
            data.append(random.choice(data))

        # 2. GRPO advantage (veRL)
        print("[2/4] Computing GRPO advantages (veRL)...")
        advantages, rewards = prepare_grpo_batch(data, args.group_size)
        mean_r = sum(rewards) / len(rewards)
        mean_a = advantages.mean().item()
        print(f"       rewards: mean={mean_r:.4f} min={min(rewards):.4f} max={max(rewards):.4f}")
        print(f"       advantages: mean={mean_a:.4f}")

        # Save trajectories
        epoch_file = output_dir / f"epoch_{epoch:04d}.jsonl"
        with open(epoch_file, "w") as f:
            for i, d in enumerate(data):
                d["advantage"] = advantages[i].item()
                d["policy_version"] = policy.version if policy else 0
                f.write(json.dumps(d, default=str) + "\n")

        if args.dry_run:
            print(f"[dry]  Saved {len(data)} trajectories to {epoch_file}")
            all_metrics.append({"epoch": epoch, "mean_reward": mean_r, "mean_advantage": mean_a})
            continue

        # 3. Train step
        print(f"[3/4] Training (veRL GRPO + LoRA)...")
        metrics = policy.train_step(data, advantages)
        duration = time.time() - t0

        metrics.update({"epoch": epoch, "mean_reward": mean_r, "mean_advantage": mean_a, "duration_s": duration})
        all_metrics.append(metrics)

        print(f"[4/4] loss={metrics['loss']:.4f} pg={metrics['pg_loss']:.4f} "
              f"v{metrics['version']} ({duration:.1f}s)")

    # Summary
    print(f"\n{'='*60}")
    print("Training Summary")
    print(f"{'='*60}")
    for m in all_metrics:
        loss_str = f"loss={m.get('loss', 'N/A')}" if 'loss' in m else "dry-run"
        print(f"  Epoch {m['epoch']:2d}: {loss_str:20s} reward={m['mean_reward']:.4f} adv={m['mean_advantage']:+.4f}")

    with open(output_dir / "training_stats.json", "w") as f:
        json.dump(all_metrics, f, indent=2, default=str)

    if policy and args.save_model:
        policy.save(args.save_model)
        print(f"\nModel saved to {args.save_model}")

    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
