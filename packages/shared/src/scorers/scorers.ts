// Scorer implementations.
//
// Each scorer is a higher-order function: takes config, returns a Scorer
// (= function from Trajectory to Score).
//
// Naming convention: lowercase verb (matches Inspect AI / Anthropic-style).

import type { Trajectory } from "../trajectory/types.js";
import type { Score, Scorer } from "./types.js";
import {
  collectAllText,
  getAgentMessageTexts,
  getToolResults,
  getToolResultFor,
  getToolUses,
  hasSessionError,
  reachedIdle,
} from "./helpers.js";

const pass = (reason: string, value = 1, metadata?: Record<string, unknown>): Score => ({
  pass: true,
  value,
  reason,
  metadata,
});

const fail = (reason: string, value = 0, metadata?: Record<string, unknown>): Score => ({
  pass: false,
  value,
  reason,
  metadata,
});

// ---------- Text matching (case-insensitive default) ----------

/** Substring presence in agent messages + tool results. Case-insensitive by default. */
export function includes(target: string, opts?: { caseInsensitive?: boolean }): Scorer {
  const ci = opts?.caseInsensitive !== false;
  return (trajectory) => {
    const haystack = collectAllText(trajectory);
    const found = ci
      ? haystack.toLowerCase().includes(target.toLowerCase())
      : haystack.includes(target);
    return found
      ? pass(`Found "${target}" in trajectory`)
      : fail(`"${target}" not found in trajectory`);
  };
}

/** Regex match across collected agent text + tool results. */
export function regex(pattern: RegExp): Scorer {
  return (trajectory) => {
    const haystack = collectAllText(trajectory);
    const m = haystack.match(pattern);
    return m
      ? pass(`Pattern ${pattern} matched: "${m[0].slice(0, 80)}"`)
      : fail(`Pattern ${pattern} did not match`);
  };
}

// ---------- Tool-level checks ----------

/** Strict tool-name presence — for tests where the tool itself is the subject. */
export function toolUsed(name: string): Scorer {
  return (trajectory) => {
    const uses = getToolUses(trajectory).filter((u) => u.name === name);
    return uses.length > 0
      ? pass(`Tool "${name}" used ${uses.length} time(s)`)
      : fail(`Tool "${name}" was never used`);
  };
}

/** Tool-name absence. */
export function toolNotUsed(name: string): Scorer {
  return (trajectory) => {
    const uses = getToolUses(trajectory).filter((u) => u.name === name);
    return uses.length === 0
      ? pass(`Tool "${name}" correctly not used`)
      : fail(`Tool "${name}" used ${uses.length} time(s) but should not have been`);
  };
}

/** Predicate over the result content of a specific tool. */
export function toolOutcome(
  name: string,
  predicate: (content: string, input: Record<string, unknown>) => boolean,
): Scorer {
  return (trajectory) => {
    const uses = getToolUses(trajectory).filter((u) => u.name === name);
    for (const use of uses) {
      if (!use.id) continue;
      const result = getToolResultFor(trajectory, use.id);
      if (!result) continue;
      if (predicate(result.content, use.input)) {
        return pass(`Tool "${name}" outcome predicate matched`);
      }
    }
    return fail(`No "${name}" tool result satisfied predicate`, 0, {
      candidate_count: uses.length,
    });
  };
}

// ---------- Bash-specific (very common) ----------

/** Last bash command exits with the expected code. Parses `exit=N` from result. */
export function bashExit(expectedCode: number): Scorer {
  return (trajectory) => {
    const bashUses = getToolUses(trajectory).filter((u) => u.name === "bash");
    if (bashUses.length === 0) return fail("No bash tool calls found");
    const last = bashUses[bashUses.length - 1];
    if (!last.id) return fail("Last bash call missing id");
    const result = getToolResultFor(trajectory, last.id);
    if (!result) return fail("No result for last bash call");
    const m = result.content.match(/exit=(\d+)/);
    if (!m) return fail(`Last bash output has no "exit=N" marker`);
    const actual = parseInt(m[1], 10);
    return actual === expectedCode
      ? pass(`Last bash exited with ${expectedCode}`)
      : fail(`Last bash exited with ${actual}, expected ${expectedCode}`);
  };
}

