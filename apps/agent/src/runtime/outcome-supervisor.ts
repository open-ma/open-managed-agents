// Outcome supervisor — runs the AMA-aligned grader loop for a session.
//
// Extracted from session-do.ts so the loop logic is unit-testable
// without spinning up a Durable Object. The session-do delegates to
// `runOutcomeSupervisor()` after each `harness.run(...)` completes if
// `state.outcome` is populated.
//
// Design highlights:
//   - One Verifier instance per outcome (built once at loop start).
//     Rule-based path (`state.outcome.verifier`) goes through
//     `verifierForSpec` so it composes with the existing Phase 2
//     framework. LLM-judge path constructs an in-process LlmJudgeVerifier
//     so usage tokens propagate to span.outcome_evaluation_end.usage.
//   - Each iteration: emit `span.outcome_evaluation_start` (with
//     `outcome_id` + 0-indexed iteration), `span.outcome_evaluation_ongoing`
//     heartbeat, then run the verifier against a minimal Trajectory
//     built from the current event log. Result enum maps from the Score:
//       pass → satisfied;
//       !pass && iteration === max-1 → max_iterations_reached;
//       !pass otherwise → needs_revision (inject reason as user.message,
//         re-run harness, advance iteration).
//   - Verifier throws → result: "failed", explanation = err.message.
//   - AbortSignal aborts (user.interrupt) → result: "interrupted", but
//     ONLY if the start span already fired this iteration (per AMA spec).
//   - Every terminal verdict appends to `state.outcome_evaluations[]`
//     for the GET /v1/sessions/:id aggregate.

