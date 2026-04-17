import { batchRollout, loadTaskSet } from "./rollout.js";
import { trajectoryToJsonl, parseTrajectoryJsonl } from "./trajectory.js";
import { computeReward, batchRewardStats } from "./reward.js";
import { loadConfig } from "./config.js";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

function parseCliArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      result[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith("--")) {
      result[args[i].slice(2)] = "true";
    } else if (i === 0) {
      result._command = args[i];
    }
  }
  return result;
}

function loadAllTasks(taskPath: string): any[] {
  const resolved = resolve(taskPath);
  if (resolved.endsWith(".json")) {
    const data = JSON.parse(readFileSync(resolved, "utf-8"));
    return data.tasks || [];
  }
  // directory: load all .json files
  const files = readdirSync(resolved).filter((f) => f.endsWith(".json"));
  const tasks: any[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(resolved, f), "utf-8"));
    tasks.push(...(data.tasks || []));
  }
  return tasks;
}

async function cmdRollout(args: Record<string, string>) {
  const tasks = loadAllTasks(args.tasks || "rl/tasks");
  const config = loadConfig({
    concurrency: args.concurrency ? parseInt(args.concurrency) : undefined,
    model: args.model,
    model_base_url: args["model-url"],
    model_compat: args["model-compat"] as any,
  });

  const result = await batchRollout(tasks, config);

  if (args.output) {
    const jsonl = trajectoryToJsonl(result.trajectories);
    writeFileSync(args.output, jsonl);
    console.log(`[cli] Wrote ${result.trajectories.length} trajectories to ${args.output}`);
  }

  console.log("\n--- Rollout Summary ---");
  console.log(`Total: ${result.stats.total}`);
  console.log(`Success: ${result.stats.success} | Error: ${result.stats.error} | Timeout: ${result.stats.timeout}`);
  console.log(`Mean reward: ${result.stats.mean_reward.toFixed(4)}`);
  console.log(`Mean turns: ${result.stats.mean_turns.toFixed(1)}`);
  console.log(`Mean duration: ${(result.stats.mean_duration_ms / 1000).toFixed(1)}s`);
  console.log(`Total tokens: ${result.stats.total_tokens.input_tokens} in / ${result.stats.total_tokens.output_tokens} out`);
}

async function cmdReward(args: Record<string, string>) {
  if (!args.trajectories) {
    console.error("Usage: rl reward --trajectories <file.jsonl> [--output <scored.jsonl>]");
    process.exit(1);
  }

  const tasks = loadAllTasks(args.tasks || "rl/tasks");
  const taskMap = new Map(tasks.map((t: any) => [t.id, t]));

  const raw = readFileSync(args.trajectories, "utf-8");
  const trajectories = parseTrajectoryJsonl(raw);

  console.log(`[reward] Scoring ${trajectories.length} trajectories...`);

  for (const traj of trajectories) {
    const task = taskMap.get(traj.task_id);
    if (!task) {
      console.warn(`[reward] No task definition for ${traj.task_id}, skipping`);
      continue;
    }
    traj.reward = await computeReward(traj, task);
  }

  const stats = batchRewardStats(trajectories.map((t) => t.reward));
  console.log(`[reward] Mean: ${stats.mean.toFixed(4)} | Min: ${stats.min.toFixed(4)} | Max: ${stats.max.toFixed(4)} | Std: ${stats.std.toFixed(4)}`);

  if (args.output) {
    writeFileSync(args.output, trajectoryToJsonl(trajectories));
    console.log(`[reward] Wrote scored trajectories to ${args.output}`);
  }
}

async function cmdCollect(args: Record<string, string>) {
  console.log("[collect] Full pipeline: rollout → reward → export");
  await cmdRollout({ ...args, output: args.output || "training_data.jsonl" });
}

function usage() {
  console.log(`
OMA RL Pipeline CLI

Commands:
  rollout    Collect trajectories from OMA
  reward     Score existing trajectories
  collect    Full pipeline: rollout → reward → export

Options:
  --tasks <path>         Path to task file or directory (default: rl/tasks)
  --concurrency <n>      Parallel sessions (default: 8)
  --model <id>           Model ID (default: claude-sonnet-4-6)
  --model-url <url>      Model base URL (e.g., http://localhost:8000/v1 for vLLM)
  --model-compat <type>  API compat: ant | oai-compatible (default: ant)
  --output <path>        Output JSONL file
  --trajectories <path>  Input trajectories for reward scoring

Environment:
  OMA_API_URL            OMA API endpoint (default: http://localhost:8787)
  OMA_API_KEY            OMA API key
  RL_MODEL               Default model
  RL_MODEL_BASE_URL      Default model base URL
  RL_CONCURRENCY         Default concurrency
`);
}

async function main() {
  const args = parseCliArgs();
  const command = args._command;

  switch (command) {
    case "rollout":
      await cmdRollout(args);
      break;
    case "reward":
      await cmdReward(args);
      break;
    case "collect":
      await cmdCollect(args);
      break;
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