/** Last bash command exited 0 OR succeeded heuristically (no error/traceback). */
export function bashSuccess(): Scorer {
  return (trajectory) => {
    const bashUses = getToolUses(trajectory).filter((u) => u.name === "bash");
    if (bashUses.length === 0) return fail("No bash tool calls found");
    const last = bashUses[bashUses.length - 1];
    if (!last.id) return fail("Last bash call missing id");
    const result = getToolResultFor(trajectory, last.id);
    if (!result) return fail("No result for last bash call");
    const m = result.content.match(/exit=(\d+)/);
    if (m && m[1] === "0") return pass("Last bash exited with 0");
    if (m) return fail(`Last bash exited with ${m[1]}`);
    const lower = result.content.toLowerCase();
    if (!lower.includes("error") && !lower.includes("traceback")) {
      return pass("Last bash completed (no exit code, no error markers)");
    }
    return fail("Last bash output contains error markers", 0, {
      output_preview: result.content.slice(0, 200),
    });
  };
}

/** Search bash output for an explicit marker (the `ALL_X_PASSED` pattern). */
export function bashOutputMarker(marker: string): Scorer {
  return (trajectory) => {
    const bashResults = getToolResults(trajectory).filter((r) =>
      // Only count results that were preceded by a bash tool_use with matching id
      getToolUses(trajectory).some((u) => u.name === "bash" && u.id === r.tool_use_id),
    );
    const found = bashResults.some((r) => r.content.includes(marker));
    return found
      ? pass(`Bash output contained marker "${marker}"`)
      : fail(`No bash output contained marker "${marker}"`);
  };
}

// ---------- File-level ----------

/** Some `write` tool was invoked with the given file_path. */
export function fileWritten(filePath: string): Scorer {
  return (trajectory) => {
    const writes = getToolUses(trajectory).filter(
      (u) => u.name === "write" && (u.input as { file_path?: string }).file_path === filePath,
    );
    return writes.length > 0
      ? pass(`File "${filePath}" was written`)
      : fail(`File "${filePath}" was never written via write tool`);
  };
}

// ---------- Lifecycle ----------

/** Session reached idle without errors. */
export function idleNoError(): Scorer {
  return (trajectory) => {
    if (hasSessionError(trajectory)) return fail("Session emitted session.error");
    if (!reachedIdle(trajectory)) return fail("Session never reached idle");
    return pass("Session reached idle without errors");
  };
}

/** Agent message contains a substring (case-insensitive default). */
export function agentMessageContains(target: string, opts?: { caseInsensitive?: boolean }): Scorer {
  const ci = opts?.caseInsensitive !== false;
  return (trajectory) => {
    const msgs = getAgentMessageTexts(trajectory);
    const found = ci
      ? msgs.some((m) => m.toLowerCase().includes(target.toLowerCase()))
      : msgs.some((m) => m.includes(target));
    return found
      ? pass(`Agent message contains "${target}"`)
      : fail(`No agent message contains "${target}"`);
  };
}

/** At least N session.thread_created events (multi-agent delegation occurred). */
export function threadCreated(minCount = 1): Scorer {
  return (trajectory) => {
    const count = trajectory.events.filter((e) => e.type === "session.thread_created").length;
    return count >= minCount
      ? pass(`${count} sub-agent thread(s) created (>= ${minCount})`)
      : fail(`Only ${count} sub-agent threads, expected >= ${minCount}`);
  };
}

// ---------- GAIA-style normalized exact match ----------

/**
 * Normalize a free-form answer string the way the GAIA benchmark scorer does:
 * lower-case, strip articles + most punctuation, collapse whitespace, treat
 * numbers as numbers (so "1,234" == "1234"). Used by gaiaMatch().
 */
