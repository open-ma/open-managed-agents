/**
 * Quick summarizer: read a results JSONL and emit a Markdown table + per-task
 * verifier output. Used to fill in `findings-*.md`.
 *
 * Usage: npx tsx rl/tasks/terminal-bench/summarize.ts <results.jsonl>
 */

import { readFileSync } from "node:fs";

interface Trajectory {
  task_id: string;
  session_id: string;
  outcome: string;
  num_turns: number;
  duration_ms: number;
  reward: { total?: number };
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
  metadata: {
    model_id: string;
    verifier_result?: { exit_code: number; output: string };
  };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: tsx summarize.ts <results.jsonl>");
    process.exit(2);
  }
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const trajs: Trajectory[] = lines.filter(Boolean).map((l) => JSON.parse(l));

  console.log("## Per-task table\n");
  console.log("| Task | Outcome | Reward | Turns | Duration | Verifier exit | Session |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of trajs) {
    const r = t.reward.total ?? 0;
    const dur = (t.duration_ms / 1000).toFixed(1) + "s";
    const ex = t.metadata.verifier_result?.exit_code ?? "n/a";
    console.log(
      `| \`${t.task_id}\` | ${t.outcome} | ${r.toFixed(3)} | ${t.num_turns} | ${dur} | ${ex} | \`${t.session_id}\` |`,
    );
  }

  const passed = trajs.filter((t) => (t.reward.total ?? 0) >= 0.5).length;
  const totalIn = trajs.reduce((s, t) => s + t.token_usage.input_tokens, 0);
  const totalOut = trajs.reduce((s, t) => s + t.token_usage.output_tokens, 0);
  const meanReward = trajs.reduce((s, t) => s + (t.reward.total ?? 0), 0) / trajs.length;
  const totalDur = trajs.reduce((s, t) => s + t.duration_ms, 0);
  console.log(
    `\n**Aggregate**: ${passed}/${trajs.length} pass · mean reward ${meanReward.toFixed(3)} · total ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens · wall ${(totalDur / 1000).toFixed(0)}s\n`,
  );

  console.log("## Verifier output (failures only)\n");
  const failed = trajs.filter((t) => (t.metadata.verifier_result?.exit_code ?? -1) !== 0);
  if (failed.length === 0) {
    console.log("_None — all verifiers returned 0._\n");
  } else {
    for (const t of failed) {
      console.log(`### \`${t.task_id}\` (${t.session_id})\n`);
      console.log("```");
      console.log((t.metadata.verifier_result?.output ?? "(no output)").slice(-1500));
      console.log("```\n");
    }
  }
}

main();
