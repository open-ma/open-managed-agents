"""
Standalone GRPO training loop using OMA as the environment.

This is the fallback approach when veRL integration is not available.
For production training, use veRL or Tinker directly with oma_env.py.

Usage:
    python grpo_loop.py \
        --model Qwen/Qwen2.5-7B \
        --oma-url http://localhost:8787 \
        --oma-key test-key \
        --tasks rl/tasks/ \
        --batch-size 16 \
        --epochs 10
"""

import argparse
import asyncio
import json
import time
from pathlib import Path

from oma_env import OMAEnvironment


def parse_args():
    parser = argparse.ArgumentParser(description="GRPO training with OMA environment")
    parser.add_argument("--model", type=str, required=True, help="Model ID for vLLM")
    parser.add_argument("--model-url", type=str, default="http://localhost:8000/v1", help="vLLM endpoint")
    parser.add_argument("--oma-url", type=str, default="http://localhost:8787", help="OMA API URL")
    parser.add_argument("--oma-key", type=str, default="test-key", help="OMA API key")
    parser.add_argument("--tasks", type=str, default="rl/tasks/", help="Task directory or file")
    parser.add_argument("--batch-size", type=int, default=16, help="Rollout batch size")
    parser.add_argument("--concurrency", type=int, default=8, help="Parallel rollouts")
    parser.add_argument("--epochs", type=int, default=10, help="Training epochs")
    parser.add_argument("--output-dir", type=str, default="rl/output", help="Output directory for trajectories")
    parser.add_argument("--dry-run", action="store_true", help="Only collect trajectories, no training")
    return parser.parse_args()


async def collect_epoch(env: OMAEnvironment, model: str, model_url: str, batch_size: int, concurrency: int):
    """Collect one epoch of on-policy trajectories."""
    trajectories = await env.rollout(
        model=model,
        model_base_url=model_url,
        batch_size=batch_size,
        concurrency=concurrency,
    )
    return trajectories


def compute_grpo_advantages(rewards: list[float], group_size: int = None) -> list[float]:
    """
    Group Relative Policy Optimization (GRPO) advantage computation.
    Uses group mean as baseline instead of a learned value function.
    """
    if not rewards:
        return []

    if group_size is None:
        group_size = len(rewards)

    advantages = []
    for i in range(0, len(rewards), group_size):
        group = rewards[i : i + group_size]
        baseline = sum(group) / len(group)
        std = (sum((r - baseline) ** 2 for r in group) / len(group)) ** 0.5
        std = max(std, 1e-8)  # avoid division by zero
        advantages.extend([(r - baseline) / std for r in group])

    return advantages


async def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    env = OMAEnvironment(args.oma_url, args.oma_key, args.tasks)

    print(f"\n{'='*60}")
    print(f"OMA GRPO Training Loop")
    print(f"{'='*60}")
    print(f"Model:       {args.model}")
    print(f"Model URL:   {args.model_url}")
    print(f"OMA URL:     {args.oma_url}")
    print(f"Tasks:       {len(env.tasks)}")
    print(f"Batch size:  {args.batch_size}")
    print(f"Concurrency: {args.concurrency}")
    print(f"Epochs:      {args.epochs}")
    print(f"Dry run:     {args.dry_run}")
    print(f"{'='*60}\n")

    all_stats = []

    for epoch in range(args.epochs):
        epoch_start = time.time()
        print(f"\n--- Epoch {epoch + 1}/{args.epochs} ---")

        # 1. Collect on-policy trajectories
        print("[1/3] Collecting trajectories...")
        trajectories = await collect_epoch(
            env, args.model, args.model_url, args.batch_size, args.concurrency
        )

        if not trajectories:
            print("No trajectories collected, skipping epoch")
            continue

        # 2. Compute GRPO advantages
        rewards = [t.reward for t in trajectories]
        advantages = compute_grpo_advantages(rewards)

        print(f"[2/3] Rewards: mean={sum(rewards)/len(rewards):.4f} "
              f"min={min(rewards):.4f} max={max(rewards):.4f}")

        # 3. Save trajectories (for offline analysis or external training)
        epoch_file = output_dir / f"epoch_{epoch:04d}.jsonl"
        with open(epoch_file, "w") as f:
            for traj, adv in zip(trajectories, advantages):
                record = {
                    "task_id": traj.task_id,
                    "reward": traj.reward,
                    "advantage": adv,
                    "num_turns": traj.num_turns,
                    "duration_ms": traj.duration_ms,
                    "outcome": traj.outcome,
                    "token_usage": traj.token_usage,
                    "turns": traj.turns,
                }
                f.write(json.dumps(record) + "\n")

        epoch_duration = time.time() - epoch_start
        epoch_stats = {
            "epoch": epoch,
            "num_trajectories": len(trajectories),
            "mean_reward": sum(rewards) / len(rewards),
            "mean_advantage": sum(advantages) / len(advantages),
            "success_rate": sum(1 for t in trajectories if t.outcome == "success") / len(trajectories),
            "duration_s": epoch_duration,
        }
        all_stats.append(epoch_stats)

        print(f"[3/3] Saved to {epoch_file} ({epoch_duration:.1f}s)")

        if not args.dry_run:
            # TODO: Connect to veRL/Tinker for actual gradient updates
            # For now, this loop only collects data + computes advantages
            print("[train] Gradient update placeholder — connect veRL or Tinker here")

    # Summary
    print(f"\n{'='*60}")
    print("Training Summary")
    print(f"{'='*60}")
    for s in all_stats:
        print(f"  Epoch {s['epoch']:3d}: reward={s['mean_reward']:.4f} "
              f"success={s['success_rate']:.1%} ({s['duration_s']:.1f}s)")

    # Save stats
    stats_file = output_dir / "training_stats.json"
    with open(stats_file, "w") as f:
        json.dump(all_stats, f, indent=2)
    print(f"\nStats saved to {stats_file}")


if __name__ == "__main__":
    asyncio.run(main())