export function normalizeGaiaAnswer(s: string): string {
  let out = String(s).trim().toLowerCase();
  // Strip a leading "answer: " prefix the model often adds.
  out = out.replace(/^(?:final\s+answer|answer)[:\s]+/i, "");
  // Drop surrounding quotes.
  out = out.replace(/^["'`]+|["'`]+$/g, "");
  // Numeric form: drop commas/$/spaces from numbers ("1,234" → "1234"; "$5.00" → "5.00").
  if (/^[\$\£\€]?[\d,]+(\.\d+)?\s*[%]?$/.test(out)) {
    out = out.replace(/[\$\£\€,\s%]/g, "");
  }
  // Strip surrounding articles + punctuation
  out = out
    .replace(/\b(a|an|the)\s+/g, "")
    .replace(/[.,;:!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/**
 * GAIA-style scorer: takes the agent's last message, normalizes it the same
 * way as the expected answer, and checks for normalized exact-match. The
 * agent is asked to end with "Final answer: X" by the suite prompt; we look
 * at the last line first, falling back to the whole final message.
 */
export function gaiaMatch(expected: string): Scorer {
  const expectedNorm = normalizeGaiaAnswer(expected);
  return (trajectory) => {
    const messages = getAgentMessageTexts(trajectory);
    if (messages.length === 0) return fail("No agent message");
    const last = messages[messages.length - 1].trim();
    // Prefer the last non-empty line — agents often write reasoning then a
    // single-line final answer.
    const lastLine = last.split(/\r?\n/).reverse().find((l) => l.trim().length > 0) || last;
    const candidates = [lastLine, last];
    for (const c of candidates) {
      const norm = normalizeGaiaAnswer(c);
      if (norm === expectedNorm) {
        return pass(`Match: "${expectedNorm}"`);
      }
    }
    const seen = normalizeGaiaAnswer(lastLine);
    return fail(`Expected "${expectedNorm}", got "${seen.slice(0, 100)}"`);
  };
}

// ---------- Combinators ----------

/** All scorers must pass. Aggregated value = average. */
export function all(...scorers: Scorer[]): Scorer {
  return async (trajectory) => {
    const results = await Promise.all(scorers.map((s) => Promise.resolve(s(trajectory))));
    const failures = results.filter((r) => !r.pass);
    const avg = results.reduce((sum, r) => sum + r.value, 0) / Math.max(1, results.length);
    if (failures.length === 0) {
      return pass(`All ${results.length} checks passed`, avg, { children: results });
    }
    return fail(
      `${failures.length}/${results.length} checks failed`,
      avg,
      { children: results, failures: failures.map((f) => f.reason) },
    );
  };
}

/** Any scorer passes — returns first success. */
export function any(...scorers: Scorer[]): Scorer {
  return async (trajectory) => {
    const results = await Promise.all(scorers.map((s) => Promise.resolve(s(trajectory))));
    const passing = results.find((r) => r.pass);
    const maxValue = Math.max(0, ...results.map((r) => r.value));
    if (passing) {
      return pass(passing.reason, maxValue, { children: results });
    }
    return fail("All alternatives failed", maxValue, {
      children: results,
      reasons: results.map((r) => r.reason),
    });
  };
}

/** Weighted sum of scorers' .value fields. Pass if weighted sum ≥ threshold (default 0.5). */
export function weighted(
  items: Array<{ scorer: Scorer; weight: number }>,
  threshold = 0.5,
): Scorer {
  return async (trajectory) => {
    const results = await Promise.all(
      items.map(async ({ scorer, weight }) => ({
        weight,
        score: await Promise.resolve(scorer(trajectory)),
      })),
    );
    const totalWeight = items.reduce((s, i) => s + i.weight, 0) || 1;
    const weightedSum =
      results.reduce((sum, r) => sum + r.weight * r.score.value, 0) / totalWeight;
    return weightedSum >= threshold
      ? pass(
          `Weighted sum ${weightedSum.toFixed(2)} ≥ ${threshold}`,
          weightedSum,
          { children: results.map((r) => r.score) },
        )
      : fail(
          `Weighted sum ${weightedSum.toFixed(2)} < ${threshold}`,
          weightedSum,
          { children: results.map((r) => r.score) },
        );
  };
}

// ---- Internal helpers (also exported for outcome-evaluator and other consumers) ----

/**
 * Filter an Anthropic-style content array to text blocks only.
 * Thinking-mode models put a `{type:"thinking"}` block before the answer; the
 * naive `content[0].text` extraction silently grabs `undefined`. This was the
 * root cause of the T2.1 judge failure in the prior eval run.
 */
export function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text || "")
    .join("");
}

/**
 * Parse a judge LLM response (text) into a normalized verdict.
 * Tolerates prose surrounding the JSON object.
 */
export function parseJudgeJson(text: string): { result: "pass" | "fail"; reasoning: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { result?: string; reasoning?: string };
    return {
      result: parsed.result === "pass" ? "pass" : "fail",
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return null;
  }
}

// ---------- LLM judge ----------

export interface JudgeOptions {
  /** Anthropic-compatible API base URL. */
  apiUrl?: string;
  /** Anthropic API key. */
  apiKey?: string;
  /** Model id. */
  model?: string;
  /** Max retries on transient failure. */
  maxRetries?: number;
}

const JUDGE_DEFAULT_RETRIES = 5;
const JUDGE_BASE_DELAY = 2000;

/**
 * LLM judge — calls an Anthropic-compatible API with the rubric + a
 * trajectory transcript, expects JSON response { result: pass|fail, reasoning }.
 *
 * Filters response content to text blocks only — handles thinking-model
 * responses that put a `{type:"thinking"}` block first (the bug that bit T2.1
 * in the prior eval run).
 */
export function judge(rubric: string, options: JudgeOptions = {}): Scorer {
  const apiUrl = options.apiUrl || "https://api.anthropic.com/v1";
  const apiKey = options.apiKey || "";
  const model = options.model || "claude-sonnet-4-6";
  const maxRetries = options.maxRetries ?? JUDGE_DEFAULT_RETRIES;

  return async (trajectory) => {
    if (!apiKey) {
      return fail("Judge: no apiKey provided", 0, { skipped: true });
    }

    const transcript = buildTranscript(trajectory);
    const prompt = `You are a test suite judge evaluating whether an AI agent completed a task correctly.

## Rubric
${rubric}

## Session Transcript
${transcript}

## Instructions
Evaluate whether ALL rubric criteria are satisfied. Respond with ONLY a JSON object, no other text:
{"result": "pass", "reasoning": "..."}
or
{"result": "fail", "reasoning": "..."}`;

    let lastErr = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${apiUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          lastErr = `HTTP ${res.status}: ${body.slice(0, 200)}`;
          const transient = res.status === 429 || res.status === 529 || (res.status >= 500 && res.status < 600);
          if (!transient) return fail(`Judge: ${lastErr}`);
        } else {
          const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
          const blocks = Array.isArray(data?.content) ? data.content : [];
          // Filter to text blocks (thinking models put thinking in content[0])
          const text = extractTextFromContent(blocks);
          if (text) {
            const parsed = parseJudgeJson(text);
            if (parsed) {
              return parsed.result === "pass"
                ? pass(`Judge: ${parsed.reasoning || ""}`)
                : fail(`Judge: ${parsed.reasoning || ""}`);
            }
            lastErr = `Failed to parse judge JSON: ${text.slice(0, 200)}`;
          } else {
            lastErr = `Empty text content (stop=${data.stop_reason || "?"} blocks=${blocks.map((b) => b?.type).join(",")})`;
          }
        }
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err.message : String(err);
      }

      if (attempt >= maxRetries) break;
      const delay = Math.min(30_000, JUDGE_BASE_DELAY * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5));
      await new Promise((r) => setTimeout(r, delay));
    }
    return fail(`Judge exhausted retries: ${lastErr.slice(0, 200)}`);
  };
}

