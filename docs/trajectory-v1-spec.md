# OMA Trajectory v1 — Schema Spec

**Status**: draft
**Schema version**: `oma.trajectory.v1`
**Owner**: platform / verifier framework workstream
**Date**: 2026-04-17

## Why this doc exists

OMA's actual platform leverage isn't a "unified scorer interface" — it's the **agent execution trace**: SSEEvent stream + sandbox + multi-agent + supervisor loop. Nobody else has this shape.

This doc locks that trace down as **the canonical OMA Trajectory format**: stable, versioned, with documented projections to popular industry shapes (Anthropic Messages, OpenTelemetry GenAI, Inspect AI TaskState, RL TurnRecord).

> **Design rule**: own the substrate, not the abstractions on top. Eval / RL / monitoring / outcome eval are all just *consumers* of Trajectory.

## Non-goals

- Not unifying scorer / verifier / reward function interfaces (deliberate — see `docs/handoff-verifier-framework.md` discussion).
- Not adopting OTel GenAI as the *internal* format (too generic; multi-agent / supervisor / sandbox aren't first-class). Adopted only as a *projection*.
- Not designing benchmarks (SWE-bench, GAIA loaders) — those are dataset adapters that *produce* Trajectories.

## What we already have (lock as v1)

`packages/shared/src/types.ts:350` defines `SessionEvent` — the union of every event the runtime emits. The vocabulary is:

| Bucket | Events | Purpose |
|---|---|---|
| User input | `user.message`, `user.interrupt`, `user.tool_confirmation`, `user.custom_tool_result`, `user.define_outcome` | What the user/caller sent in |
| Agent action | `agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `agent.custom_tool_use`, `agent.mcp_tool_use`, `agent.mcp_tool_result` | What the LLM produced + tool execution |
| Multi-agent | `session.thread_created`, `agent.thread_message`, `agent.thread_message_sent`, `agent.thread_message_received`, `agent.thread_context_compacted`, `session.thread_idle` | Sub-agent / supervisor threads |
| Outcome | `user.define_outcome`, `outcome.evaluation_end`, `session.outcome_evaluated`, `span.outcome_evaluation_*` | Supervisor-mode revision loop |
| Lifecycle | `session.status_running`, `session.status_idle`, `session.status_rescheduled`, `session.status_terminated`, `session.error` | Session state |
| Spans | `span.model_request_start`, `span.model_request_end`, `span.outcome_evaluation_*` | Observability (timing, token usage) |

`StoredEvent` (`types.ts:495`) is the persistent envelope: `{seq, type, data, ts}`.

**v1 promise**: every event type listed above is **part of the stable v1 vocabulary**. Deprecation requires a v2 bump.

## Trajectory envelope

A Trajectory wraps a session's event stream with the metadata needed to replay, evaluate, train on, or audit it.

```typescript
export interface Trajectory {
  // --- Identity ---
  schema_version: "oma.trajectory.v1";
  trajectory_id: string;          // ULID — globally unique
  session_id: string;             // OMA session this came from
  group_id?: string;              // RL: same task sampled N times shares group_id
  task_id?: string;               // RL/eval: which task this trajectory ran

  // --- Configuration snapshot (frozen at session start) ---
  agent_config: AgentConfig;      // see types.ts:41 — full snapshot, NOT a ref
  environment_config: EnvironmentConfig; // see types.ts:62
  model: { id: string; provider: string; base_url?: string };

  // --- Lifecycle ---
  started_at: string;             // ISO-8601
  ended_at?: string;              // null while running
  outcome: TrajectoryOutcome;     // see below

  // --- Events ---
  events: StoredEvent[];          // see types.ts:495

  // --- RL extension (optional, omitted for non-RL) ---
  completions?: Completion[];     // token-level data per LLM call
  reward?: RewardResult;          // populated by verifier post-hoc
  group_stats?: GroupStats;       // populated by GRPO advantage estimator

  // --- Aggregates (computed once at end, cached for fast eval) ---
  summary: TrajectorySummary;
}

export type TrajectoryOutcome =
  | "success"          // session.status_idle reached without errors
  | "failure"          // session.error or supervisor failed
  | "timeout"          // wall-clock or turn limit hit
  | "interrupted"      // user.interrupt
  | "running";         // not yet ended

export interface TrajectorySummary {
  num_events: number;
  num_turns: number;              // count of agent.message events
  num_tool_calls: number;
  num_tool_errors: number;
  num_threads: number;            // multi-agent count
  duration_ms: number;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}
```

### What the envelope explicitly does NOT include

- **Sandbox state snapshots** (filesystem diffs, process list). Out of scope for v1 — would balloon size. Use `agent.tool_result` content + `bash` exit codes for verification.
- **Compressed/redacted variants**. Trajectory is the raw artifact. Compression is a transport concern.
- **Scorer outputs**. Scores are stored separately and reference the trajectory by `trajectory_id`. Same trajectory can have many scores.

## Causality

To support replay, multi-agent debugging, and supervisor revision attribution, every event has implicit causality through three fields already on `EventBase`:

| Field | Source | Meaning |
|---|---|---|
| `id` | `EventBase.id` (already exists) | Unique per event |
| `seq` | `StoredEvent.seq` (already exists) | Monotonic per session — total ordering |
| `processed_at` | `EventBase.processed_at` | Wall-clock ingestion time |

**v1 adds one optional field** to `EventBase`:

```typescript
export interface EventBase {
  id?: string;
  processed_at?: string;
  parent_event_id?: string;       // NEW: causal predecessor
}
```

Conventions:
- `agent.tool_result.parent_event_id` → the `agent.tool_use` it answers
- `agent.thread_message_received.parent_event_id` → the `agent.thread_message_sent` from the other thread
- `outcome.evaluation_end.parent_event_id` → the `agent.message` being evaluated

`parent_event_id` is **optional** for backward-compat, but emitters **should** set it where the relationship is unambiguous. Replay tools must work without it (fall back to `tool_use_id` matching, etc.).

## RL extension

The trajectory above captures the *external* execution. RL trainers also need *internal* (per-LLM-call) token data. We store it as a **separate parallel array**, not interleaved with events.

```typescript
export interface Completion {
  completion_id: string;          // ULID
  span_id?: string;               // links to span.model_request_start.id
  turn_index: number;             // 0-based, matches Nth agent.message
  prompt_ids: number[];           // tokenized input
  response_ids: number[];         // tokenized output
  logprobs: number[];             // per response token (action logprobs)
  ref_logprobs?: number[];        // reference-model logprobs (KL term)
  finish_reason: "stop" | "length" | "tool_calls" | "error";
  model_id: string;               // exact model used (may differ from agent_config if A/B)
  // For PPO/GRPO with token-level rewards:
  token_advantages?: number[];    // length === response_ids.length
  token_rewards?: number[];       // length === response_ids.length
}

export interface RewardResult {
  raw_rewards: Record<string, number>;  // named components (test_pass, format, efficiency, ...)
  final_reward: number;                  // aggregated scalar [0, 1]
  // Optional metadata for debugging
  verifier_id?: string;                  // which scorer produced this
  computed_at?: string;
}

export interface GroupStats {
  group_id: string;
  reward_mean: number;
  reward_std: number;              // never zero (clamped to 1e-8 for division)
  finished_num: number;
  pass_rate: number;
  // GRPO advantage = (reward - mean) / std, computed per-trajectory at consumption
}
```

### Why parallel arrays, not interleaved

- The event stream is the **product spec** (always present, used by UI / outcome eval / monitoring).
- The completions array is **trainer-only data** (only present when collected for RL).
- Keeping them separate means: same envelope, just `completions === undefined` for non-RL trajectories. Zero waste.

### Naming aligned to verl / TRL / OpenRLHF where possible

| OMA field | verl name | TRL name |
|---|---|---|
| `prompt_ids` | `prompt_input_ids` | same |
| `response_ids` | `response_input_ids` | same |
| `logprobs` | `old_log_prob` | `old_per_token_logps` |
| `ref_logprobs` | `ref_log_prob` | `ref_per_token_logps` |
| `token_advantages` | `advantages` | same |
| `token_rewards` | `token_level_rewards` | same |

Adapters (`projections/`) handle exact rename to whichever trainer.

## Projections (the "exits")

Every projection lives in `packages/shared/src/trajectory/projections/`, ~30–100 LOC each. Pure functions, no I/O.

| Projection | Output | Consumers | Size estimate |
|---|---|---|---|
| `toAnthropicMessages(traj)` | `AnthropicMessage[]` (role + content blocks) | HF datasets, SWE-bench scorers, community Anthropic tooling | ~50 LOC |
| `toOTelGenAISpans(traj)` | `OTelSpan[]` (`gen_ai.*` semantic conv) | Datadog, Honeycomb, Grafana Tempo | ~80 LOC |
| `toInspectTaskState(traj)` | Inspect AI `TaskState`-like dict | Inspect AI scorers | ~60 LOC |
| `toRLTurnRecords(traj)` | `TurnRecord[]` (current `rl/types.ts` shape) | rl/verifier.ts, GRPO trainer | ~40 LOC (mostly identity) |

Projections are **lossy in one direction** (e.g. OTel can't represent supervisor revisions cleanly) — the original trajectory is always the source of truth.

### Inverse projections

Out of scope for v1. We do not promise to ingest OTel spans → Trajectory. If users want to replay external traces, they bring their own loader.

## Versioning policy

- **Additive changes** (new event types, new optional fields) → still v1. Consumers must ignore unknown fields/types.
- **Breaking changes** (renaming, removing, changing semantics) → bump `schema_version` to `oma.trajectory.v2`. Both versions must coexist for ≥1 release cycle.
- **Storage**: every persisted Trajectory MUST include `schema_version`. The runtime validates on read, fails loud on mismatch.

## What changes in code (when we implement)

Minimal — most of the work is *naming* what already exists:

1. **`packages/shared/src/types.ts`** — add `Trajectory`, `TrajectoryOutcome`, `TrajectorySummary`, `Completion`, `RewardResult`, `GroupStats` exports. Add `parent_event_id?` to `EventBase`.
2. **`packages/shared/src/trajectory/build.ts`** (NEW, ~80 LOC) — `buildTrajectory(session_id) → Trajectory` reads stored events + agent + env, computes summary, emits envelope.
3. **`packages/shared/src/trajectory/projections/`** (NEW, ~250 LOC total) — four files above.
4. **`rl/types.ts`** — replace local `Trajectory` with import from shared. Keep `TurnRecord` as the projected RL shape.
5. **`test/eval/types.ts`** — `EvalTask.verify` signature gains a Trajectory option (events stay for backward compat).
6. **API**: add `GET /v1/sessions/:id/trajectory` returning the full envelope.

No event format changes. No runtime emit changes (other than optional `parent_event_id`).

## Open questions (decide before implementation)

1. **Sandbox snapshot** — is there *any* version of "fs state at end of session" we want in the envelope? (Recommend: no, keep it out of v1.)
2. **Token usage attribution** — current `span.model_request_end.model_usage` is per-call. Do we also keep a cumulative running total in the summary? (Recommend: yes — already in `TrajectorySummary`.)
3. **Compaction** — `agent.thread_context_compacted` removes earlier messages. Does the trajectory still include them? (Recommend: yes — trajectory is raw history; compaction is a runtime concern, not storage.)
4. **PII / secret redaction** — projections may need to scrub. Out of scope for v1, separate redaction layer.

## Acceptance for v1

- [ ] Spec reviewed and approved
- [ ] `Trajectory` types added to `packages/shared`
- [ ] `buildTrajectory()` works for an existing session, validated against T2.1
- [ ] `toAnthropicMessages` projection round-trips a known session correctly
- [ ] At least one external scorer (Inspect AI hello-world) consumes via projection without modification

## References

- `packages/shared/src/types.ts` — current event vocabulary
- `rl/types.ts` — current RL trajectory shape (will become projection target)
- `test/eval/types.ts` — current eval shape
- `apps/agent/src/harness/outcome-evaluator.ts` — current outcome evaluator
- `docs/handoff-verifier-framework.md` — context from prior session
- Inspect AI `TaskState`: https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/solver/_task_state.py
- OTel GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- verl / SkyRL / OpenRLHF — RL trajectory shape references
