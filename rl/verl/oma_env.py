"""
OMA Environment for veRL / Tinker Atropos.

Bridges OMA's rollout service to veRL's training loop,
enabling on-policy GRPO training on agent trajectories.
"""

import json
import random
import asyncio
import aiohttp
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from pathlib import Path


@dataclass
class Trajectory:
    task_id: str
    session_id: str
    turns: List[Dict[str, Any]]
    reward: float
    reward_breakdown: Dict[str, float]
    token_usage: Dict[str, int]
    num_turns: int
    duration_ms: int
    outcome: str  # success | failure | error | timeout
    metadata: Dict[str, Any] = field(default_factory=dict)


class OMAClient:
    """HTTP client for OMA Session API."""

    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.headers = {"x-api-key": api_key, "Content-Type": "application/json"}

    async def _post(self, path: str, body: dict, session: aiohttp.ClientSession) -> dict:
        async with session.post(
            f"{self.api_url}{path}", json=body, headers=self.headers, timeout=aiohttp.ClientTimeout(total=300)
        ) as resp:
            resp.raise_for_status()
            text = await resp.text()
            return json.loads(text) if text else {}

    async def _get(self, path: str, session: aiohttp.ClientSession) -> dict:
        async with session.get(
            f"{self.api_url}{path}", headers=self.headers, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            resp.raise_for_status()
            text = await resp.text()
            return json.loads(text) if text else {}

    async def _delete(self, path: str, session: aiohttp.ClientSession):
        try:
            async with session.delete(f"{self.api_url}{path}", headers=self.headers) as resp:
                pass
        except Exception:
            pass

    async def create_agent(self, session: aiohttp.ClientSession, model: str, system: str = None) -> str:
        data = await self._post("/v1/agents", {
            "name": f"rl-{random.randint(0, 99999):05d}",
            "model": model,
            "system": system or "You are a helpful assistant. Complete tasks precisely and efficiently.",
            "tools": [{"type": "agent_toolset_20260401", "default_config": {"enabled": True}}],
        }, session)
        return data["id"]

    async def create_session(self, agent_id: str, env_id: str, session: aiohttp.ClientSession) -> str:
        data = await self._post("/v1/sessions", {
            "agent": agent_id,
            "environment_id": env_id,
            "title": f"rl-{random.randint(0, 99999):05d}",
        }, session)
        return data["id"]

    async def get_environment(self, session: aiohttp.ClientSession) -> str:
        data = await self._get("/v1/environments", session)
        envs = data.get("data", [])
        ready = [e for e in envs if e.get("status") == "ready"]
        if ready:
            return ready[0]["id"]
        data = await self._post("/v1/environments", {
            "name": f"rl-env-{random.randint(0, 99999)}",
            "config": {"type": "cloud", "networking": {"type": "unrestricted"}},
        }, session)
        return data["id"]

    async def send_and_wait(
        self, session_id: str, message: str, http_session: aiohttp.ClientSession, timeout_ms: int = 300000
    ) -> List[dict]:
        # Get current event count
        before = await self._get(f"/v1/sessions/{session_id}/events?limit=1000&order=asc", http_session)
        before_events = before.get("data", [])
        last_seq = max((e.get("seq", 0) for e in before_events), default=0)

        # Post message
        await self._post(f"/v1/sessions/{session_id}/events", {
            "events": [{"type": "user.message", "content": [{"type": "text", "text": message}]}],
        }, http_session)

        # Poll for completion
        await asyncio.sleep(2)
        start = asyncio.get_event_loop().time()
        timeout_s = timeout_ms / 1000
        all_events = []

        while (asyncio.get_event_loop().time() - start) < timeout_s:
            data = await self._get(
                f"/v1/sessions/{session_id}/events?limit=1000&order=asc&after_seq={last_seq}", http_session
            )
            events = data.get("data", [])
            for e in events:
                parsed = json.loads(e["data"]) if isinstance(e.get("data"), str) else e.get("data", e)
                parsed["_seq"] = e.get("seq", 0)
                all_events.append(parsed)
                last_seq = max(last_seq, e.get("seq", 0))

            terminal = any(
                e.get("type") in ("session.status_idle", "session.error", "session.status_terminated")
                for e in all_events
            )
            if terminal:
                return all_events

            await asyncio.sleep(3)

        raise TimeoutError(f"Session {session_id} did not complete within {timeout_ms}ms")


class OMAEnvironment:
    """
    veRL custom environment that delegates rollouts to OMA.

    Usage with veRL:
        env = OMAEnvironment(oma_url, oma_key, "rl/tasks/")
        # veRL calls env.rollout() during training to collect on-policy data

    Usage with Tinker Atropos:
        env = OMAEnvironment(oma_url, oma_key, "rl/tasks/")
        # Register as Atropos environment
    """

    def __init__(self, oma_url: str, oma_key: str, task_path: str):
        self.client = OMAClient(oma_url, oma_key)
        self.tasks = self._load_tasks(task_path)
        print(f"[oma_env] Loaded {len(self.tasks)} tasks from {task_path}")

    def _load_tasks(self, path: str) -> List[dict]:
        p = Path(path)
        tasks = []
        if p.is_file():
            with open(p) as f:
                data = json.load(f)
                tasks.extend(data.get("tasks", []))
        elif p.is_dir():
            for f in sorted(p.glob("*.json")):
                with open(f) as fh:
                    data = json.load(fh)
                    tasks.extend(data.get("tasks", []))
        return tasks

    async def rollout(
        self,
        model: str,
        model_base_url: Optional[str] = None,
        batch_size: int = 16,
        concurrency: int = 8,
    ) -> List[Trajectory]:
        """
        Collect on-policy trajectories from OMA.
        Called by veRL during each training epoch.
        """
        sampled = random.choices(self.tasks, k=batch_size)

        async with aiohttp.ClientSession() as session:
            env_id = await self.client.get_environment(session)
            sem = asyncio.Semaphore(concurrency)

            async def run_one(task: dict) -> Trajectory:
                async with sem:
                    return await self._execute_task(task, model, env_id, session)

            results = await asyncio.gather(*[run_one(t) for t in sampled], return_exceptions=True)

        trajectories = []
        for r in results:
            if isinstance(r, Trajectory):
                trajectories.append(r)
            else:
                print(f"[oma_env] Rollout error: {r}")

        rewards = [t.reward for t in trajectories]
        mean_r = sum(rewards) / len(rewards) if rewards else 0
        print(f"[oma_env] Batch done: {len(trajectories)}/{batch_size} success, mean_reward={mean_r:.4f}")

        return trajectories

    async def _execute_task(
        self, task: dict, model: str, env_id: str, http_session: aiohttp.ClientSession
    ) -> Trajectory:
        import time
        start = time.time()

        agent_id = await self.client.create_agent(http_session, model)
        session_id = await self.client.create_session(agent_id, env_id, http_session)

        try:
            # Setup files
            if task.get("setup_files"):
                file_msg = "\n\n".join(
                    f"Create the file {f['path']} with exactly this content:\n```\n{f['content']}\n```"
                    for f in task["setup_files"]
                )
                await self.client.send_and_wait(
                    session_id,
                    f"Create the following files exactly as specified:\n\n{file_msg}",
                    http_session,
                )

            # Execute task
            events = await self.client.send_and_wait(
                session_id, task["message"], http_session,
                timeout_ms=task.get("timeout_ms", 300000),
            )

            # Compute reward from events
            reward, breakdown = self._compute_reward(events, task)
            duration_ms = int((time.time() - start) * 1000)

            has_error = any(e.get("type") == "session.error" for e in events)
            outcome = "error" if has_error else "success"

            # Extract token usage
            token_usage = {"input_tokens": 0, "output_tokens": 0}
            for e in events:
                if e.get("type") == "span.model_request_end":
                    usage = e.get("model_usage", {})
                    token_usage["input_tokens"] += usage.get("input_tokens", 0)
                    token_usage["output_tokens"] += usage.get("output_tokens", 0)

            num_turns = sum(1 for e in events if e.get("type") == "agent.message")

            return Trajectory(
                task_id=task["id"],
                session_id=session_id,
                turns=events,
                reward=reward,
                reward_breakdown=breakdown,
                token_usage=token_usage,
                num_turns=num_turns,
                duration_ms=duration_ms,
                outcome=outcome,
                metadata={"model": model},
            )
        finally:
            await self.client._delete(f"/v1/sessions/{session_id}", http_session)
            await self.client._delete(f"/v1/agents/{agent_id}", http_session)

    def _compute_reward(self, events: List[dict], task: dict) -> tuple:
        """Rule-based reward computation matching rl/reward.ts logic."""
        spec = task.get("reward", {})
        rules = spec.get("rules", [])

        all_output = " ".join(
            str(e.get("content", ""))
            for e in events
            if e.get("type") in ("agent.tool_result", "agent.message")
        )

        total = 0.0
        breakdown = {}

        for rule in rules:
            check = rule.get("check")
            expected = rule.get("expected", "")
            score = rule.get("score", 0)

            if check == "file_contains" or check == "bash_output_contains":
                if expected in all_output:
                    total += score
                    breakdown[f"{check}:{expected[:20]}"] = score
            elif check == "file_exists":
                path = rule.get("path", "")
                if path in all_output:
                    total += score
                    breakdown[f"file_exists:{path}"] = score
            elif check == "exit_code":
                has_error = any(e.get("type") == "session.error" for e in events)
                if expected == "0" and not has_error:
                    total += score
                    breakdown["exit_code:0"] = score

        total = min(total, 1.0)
        return total, breakdown

    def compute_rewards(self, trajectories: List[Trajectory]) -> List[float]:
        """Called by veRL after rollout."""
        return [t.reward for t in trajectories]
