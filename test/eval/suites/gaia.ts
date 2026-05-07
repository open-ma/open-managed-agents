import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS } from "../types.js";
import {
  all,
  gaiaMatch,
  idleNoError,
  type Scorer,
} from "../../../packages/shared/src/index.js";
// Stub: RECOMMENDED_AGENT_BASE was removed from shared in 68bf967
// (slim-shared refactor) but gaia.ts still references it. Inline a
// minimal placeholder so the eval runner can load this suite. The real
// content used to live in shared and described how the agent should
// reason; restore from git if needed.
const RECOMMENDED_AGENT_BASE =
  "You are an agent. Use the tools available to answer the question. " +
  "Reason step by step.";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * GAIA benchmark loader.
 *
 * Dataset is gated on HuggingFace (gaia-benchmark/GAIA). To run the full
 * 165-task validation set:
 *   1. Request access at https://huggingface.co/datasets/gaia-benchmark/GAIA
 *   2. HF_TOKEN=hf_xxx ./scripts/fetch-gaia.sh
 *   3. (creates test/eval/data/gaia-validation.jsonl)
 *
 * Without the file present, the suite falls back to a tiny set of
 * paper-public examples so the pipeline can be demoed end-to-end.
 */

interface GaiaRow {
  task_id: string;
  Question: string;
  Level: number;
  "Final answer": string;
  file_name?: string; // attached file in dataset (we don't auto-mount yet)
}

// GAIA-specific framing only — cross-cutting agent guidance comes from
// RECOMMENDED_AGENT_BASE which the agent author opts into. This file just
// adds the benchmark conventions.
const GAIA_TASK_PROMPT_TEXT_ONLY =
  "You are attempting questions from the GAIA benchmark. Use the available tools " +
  "to research the answer.\n\n" +
  "End your final response with a single line:\n" +
  "  Final answer: X\n" +
  "Where X is the shortest possible answer (a number, a name, a short phrase, or " +
  "a comma-separated list). Do NOT include reasoning in the final-answer line — " +
  "put it above.";

const GAIA_TASK_PROMPT_MULTIMODAL =
  GAIA_TASK_PROMPT_TEXT_ONLY +
  "\n\nThis question references an attached file mounted at " +
  "/mnt/session/uploads/<filename> in the sandbox. If it's an image, use " +
  "mcp_minimax_tp_call(tool_name='understand_image', arguments={prompt:'<your question>', image_source:'<file path>'}) " +
  "to read it.";

function composeSystem(taskPrompt: string): string {
  // Stack the recommended baseline + the GAIA-specific framing. Order
  // matters: baseline first sets behavior, task prompt last sets context.
  return `${RECOMMENDED_AGENT_BASE}\n\n---\n\n${taskPrompt}`;
}

/**
 * MCP server config for MiniMax Token Plan MCP — gives non-vision models
 * (MiniMax-M2-highspeed) the ability to read images via the understand_image
 * tool. Spawned in-sandbox via uv. Caller must provide MINIMAX_API_KEY +
 * MINIMAX_API_HOST via env vars at runner-startup.
 */
function buildMiniMaxMcpServer() {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.OMA_MINIMAX_API_KEY;
  const apiHost = process.env.MINIMAX_API_HOST || "https://api.minimaxi.com";
  if (!apiKey) {
    console.warn(
      "[gaia] MINIMAX_API_KEY not set — multimodal GAIA tasks will fail to call understand_image.",
    );
  }
  return {
    name: "minimax_tp",
    type: "stdio",
    stdio: {
      command: "uv",
      args: [
        "run",
        "--no-project",
        "--with",
        "minimax-coding-plan-mcp",
        "python",
        "-c",
        "from minimax_mcp.server import mcp; mcp.settings.host='127.0.0.1'; mcp.settings.port=8765; mcp.settings.stateless_http=True; mcp.run(transport='streamable-http')",
      ],
      env: {
        MINIMAX_API_KEY: apiKey || "",
        MINIMAX_API_HOST: apiHost,
      },
      port: 8765,
      sse_path: "/mcp",
      ready_timeout_ms: 120_000,
    },
  };
}

