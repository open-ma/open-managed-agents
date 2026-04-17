"""
Tinker integration recipe for OMA.

Registers OMA as an Atropos environment in the Tinker training platform.
See: https://github.com/thinking-machines-lab/tinker-cookbook
"""

import asyncio
from oma_env import OMAEnvironment


def create_tinker_recipe(
    oma_url: str,
    oma_key: str,
    task_path: str,
    model: str = "Qwen/Qwen2.5-7B",
    batch_size: int = 64,
    num_epochs: int = 10,
    learning_rate: float = 1e-5,
):
    """
    Create a Tinker-compatible training recipe using OMA as the environment.

    This bridges OMA's agent execution environment with Tinker's
    distributed training infrastructure via the Atropos protocol.
    """
    env = OMAEnvironment(oma_url, oma_key, task_path)

    # Tinker recipe structure
    # Reference: https://tinker-docs.thinkingmachines.ai/
    recipe = {
        "model": model,
        "algorithm": "grpo",
        "hyperparameters": {
            "learning_rate": learning_rate,
            "batch_size": batch_size,
            "num_epochs": num_epochs,
            "grpo_group_size": 4,
            "kl_coeff": 0.01,
            "clip_range": 0.2,
            "max_grad_norm": 1.0,
        },
        "environment": {
            "type": "custom",
            "name": "oma-agent-env",
            "rollout_fn": env.rollout,
            "reward_fn": env.compute_rewards,
        },
        "lora": {
            "enabled": True,
            "r": 16,
            "alpha": 32,
            "target_modules": ["q_proj", "v_proj", "k_proj", "o_proj"],
        },
    }

    return recipe


async def main():
    """Example: run training with Tinker."""
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-7B")
    parser.add_argument("--oma-url", default="http://localhost:8787")
    parser.add_argument("--oma-key", default="test-key")
    parser.add_argument("--tasks", default="rl/tasks/")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=10)
    args = parser.parse_args()

    recipe = create_tinker_recipe(
        oma_url=args.oma_url,
        oma_key=args.oma_key,
        task_path=args.tasks,
        model=args.model,
        batch_size=args.batch_size,
        num_epochs=args.epochs,
    )

    print("Tinker Recipe:")
    import json
    print(json.dumps({k: v for k, v in recipe.items() if k != "environment"}, indent=2))
    print(f"\nEnvironment: OMA ({len(recipe['environment']['rollout_fn'].__self__.tasks)} tasks)")

    # To actually run with Tinker:
    # from tinker import TinkerClient
    # client = TinkerClient()
    # client.train(**recipe)
    print("\nTo run: install tinker and uncomment the TinkerClient code above.")


if __name__ == "__main__":
    asyncio.run(main())