import type {
  AgentMessageEvent,
  RubricSpec,
  SessionEvent,
  SpanOutcomeEvaluationEndEvent,
  SpanOutcomeEvaluationOngoingEvent,
  SpanOutcomeEvaluationStartEvent,
  StoredEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import {
  createLlmJudgeVerifier,
  verifierForSpec,
  type JudgeFn,
  type RewardSpec,
  type Score,
  type Trajectory,
  type Verifier,
  type VerifierContext,
} from "@open-managed-agents/shared";
import { resolveRubric } from "./resolve-rubric";

/** AMA `span.outcome_evaluation_end.usage` shape. */
export interface OutcomeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Persisted aggregate row. Mirrors what session-do writes to
 *  `state.outcome_evaluations[]`. */
export interface OutcomeEvaluationRecord {
  outcome_id: string;
  result:
    | "satisfied"
    | "needs_revision"
    | "max_iterations_reached"
    | "failed"
    | "interrupted";
  iteration: number;
  explanation?: string;
  /** @deprecated alias of explanation. Both written for back-compat. */
  feedback?: string;
  usage?: OutcomeUsage;
  processed_at?: string;
}

/** Active outcome state, as stored on `SessionState.outcome`. */
export interface ActiveOutcomeState {
  outcome_id: string;
  description: string;
  rubric?: string | RubricSpec;
  /** Cached resolved rubric markdown (set lazily on first iteration). */
  rubric_content?: string;
  /** OMA-superset rule-based check. Wire shape mirrors RewardSpec. */
  verifier?: { type: string; [key: string]: unknown };
  max_iterations?: number;
}

export interface OutcomeSupervisorDeps {
  outcome: ActiveOutcomeState;
  /** Iteration to start at. 0-indexed (AMA-spec). */
  initialIteration?: number;
  /** Tenant id — used by the rubric file resolver. */
  tenantId: string;
  filesBucket: R2Bucket | null | undefined;
  /** Append-and-broadcast for events that go to history + WS. */
  appendAndBroadcast: (event: SessionEvent) => void;
  /** Broadcast-only — used for the start span (AMA emits it but the
   *  ongoing/end spans are the persisted history rows; we keep parity
   *  with the previous emit shape that wrote start to WS only). */
  broadcastOnly: (event: SessionEvent) => void;
  /** Read all events for the current iteration's trajectory build. */
  getEvents: () => StoredEvent[] | SessionEvent[];
  /** Build a verifier from the OMA-superset RewardSpec branch. */
  makeVerifierContext: () => VerifierContext;
  /** Build the LLM-judge callback (closure over generateText). */
  makeJudgeFn: () => JudgeFn;
  /** Optional model identifier used for the verifier id (logs / metadata). */
  judgeModelId?: string;
  /** Run another harness turn after a needs_revision verdict. */
  runHarnessTurn: (msg: UserMessageEvent) => Promise<void>;
  /** Persist a delta back to SessionState. Caller decides what to merge. */
  persistState: (delta: {
    outcome?: ActiveOutcomeState | null;
    outcome_iteration?: number;
    outcome_evaluations?: OutcomeEvaluationRecord[];
  }) => void;
  /** Read the current persisted outcome_evaluations[]. */
  readEvaluations: () => OutcomeEvaluationRecord[];
  /** Mid-eval interrupt detection. */
  abortSignal: AbortSignal;
}

const TERMINAL_RESULTS = new Set([
  "satisfied",
  "max_iterations_reached",
  "failed",
  "interrupted",
]);

export interface OutcomeSupervisorReport {
  iterations: OutcomeEvaluationRecord[];
  terminal: OutcomeEvaluationRecord;
}

/**
 * Run the supervisor loop until a terminal verdict. Returns the final
 * verdict + per-iteration trail. Throws only on caller-side errors
 * (e.g. failure to persist state); supervisor-internal failures land in
 * the verdict as `failed`.
 */
export async function runOutcomeSupervisor(
  deps: OutcomeSupervisorDeps,
): Promise<OutcomeSupervisorReport> {
  const outcome = deps.outcome;
  const maxIterations = clampMaxIterations(outcome.max_iterations);
  let iteration = Math.max(0, deps.initialIteration ?? 0);

  // ── Build the verifier ──
  let verifier: Verifier | null = null;
  let preflightFailure: string | null = null;
  let activeOutcome: ActiveOutcomeState = outcome;

  if (outcome.verifier) {
    try {
      verifier = verifierForSpec(
        outcome.verifier as unknown as RewardSpec,
        deps.makeVerifierContext(),
      );
    } catch (err) {
      preflightFailure = `verifier construction failed: ${describe(err)}`;
    }
  } else {
    // LLM-judge path. Resolve the rubric (cache hit if already done).
    let rubricContent = outcome.rubric_content;
    if (!rubricContent) {
      const resolution = await resolveRubric(outcome.rubric, {
        tenantId: deps.tenantId,
        filesBucket: deps.filesBucket,
      });
      if (!resolution.ok) {
        preflightFailure = resolution.error;
      } else {
        rubricContent = resolution.content;
        activeOutcome = { ...outcome, rubric_content: rubricContent };
        deps.persistState({ outcome: activeOutcome });
      }
    }
    if (rubricContent && !preflightFailure) {
      verifier = createLlmJudgeVerifier({
        rubric: rubricContent,
        description: outcome.description,
        modelId: deps.judgeModelId,
        judge: deps.makeJudgeFn(),
        abortSignal: deps.abortSignal,
      });
    }
  }

  const evaluations: OutcomeEvaluationRecord[] = [];

  // Pre-flight failure: emit a single failed verdict and exit.
  if (preflightFailure || !verifier) {
    const record = await emitVerdict(deps, activeOutcome, iteration, {
      result: "failed",
      explanation: preflightFailure ?? "verifier could not be constructed",
      preStartFired: false,
    });
    evaluations.push(record);
    return { iterations: evaluations, terminal: record };
  }

  // ── Main loop ──
  let terminal: OutcomeEvaluationRecord | null = null;

  while (iteration < maxIterations) {
    // Pre-iteration interrupt check. Per AMA spec, "interrupted" is only
    // emitted if `outcome_evaluation_start` already fired — so a clean
    // pre-iteration abort exits silently (no end span). This matches
    // session-do's existing user.interrupt handler which broadcasts an
    // idle event, not an outcome end.
    if (deps.abortSignal.aborted) break;

    const startEventId = generateEventId();
    const lastAgentMessageId = findLastAgentMessageId(deps.getEvents());
    const startEvent: SpanOutcomeEvaluationStartEvent = {
      type: "span.outcome_evaluation_start",
      id: startEventId,
      outcome_id: activeOutcome.outcome_id,
      iteration,
      ...(lastAgentMessageId ? { parent_event_id: lastAgentMessageId } : {}),
    };
    // Match prior behavior: start-span is broadcast-only (not persisted to
    // history). Heartbeat + end span go to both.
    deps.broadcastOnly(startEvent);

    const ongoingEvent: SpanOutcomeEvaluationOngoingEvent = {
      type: "span.outcome_evaluation_ongoing",
      outcome_id: activeOutcome.outcome_id,
      iteration,
    };
    deps.appendAndBroadcast(ongoingEvent);

    const trajectory = makeMinimalTrajectory(deps.getEvents());

    let endResult: OutcomeEvaluationRecord["result"];
    let explanation: string;
    let usage: OutcomeUsage | undefined;
    try {
      const score: Score = await verifier.check(trajectory);
      explanation = score.reason || "";
      const meta = (score.metadata ?? {}) as { usage?: OutcomeUsage };
      if (meta.usage) usage = meta.usage;
      if (score.pass) {
        endResult = "satisfied";
      } else if (iteration >= maxIterations - 1) {
        endResult = "max_iterations_reached";
      } else {
        endResult = "needs_revision";
      }
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        deps.abortSignal.aborted;
      endResult = isAbort ? "interrupted" : "failed";
      explanation = isAbort
        ? "outcome evaluation interrupted by user"
        : `verifier error: ${describe(err)}`;
    }

    const record = await emitVerdict(deps, activeOutcome, iteration, {
      result: endResult,
      explanation,
      usage,
      preStartFired: true,
      startEventId,
      lastAgentMessageId,
    });
    evaluations.push(record);

    if (TERMINAL_RESULTS.has(record.result)) {
      terminal = record;
      break;
    }

    // needs_revision — advance iteration, inject feedback, re-run harness.
    iteration += 1;
    deps.persistState({ outcome: activeOutcome, outcome_iteration: iteration });

    const feedbackMsg: UserMessageEvent = {
      type: "user.message",
      content: [
        {
          type: "text",
          text:
            `<outcome_feedback iteration="${iteration - 1}">\n` +
            `${explanation || "(no explanation)"}\n\n` +
            `Address the feedback and try again.\n` +
            `</outcome_feedback>`,
        },
      ],
    };
    deps.appendAndBroadcast(feedbackMsg);

    try {
      await deps.runHarnessTurn(feedbackMsg);
    } catch (err) {
      // Harness crash mid-revision. Emit a `failed` end span so callers
      // see a terminal outcome; surface the underlying error in
      // explanation for debuggability. Don't rethrow — session-do's outer
      // try/catch already logged the harness error and broadcast a
      // session.error event for the harness crash itself.
      const failedRecord = await emitVerdict(deps, activeOutcome, iteration, {
        result: "failed",
        explanation: `harness crashed during revision: ${describe(err)}`,
        preStartFired: false,
      });
      evaluations.push(failedRecord);
      terminal = failedRecord;
      break;
    }
  }

  if (!terminal) {
    // Loop exited without a terminal (max iterations reached without an
    // end span — unreachable in practice but defended for safety).
    terminal = await emitVerdict(deps, activeOutcome, iteration - 1, {
      result: "max_iterations_reached",
      explanation: "supervisor loop exited without a terminal verdict",
      preStartFired: false,
    });
    evaluations.push(terminal);
  }

  return { iterations: evaluations, terminal };
}

interface VerdictPayload {
  result: OutcomeEvaluationRecord["result"];
  explanation: string;
  usage?: OutcomeUsage;
  /** When false, the start span never fired this iteration — only used
   *  on pre-flight or post-needs_revision failure paths. We still emit
   *  the end span (so the aggregate has a row) but skip the
   *  `outcome_evaluation_start_id` link. */
  preStartFired: boolean;
  startEventId?: string;
  lastAgentMessageId?: string;
}

async function emitVerdict(
  deps: OutcomeSupervisorDeps,
  outcome: ActiveOutcomeState,
  iteration: number,
  payload: VerdictPayload,
): Promise<OutcomeEvaluationRecord> {
  const endEvent: SpanOutcomeEvaluationEndEvent = {
    type: "span.outcome_evaluation_end",
    outcome_id: outcome.outcome_id,
    ...(payload.preStartFired && payload.startEventId
      ? { outcome_evaluation_start_id: payload.startEventId }
      : {}),
    result: payload.result,
    iteration,
    explanation: payload.explanation,
    // Back-compat alias: console + RL collector still read .feedback.
    feedback: payload.explanation,
    ...(payload.usage ? { usage: payload.usage } : {}),
    ...(payload.lastAgentMessageId
      ? { parent_event_id: payload.lastAgentMessageId }
      : {}),
  };
  deps.appendAndBroadcast(endEvent);

  const record: OutcomeEvaluationRecord = {
    outcome_id: outcome.outcome_id,
    result: payload.result,
    iteration,
    explanation: payload.explanation,
    feedback: payload.explanation,
    usage: payload.usage,
    processed_at: endEvent.processed_at,
  };

  const prior = deps.readEvaluations();
  const persisted = [...prior, record];

  if (TERMINAL_RESULTS.has(record.result)) {
    // Terminal — drop active outcome, keep the aggregate.
    deps.persistState({ outcome: null, outcome_evaluations: persisted });
  } else {
    deps.persistState({
      outcome,
      outcome_iteration: iteration,
      outcome_evaluations: persisted,
    });
  }
  return record;
}

function clampMaxIterations(n: number | undefined): number {
  // AMA spec: default 3, max 20.
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return 3;
  return Math.min(20, Math.floor(n));
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "unknown error";
  return String(err);
}

function findLastAgentMessageId(
  events: StoredEvent[] | SessionEvent[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as SessionEvent;
    if (e.type === "agent.message") {
      return (e as AgentMessageEvent).id;
    }
  }
  return undefined;
}

/**
 * Build the minimal Trajectory the verifier needs. We deliberately don't
 * call eval-core's `buildTrajectory` (which expects async event/status
 * fetchers + agent_config + environment_config snapshots) because the
 * supervisor only needs `events` for verifier consumption. Stub fields
 * stay valid for any verifier that ignores them (script / verifiable /
 * llm_judge); composite verifiers that recurse into reward_model would
 * need richer construction — handle that when the use case lands.
 *
 * Wraps each SessionEvent into the StoredEvent shape the eval-core
 * scorer helpers expect (`{ seq, type, data: JSON.stringify(event), ts }`).
 * `history.getEvents()` returns the deserialized SessionEvent stream
 * (top-level fields), but the helpers parse `e.data` to get the
 * structured payload — so without the wrap, `getToolUses` /
 * `getAgentMessageTexts` / etc. all return empty.
 */
function makeMinimalTrajectory(
  events: StoredEvent[] | SessionEvent[],
): Trajectory {
  const wrapped: StoredEvent[] = events.map((e, i) => {
    // If the event already carries the StoredEvent envelope (eval-runner
    // path, which fetches via /events endpoint), pass it through.
    if (
      typeof (e as StoredEvent).data === "string" &&
      typeof (e as StoredEvent).seq === "number"
    ) {
      return e as StoredEvent;
    }
    // Supervisor path: history.getEvents() returns deserialized events.
    // Wrap into StoredEvent so the scorer helpers see the structured
    // payload via parseData.
    const ts =
      (e as { processed_at?: string }).processed_at ?? new Date(0).toISOString();
    return {
      seq: i,
      type: (e as { type?: string }).type ?? "unknown",
      data: JSON.stringify(e),
      ts,
    };
  });
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "supervisor-inline",
    session_id: "supervisor-inline",
    agent_config: {} as Trajectory["agent_config"],
    environment_config: {} as Trajectory["environment_config"],
    model: { id: "supervisor-inline", provider: "" },
    started_at: new Date(0).toISOString(),
    outcome: "running",
    events: wrapped,
    summary: {
      num_events: wrapped.length,
      num_turns: 0,
      num_tool_calls: 0,
      num_tool_errors: 0,
      num_threads: 0,
      duration_ms: 0,
      token_usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}
