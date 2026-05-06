// buildTrajectory(): assemble a v1 Trajectory from a session's stored state.
//
// Framework-agnostic — caller provides:
//   - session record (already fetched from KV) including agent_snapshot + environment_snapshot
//   - fetchEvents(): paginates through StoredEvents
//   - fetchFullStatus(): returns { status, usage, outcome_evaluations }
//
// This keeps shared/ free of Cloudflare-specific bindings; the route layer
// (apps/main) wires the Workers fetcher into these callbacks.

import type {
  AgentConfig,
  EnvironmentConfig,
  SessionMeta,
  StoredEvent,
} from "@open-managed-agents/api-types";
import { customAlphabet } from "nanoid";

// Local id generator. Matches the alphabet/length of @oma/shared.generateId
// but avoids a workspace dep so eval-core has no cycle with shared (which
// re-exports eval-core for back-compat).
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);
const generateId = () => nanoid();
import type {
  Trajectory,
  TrajectoryOutcome,
  TrajectorySummary,
} from "./types.js";

export interface SessionRecord extends SessionMeta {
  agent_snapshot?: AgentConfig;
  environment_snapshot?: EnvironmentConfig;
}

export interface FullStatus {
  status: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  outcome_evaluations?: Array<{ result: string; iteration: number; feedback?: string }>;
}

export interface BuildTrajectoryDeps {
  /** Read all stored events for the session (caller paginates). */
  fetchAllEvents: () => Promise<StoredEvent[]>;
  /** Fetch session full status (status, usage, outcome_evaluations). */
  fetchFullStatus: () => Promise<FullStatus | null>;
  /** Optional: fetch current env config (used as fallback if session lacks env_snapshot). */
  fetchEnvironmentConfig?: () => Promise<EnvironmentConfig | null>;
}

const SCHEMA_VERSION = "oma.trajectory.v1" as const;

function deriveOutcome(events: StoredEvent[], status: string | undefined): TrajectoryOutcome {
  // Find the LAST status / terminal event. Avoid bug where an early
  // status_idle (e.g. from a warmup turn) was treated as the trajectory's
  // outcome even though later turns are still in flight.
  //
  // Spec mapping (docs/trajectory-v1-spec.md, TrajectoryOutcome):
  //   session.error              → failure
  //   user.interrupt             → interrupted
  //   session.status_terminated  → interrupted (operator/user-driven stop;
  //                                NOT a hard failure — distinct from
  //                                session.error which fires on real errors)
  //   session.status_idle        → success
  //   anything else (still running or only saw status_running) → running
  //
  // "timeout" is NOT detectable from the event stream alone — wall-clock
  // / max-turn limits live in the eval-runner / outcome-evaluator layer.
  // Callers that own that signal (e.g. eval-runner) mutate
  // `trajectory.outcome = "timeout"` after this function returns.
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "session.error") return "failure";
    if (t === "user.interrupt") return "interrupted";
    if (t === "session.status_terminated") return "interrupted";
    if (t === "session.status_idle") return "success";
    if (t === "session.status_running") return "running";
  }
  if (status === "running") return "running";
  return "running";
}

function computeSummary(events: StoredEvent[], usage: FullStatus["usage"], startedAt: string, endedAt?: string): TrajectorySummary {
  let numTurns = 0;
  let numToolCalls = 0;
  let numToolErrors = 0;
  const threadIds = new Set<string>();
  // Sum per-call usage from span.model_request_end events. Used as a fallback
  // when /full-status reports 0 (session mid-flight: generateText loop hasn't
  // returned yet → reportUsage hasn't been called → DO state still 0).
  let spanInTokens = 0;
  let spanOutTokens = 0;
  let spanCacheRead = 0;
  let spanCacheCreate = 0;

  for (const e of events) {
    const data = parseEventData(e);
    switch (e.type) {
      case "agent.message":
        numTurns++;
        break;
      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use":
        numToolCalls++;
        break;
      case "agent.tool_result":
      case "agent.mcp_tool_result":
        if (data && (data as { is_error?: boolean }).is_error) numToolErrors++;
        break;
      case "session.thread_created": {
        const tid = (data as { session_thread_id?: string })?.session_thread_id;
        if (tid) threadIds.add(tid);
        break;
      }
      case "span.model_request_end": {
        const u = (data as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } })?.model_usage;
        if (u) {
          spanInTokens += u.input_tokens || 0;
          spanOutTokens += u.output_tokens || 0;
          spanCacheRead += u.cache_read_input_tokens || 0;
          spanCacheCreate += u.cache_creation_input_tokens || 0;
        }
        break;
      }
    }
  }

  const duration = endedAt
    ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
    : 0;

  // Prefer the larger of: state-reported usage (cumulative, from /full-status)
  // and span sum (per-call). They should match at end-of-session; mid-flight,
  // span sum lags by the in-progress generateText call's usage.
  const reportedIn = usage?.input_tokens || 0;
  const reportedOut = usage?.output_tokens || 0;
  const reportedCache = usage?.cache_read_input_tokens || 0;
  const reportedCacheCreate = usage?.cache_creation_input_tokens || 0;

  return {
    num_events: events.length,
    num_turns: numTurns,
    num_tool_calls: numToolCalls,
    num_tool_errors: numToolErrors,
    num_threads: threadIds.size,
    duration_ms: duration,
    token_usage: {
      input_tokens: Math.max(reportedIn, spanInTokens),
      output_tokens: Math.max(reportedOut, spanOutTokens),
      cache_read_input_tokens: Math.max(reportedCache, spanCacheRead),
      cache_creation_input_tokens: Math.max(reportedCacheCreate, spanCacheCreate),
    },
  };
}

function parseEventData(e: StoredEvent): unknown {
  if (typeof e.data === "string") {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  }
  return e.data;
}

function deriveEndedAt(events: StoredEvent[], outcome: TrajectoryOutcome): string | undefined {
  if (outcome === "running") return undefined;
  // Last event timestamp is a reasonable proxy
  const last = events[events.length - 1];
  return last?.ts || undefined;
}

export async function buildTrajectory(
  session: SessionRecord,
  deps: BuildTrajectoryDeps,
): Promise<Trajectory> {
  const [events, fullStatus, fallbackEnv] = await Promise.all([
    deps.fetchAllEvents(),
    deps.fetchFullStatus().catch(() => null),
    session.environment_snapshot
      ? Promise.resolve(null)
      : (deps.fetchEnvironmentConfig?.().catch(() => null) ?? Promise.resolve(null)),
  ]);

  const status = fullStatus?.status;
  const usage = fullStatus?.usage;
  const outcome = deriveOutcome(events, status);
  const endedAt = deriveEndedAt(events, outcome);
  const summary = computeSummary(events, usage, session.created_at, endedAt);

  const envConfig = session.environment_snapshot || fallbackEnv;
  if (!envConfig) {
    throw new Error(
      `Cannot build trajectory: no environment_snapshot on session and fetchEnvironmentConfig returned null`,
    );
  }
  if (!session.agent_snapshot) {
    throw new Error(`Cannot build trajectory: no agent_snapshot on session ${session.id}`);
  }

  const modelField = session.agent_snapshot.model;
  const modelId = typeof modelField === "string" ? modelField : modelField.id;

  return {
    schema_version: SCHEMA_VERSION,
    trajectory_id: `tr-${generateId()}`,
    session_id: session.id,
    agent_config: session.agent_snapshot,
    environment_config: envConfig,
    model: { id: modelId, provider: "" }, // provider/base_url not stored on session today; can be enriched later
    started_at: session.created_at,
    ended_at: endedAt,
    outcome,
    events,
    summary,
  };
}