function buildTranscript(trajectory: Trajectory): string {
  const lines: string[] = [];
  const uses = getToolUses(trajectory);
  const usesById = new Map(uses.filter((u) => u.id).map((u) => [u.id!, u]));
  for (const e of trajectory.events) {
    if (e.type === "user.message") {
      const data = parseDataLight(e);
      const text = extractText(data?.content);
      if (text) lines.push(`[user] ${text.slice(0, 500)}`);
    } else if (e.type === "agent.message") {
      const data = parseDataLight(e);
      const text = extractText(data?.content);
      if (text) lines.push(`[agent] ${text.slice(0, 500)}`);
    } else if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") {
      const data = parseDataLight(e);
      lines.push(
        `[tool_use] ${data?.name || "?"}(${JSON.stringify(data?.input || {}).slice(0, 200)})`,
      );
    } else if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
      const data = parseDataLight(e);
      const tuid = (data?.tool_use_id as string) || (data?.mcp_tool_use_id as string);
      const name = tuid ? usesById.get(tuid)?.name || "?" : "?";
      const content = data?.content;
      const cstr = typeof content === "string" ? content : JSON.stringify(content || "");
      lines.push(`[tool_result:${name}] ${cstr.slice(0, 500)}`);
    } else if (e.type === "session.error") {
      const data = parseDataLight(e);
      lines.push(`[session_error] ${JSON.stringify(data?.error).slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

function parseDataLight(e: { data: string | object }): Record<string, unknown> | null {
  if (typeof e.data === "string") {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  }
  return (e.data as Record<string, unknown>) ?? null;
}

function extractText(content: unknown): string {
  return extractTextFromContent(content);
}
