/**
 * Production Trajectory Collector
 *
 * Watches production OMA sessions and extracts training-ready trajectories.
 * This is the "self-improvement loop" — same runtime, production → training.
 *
 * Data sources for reward:
 *   1. User feedback: session.outcome_evaluated events (user said "satisfied" or not)
 *   2. Heuristic: session completed without error + used tools successfully
 *   3. Verifier: if task matches a known task definition, apply rule-based checks
 *
 * Usage:
 *   npx tsx rl/cli.ts collect-production --since 24h --output prod.jsonl
 *   npx tsx rl/cli.ts collect-production --session-ids s1,s2,s3 --output prod.jsonl
 */

import type { Trajectory, Completion, RewardResult, TokenUsage } from "./types.js";
import type { SSEEvent } from "../test/eval/types.js";
import { eventsToTrajectory } from "./trajectory.js";
import { randomUUID } from "crypto";

// --- Session metadata from OMA API ---

interface SessionInfo {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

interface CollectorConfig {
  api_url: string;
  api_key: string;
  since_hours?: number;
  session_ids?: string[];
  min_turns?: number; // minimum assistant turns to include (default: 2)
  exclude_errors?: boolean; // skip sessions that ended in error (default: false)
  reward_mode: "feedback" | "heuristic" | "both";
}

// --- Reward from production signals ---

function rewardFromFeedback(events: SSEEvent[]): RewardResult | null {
  const outcomeEvents = events.filter(
    (e) =>
      e.type === "session.outcome_evaluated" ||
      e.type === "outcome.evaluation_end" ||
      e.type === "span.outcome_evaluation_end",
  );
  if (outcomeEvents.length === 0) return null;

  const last = outcomeEvents[outcomeEvents.length - 1];
  const result = (last as any).result as string;

  const score =
    result === "satisfied" ? 1.0
    : result === "needs_revision" ? 0.2
    : result === "failed" ? 0.0
    : 0.5; // unknown

  return {
    raw_rewards: { user_feedback: score, feedback_type: result === "satisfied" ? 1 : 0 },
    final_reward: score,
  };
}

function rewardFromHeuristic(events: SSEEvent[]): RewardResult {
  const raw: Record<string, number> = {};

  // Did it complete without error?
  const hasError = events.some((e) => e.type === "session.error");
  const hasIdle = events.some((e) => e.type === "session.status_idle");
  raw.completed = hasIdle && !hasError ? 0.3 : 0;

  // Did it use tools?
  const toolUses = events.filter((e) => e.type === "agent.tool_use");
  raw.used_tools = toolUses.length > 0 ? 0.2 : 0;

  // Were tool calls successful (no error results)?
  const toolResults = events.filter((e) => e.type === "agent.tool_result");
  const errorResults = toolResults.filter((e) => (e as any).is_error);
  raw.tools_success = toolResults.length > 0 && errorResults.length === 0 ? 0.2 : 0;

  // Reasonable length (not too short, not too long)?
  const assistantMsgs = events.filter((e) => e.type === "agent.message");
  const turnCount = assistantMsgs.length;
  raw.reasonable_length = turnCount >= 1 && turnCount <= 20 ? 0.15 : 0;

  // Did the agent provide a final message (not just tool calls)?
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
  const hasContent = lastAssistant && (lastAssistant as any).content?.length > 0;
  raw.final_response = hasContent ? 0.15 : 0;

  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  return { raw_rewards: raw, final_reward: Math.min(total, 1.0) };
}

function computeProductionReward(
  events: SSEEvent[],
  mode: "feedback" | "heuristic" | "both",
): RewardResult {
  if (mode === "feedback") {
    return rewardFromFeedback(events) || { raw_rewards: { no_feedback: 0 }, final_reward: 0 };
  }

  if (mode === "heuristic") {
    return rewardFromHeuristic(events);
  }

  // both: prefer feedback, fall back to heuristic
  const feedback = rewardFromFeedback(events);
  if (feedback) return feedback;
  return rewardFromHeuristic(events);
}

// --- Collector ---

export async function collectProductionTrajectories(
  config: CollectorConfig,
): Promise<Trajectory[]> {
  const headers: Record<string, string> = {
    "x-api-key": config.api_key,
    "Content-Type": "application/json",
  };

  const fetchJson = async (path: string) => {
    const res = await fetch(`${config.api_url}${path}`, { headers });
    if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
    return res.json() as Promise<any>;
  };

  // 1. Get sessions
  let sessions: SessionInfo[];
  if (config.session_ids && config.session_ids.length > 0) {
    sessions = [];
    for (const id of config.session_ids) {
      try {
        const data = await fetchJson(`/v1/sessions/${id}`);
        sessions.push(data);
      } catch {
        console.warn(`[collector] Could not fetch session ${id}, skipping`);
      }
    }
  } else {
    const data = await fetchJson("/v1/sessions?limit=100&order=desc");
    sessions = (data.data || []) as SessionInfo[];

    // Filter by time
    if (config.since_hours) {
      const cutoff = new Date(Date.now() - config.since_hours * 3600 * 1000).toISOString();
      sessions = sessions.filter((s) => s.created_at >= cutoff);
    }
  }

  console.log(`[collector] Found ${sessions.length} sessions`);

  // 2. Extract trajectories
  const trajectories: Trajectory[] = [];
  const minTurns = config.min_turns || 2;

  for (const session of sessions) {
    try {
      const evtData = await fetchJson(`/v1/sessions/${session.id}/events?limit=1000&order=asc`);
      const events: SSEEvent[] = (evtData.data || []).map((e: any) => {
        const parsed = typeof e.data === "string" ? JSON.parse(e.data) : e.data || e;
        return { ...parsed, _seq: e.seq };
      });

      // Skip sessions with too few turns
      const assistantCount = events.filter((e) => e.type === "agent.message").length;
      if (assistantCount < minTurns) continue;

      // Skip error sessions if configured
      if (config.exclude_errors && events.some((e) => e.type === "session.error")) continue;

      // Extract model info
      const modelEvent = events.find((e) => e.type === "span.model_request_start");
      const modelId = (modelEvent as any)?.model || "unknown";

      // Build trajectory
      const dummyTask = {
        id: `prod:${session.id}`,
        description: session.title || "production session",
        message: "",
        reward: { type: "verifiable" as const },
      };

      const createdAt = new Date(session.created_at).getTime();
      const traj = eventsToTrajectory(events, dummyTask, session.id, modelId, createdAt);

      // Compute reward from production signals
      traj.reward = computeProductionReward(events, config.reward_mode);
      traj.reward_breakdown = {
        total: traj.reward.final_reward,
        rules: traj.reward.raw_rewards.user_feedback || 0,
        efficiency: traj.reward.raw_rewards.completed || 0,
      };

      // Mark as production data
      traj.metadata.domain_name = "production";
      traj.metadata.data_source = "auto-collect";

      trajectories.push(traj);
    } catch (err) {
      console.warn(`[collector] Error processing session ${session.id}: ${err}`);
    }
  }

  // Stats
  const rewards = trajectories.map((t) => t.reward.final_reward);
  const mean = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0;
  const withFeedback = trajectories.filter(
    (t) => t.reward.raw_rewards.user_feedback !== undefined,
  ).length;

  console.log(`[collector] Extracted ${trajectories.length} trajectories`);
  console.log(`[collector] ${withFeedback} with user feedback, ${trajectories.length - withFeedback} heuristic-only`);
  console.log(`[collector] Mean reward: ${mean.toFixed(4)}`);

  return trajectories;
}