function rowToTask(row: GaiaRow, indexInLevel: number): EvalTask {
  const isMultimodal = !!row.file_name;
  const scorer: Scorer = all(
    gaiaMatch(row["Final answer"]),
    idleNoError(),
  );
  const agentConfig: EvalTask["agentConfig"] & { mcp_servers?: unknown[] } = {
    system: composeSystem(isMultimodal ? GAIA_TASK_PROMPT_MULTIMODAL : GAIA_TASK_PROMPT_TEXT_ONLY),
    tools: DEFAULT_TOOLS,
    // Same model for main + aux — exercises the new web_fetch summarize +
    // /workspace/.web/ offload path. Cheaper aux (e.g. M2-highspeed-fast)
    // can be wired here later if we want to A/B cost vs quality.
    aux_model: "MiniMax-M2-highspeed",
  };
  if (isMultimodal) {
    // Inject MiniMax MCP for image understanding (non-vision models need it).
    agentConfig.mcp_servers = [buildMiniMaxMcpServer()];
  }
  return {
    id: `GAIA-L${row.Level}-${indexInLevel + 1}-${row.task_id.slice(0, 8)}`,
    category: "tool-use",
    difficulty: row.Level === 1 ? "easy" : row.Level === 2 ? "medium" : "hard",
    description: `GAIA L${row.Level}${isMultimodal ? " [+file]" : ""}: ${row.Question.slice(0, 80)}${row.Question.length > 80 ? "..." : ""}`,
    agentConfig,
    turns: [
      {
        message: row.Question,
        verify: () => ({ status: "pass", message: "advisory only" }),
      },
    ],
    scorer,
    timeoutMs: 1_800_000, // 30 min — GAIA tasks can require many browse steps
    metadata: {
      gaia_task_id: row.task_id,
      gaia_level: row.Level,
      gaia_expected_answer: row["Final answer"],
      gaia_file_name: row.file_name || null,
      gaia_multimodal: isMultimodal,
    },
  } as EvalTask;
}

/** Paper-public GAIA examples (used when the gated dataset isn't available). */
const FALLBACK_ROWS: GaiaRow[] = [
  {
    task_id: "fallback-l1-1",
    Level: 1,
    Question:
      "How many studio albums were published by Mercedes Sosa between 2000 and 2009 (included)? You can use the latest 2022 version of english wikipedia.",
    "Final answer": "3",
  },
  {
    task_id: "fallback-l1-2",
    Level: 1,
    Question:
      "What is the surname of the equine veterinarian mentioned in 1.E Exercises from the chemistry materials licensed by Marisa Alviar-Agnew & Henry Agnew under the CK-12 license in LibreText's Introductory Chemistry materials as compiled 08/21/2023?",
    "Final answer": "Louvrier",
  },
  {
    task_id: "fallback-l1-3",
    Level: 1,
    Question:
      "I'm researching species that became invasive after people who kept them as pets released them. There's a certain species of fish that was popularized as a pet by being the main character of the movie Finding Nemo. According to the USGS, where was this fish found as a nonnative species, before the year 2020? I need a list of states that the fish was found in.",
    "Final answer": "Florida, California",
  },
];

function loadFromDisk(): GaiaRow[] | null {
  const path = resolve(process.cwd(), "test/eval/data/gaia-validation.jsonl");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const rows: GaiaRow[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      rows.push(JSON.parse(trimmed) as GaiaRow);
    }
    return rows;
  } catch (err) {
    console.warn(`[gaia] Failed to load gaia-validation.jsonl: ${(err as Error).message}`);
    return null;
  }
}

function buildSuite(): EvalTask[] {
  const fromDisk = loadFromDisk();
  const rows = fromDisk ?? FALLBACK_ROWS;
  if (!fromDisk) {
    console.log(
      "[gaia] Using paper-public fallback (3 tasks). Run scripts/fetch-gaia.sh " +
        "with HF_TOKEN to load the full 165-task validation set.",
    );
  }
  // Group by level to keep IDs readable
  const byLevel = new Map<number, GaiaRow[]>();
  for (const r of rows) {
    if (!byLevel.has(r.Level)) byLevel.set(r.Level, []);
    byLevel.get(r.Level)!.push(r);
  }
  const out: EvalTask[] = [];
  for (const level of [1, 2, 3]) {
    const list = byLevel.get(level) || [];
    list.forEach((row, i) => out.push(rowToTask(row, i)));
  }
  return out;
}

export const gaiaSuite: EvalTask[] = buildSuite();
