# ORDERING_DESIGN — event-log ordering primitive

Status: design memo, no code changes
Audience: maintainer making the call between A / B / C / D before any further commits land on `feat/dual-table-and-llm-logs`
Baseline: `7d40027` on `origin/main`, plus the `3a3e7ec` checkpoint on the worktree branch

---

## 1. Frame the requirement

### 1.1 The single hard invariant

For any sequence of user inputs S that the platform *accepts* (POST `/v1/sessions/:id/events` returns 2xx) and any read R that reconstructs "what the model saw," R MUST observe each `user.message`/`user.tool_confirmation`/`user.custom_tool_result` event positioned **strictly after** every event that the agent emitted *before* the platform began ingesting that user input — and **strictly before** every event the agent emitted *because* of that user input.

The "ordered events" invariant is therefore not "events sorted by some monotonic value." It is "the projection from event-log → ModelMessage[] is the identity inverse of (the order in which the harness was actually fed user inputs and emitted assistant outputs)."

This is a correctness invariant, not a UX nicety. Violating it on the LLM-replay path (`apps/agent/src/runtime/history.ts:45` `eventsToMessages`) corrupts the model's view of the conversation — the model sees user messages it never had at the moment it produced the surrounding assistant content. Cache prefix bytes drift; subsequent turns behave as if a different conversation took place. Violation goes silent until you stress-test the interleaved-typing case.

### 1.2 Read paths in this codebase

Below: each call site that depends on event ordering, with file:line, and the kind of dependency.

| Path | File:line | Dependency |
|---|---|---|
| LLM context build (primary) | `apps/agent/src/harness/default-loop.ts:303-304` → `apps/agent/src/runtime/history.ts:497` (`SqliteHistory.getMessages`) → `history.ts:45` (`eventsToMessages`) | Walks `history.getEvents()` *strictly in returned order*, builds ModelMessage[]. |
| `SqliteHistory.getEvents` | `apps/agent/src/runtime/history.ts:487` → `packages/event-log/src/cf-do/index.ts:214-246` | `SELECT … FROM events ORDER BY seq` — there is no other ordering option exposed. |
| Compaction window build | `apps/agent/src/harness/compaction.ts:137,159,318,340` | All call `eventsToMessages(events)` — same projection as LLM context. |
| Sub-agent in-memory replay | `apps/agent/src/runtime/session-do.ts:3556` `new InMemoryHistory()` then `subHistory.append(userMsg)` then `harness.run(subCtx)` ← derives via `subHistory.getMessages()` → `eventsToMessages(this.getEvents())` (`history.ts:518`). | InMemoryEventLog `getEvents()` returns `_rows` in push order (`packages/event-log/src/memory/index.ts:92`). |
| Sub-agent fan-out into parent | `session-do.ts:3640-3645` (sub-agent's `runtime.broadcast` calls `parentHistory.append(taggedEvent)` and `this.broadcastEvent(taggedEvent)`). | The parent's events table interleaves sub-agent broadcasts among primary-thread events; replay isolation depends on `session_thread_id` filter, not on seq order alone. |
| REST `/events` (paginated list) | `session-do.ts:1851-1946` | `SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq ASC|DESC LIMIT ?`. Returns rows verbatim; the JSON `data` carries the `processed_at` ISO string the writer stamped (post-`a316dc3` this gets rewritten at drain). |
| REST `/threads/:thread_id/events` | `session-do.ts:2129-2158` | Same SQL shape, scoped by `session_thread_id`. Stashes `processed_at_ms` and `cancelled_at_ms` from row columns onto the parsed JSON. |
| WS replay on connect | `session-do.ts:1820-1835` | `new SqliteHistory(...).getEvents()` then forwarded one frame per event in seq order. New WS connection = full session backfill. |
| SSE bridge (live) | `apps/main/src/routes/sessions.ts:1182-1261` (`handleSSEStream`) → opens WS to SessionDO, forwards every WS message verbatim as `data:` SSE frame. | Event order = order `broadcastEvent` was called in SessionDO. |
| `broadcastEvent` itself | `session-do.ts:2920-2929` | Iterates `ctx.getWebSockets()`, calls `ws.send(JSON.stringify(event))`. No persistence. Pure fan-out. |
| Drain (queue lookup) | `session-do.ts:1064-1075` | Today: `SELECT seq, data FROM events WHERE session_thread_id=? AND processed_at IS NULL AND cancelled_at IS NULL AND type IN (...) ORDER BY seq ASC LIMIT 1`. Picks the *lowest-seq* pending user event. seq order = enqueue order today. |
| Drain (recovery / cold-start) | `session-do.ts:686-710` `recoverEventQueue`; in 3a3e7ec also `pending!.threadsWithPending()`. | Reads which threads have queued work; re-fires drain per thread. |
| Recovery scan | `packages/session-runtime/src/recovery.ts:55-153` `recoverInterruptedState` | Reads `history.getEvents()` (= seq order). Detects orphan tool_use rows and orphan streams. **Does not touch user-input ordering** — but DOES append synthetic `agent.tool_result` rows for orphans, which land at the *current tail of seq* and so always sort correctly under any of the candidates. |
| Console display | `apps/console/src/pages/SessionDetail.tsx:670-740` | After fetch, *re-sorts client-side* by `processed_at_ms`/`processed_at` with seq tiebreaker (the `7d40027` patch). Pending state derived heuristically from "no later non-user event in this thread". |
| `getLastEventSeq` (drain triggers, recovery context) | `session-do.ts:1311-1318`, `cf-do/index.ts:248-255` | Reads `MAX(seq) WHERE type=?`. Used by `recoverAgentTurn`'s `loadRecoveryContext` (`session-do.ts:935-936`) to find the most-recent `user.message` and slice "events after it" for the recovery prompt. |
| `getFirstEventAfter` | `session-do.ts:1324-1331`, `cf-do/index.ts:257-272` | Used in places that ask "what came next after seq X". |
| `getEventsBetween` (recovery slice) | `session-do.ts:1013-1032` | Slice helper for recovery; `WHERE seq > ? AND seq < ? ORDER BY seq`. |
| Aborted-stream rescue | `session-do.ts:582-622` | On stream abort writes the partial `agent.message` directly into the events table via `history.append`. Always lands at current seq tail. |

### 1.3 Two read paths matter for correctness; the rest are display

- **LLM replay** (`eventsToMessages` callers) — wrong order = silent prompt-cache drift, wrong reasoning, hallucinated history.
- **Recovery context slice** (`loadRecoveryContext`, `getLastEventSeq("user.message")` + `getEventsBetween`) — wrong order = recovery feeds the wrong "what to resume after" boundary.

The rest (REST list, SSE delivery, WS replay, console rendering) are display surfaces. Wrong order there is annoying but recoverable by reload. Wrong order in the LLM replay is corrupting model behavior in ways the user never sees directly.

### 1.4 What's broken today on `7d40027` baseline

`POST /event` with `body.type === "user.message"` (`session-do.ts:1612-1636`) does:
1. `history.append(um)` → `INSERT INTO events (..., processed_at=NULL, ...)` — `seq` assigned as `MAX(seq)+1` (AUTOINCREMENT). seq order = **time-of-arrival**, not time-of-processing.
2. `this.broadcastEvent(um)` — fan-out to every WS, with `processed_at` still null in the JSON payload.
3. `this.drainEventQueue(umThread)` — fire-and-forget. The drain mutex (`_draining` Set) blocks if another drain is in flight.

When the user types during a streaming agent reply, drain is busy. The new user.message gets a `seq` MID-prior-turn. drain finishes the prior turn, re-enters its loop, finds the queued user.message via the partial pending index (still ordered by seq within the queue, which is fine since both events have lower seqs than future events), stamps `processed_at = Date.now()`, runs the next turn.

Consequences:
- Console: `seq`-ordered render shows the user.message between agent text halves. **Patched on client by 7d40027** (sort by processed_at). REST polls show right order on next refresh; SSE-only consumers stay wrong because no UPDATE notification.
- LLM replay on the next-turn: `eventsToMessages(getEvents())` walks ORDER BY seq → builds messages in **arrival order** → model sees `[user "first", assistant "first answer first half", user "second", assistant "first answer second half", … current turn]`. **This is the open bug.** `a316dc3` and `7d40027` did not touch this.

### 1.5 What changed in `3a3e7ec` (the worktree's WIP checkpoint)

`packages/event-log/src/cf-do/index.ts`:
- `ensureSchema` adds `pending_events` table (lines 601-637).
- `CfDoEventLog.append` (lines 44-86) routes user.message / user.tool_confirmation / user.custom_tool_result into `pending_events` instead of `events`.
- `CfDoEventLog.appendPromoted` (lines 137-177) is the new write path drain is supposed to use.
- `CfDoPendingQueue` (lines 376-519) is the new repo with `popNext / cancelAllForThread / list / countActive / threadsWithPending`.

`packages/event-log/src/memory/index.ts`:
- `InMemoryEventLog.append` mirrors the routing (lines 44-72). Queue-input events go into the `_pending` array.
- `InMemoryEventLog.getEvents` only reads from `_rows` (lines 92-102). **Does not include pending.**
- `InMemoryEventLog.appendPromoted` exists (line 75).
- `InMemoryPendingQueue` mirrors the CF Pending repo.

`apps/agent/src/runtime/session-do.ts`:
- The change is small (`git diff 7d40027..3a3e7ec` for this file: 48 lines): adds `private pending: PendingQueueRepo | null` field, instantiates it in `ensureSchema`, calls `threadsWithPending()` on cold start, updates `recoverEventQueue` to union threads from both pending_events and the legacy partial-index.
- `drainEventQueue` (lines 1049-1202) is **unchanged from 7d40027** — still does `SELECT seq, data FROM events WHERE … processed_at IS NULL …` and `UPDATE events SET processed_at = ?, data = ?` to drain.
- POST `/event` user.message handler (lines 1612-1636) is **unchanged from 7d40027** — still does `history.append(um)` then `broadcastEvent(um)` then `drainEventQueue(umThread)`.

**Therefore, as `3a3e7ec` stands, the system is broken in two places:**
1. Primary thread: `history.append(um)` now puts the user.message into `pending_events` (because of the new `CfDoEventLog.append` routing). `drainEventQueue` still polls `events` → never finds it → session hangs forever for any new user.message until the row gets there some other way.
2. Sub-agent thread: `subHistory.append(userMsg)` (`session-do.ts:3561`) puts the user.message into `InMemoryEventLog._pending`. `subHistory.getMessages()` → `eventsToMessages(getEvents())` reads only `_rows` → empty messages array → harness sees no input → silently returns `(sub-agent produced no text output)` (the fallback at `session-do.ts:3692`).

This is well-described as "wip / untested" by the commit message, but it is the input to the decision and worth saying out loud: 3a3e7ec is a partial schema-and-port refactor that left the consumers wired to the old shape.

---

## 2. The three candidates

For each candidate I'll lay out: wire format, schema, insert path, drain path, SSE protocol, LLM replay, recovery, multi-thread, cost, and "what breaks if you ship today's code as-is."

I'll also explicitly walk through the interleaved-typing scenario and write out the SQL or pseudocode that produces the LLM messages array on the next turn.

### Candidate A — Single table; ordering primitive = `processed_at`

**Wire format**

Identical to today. `/v1/sessions/:id/events` returns `{seq, type, data, ts}` rows; the embedded `data.processed_at` is null until drain stamps it. SSE delivers each event as the writer broadcasts it. **Adds one new SSE frame**: a `system.user_message_promoted` carrying `{event_id, processed_at, seq}` (or simply re-broadcasts the user.* event with `processed_at` now stamped) so live consumers can update sort position.

**Storage schema**

Unchanged from today on `origin/main` (no `pending_events` table). The only DDL diff vs `7d40027` is "do nothing" — `cf-do/index.ts` schema bootstrap stays the way it was at `a316dc3`. Drop the `pending_events` table from 3a3e7ec.

**Insert path** (POST `/event` user.message, `session-do.ts:1612-1636`)

Unchanged: `history.append(um)` → INSERT INTO events with `processed_at = NULL`. seq assigned at insert via AUTOINCREMENT (= time-of-arrival). `broadcastEvent(um)` fans the row to all WS subscribers. `drainEventQueue(umThread)` fire-and-forget.

**Drain path** (`session-do.ts:1049-1202`)

Unchanged in shape. `SELECT seq, data FROM events WHERE … processed_at IS NULL ORDER BY seq ASC LIMIT 1`. Stamp `processed_at = Date.now()` (already does this at lines 1099-1112 with the `a316dc3` JSON-rewrite). **NEW**: after the UPDATE, re-broadcast the row so live consumers learn `processed_at` flipped. Either re-broadcast the canonical event (idempotent on the client because event id is unchanged) or emit a small `system.user_message_promoted` frame.

**SSE protocol**

- At insert: existing user.* broadcast with `processed_at = null`.
- At drain (NEW): one of:
  - Re-broadcast the canonical user.* event with `processed_at` now filled. SDK consumers that key by `id` see an "updated" version of the event.
  - Or a separate `system.user_message_promoted` frame `{event_id, processed_at_ms}`. Cleaner — doesn't create the SDK ambiguity of "this event arrived twice."
- Either way, this is one new wire concept, additive.

**LLM replay**

This is the load-bearing change. `eventsToMessages` consumes whatever order `getEvents()` gives it. Today `getEvents()` is `ORDER BY seq`. Under candidate A:

- Either change `SqliteHistory.getMessages()` to read `getEvents()` then sort by `processed_at_ms` (with seq tiebreaker), filtering rows with `processed_at IS NULL` (un-ingested) and rows with `cancelled_at IS NOT NULL` (already does this last filter at `history.ts:156`).
- Or push the sort into `getEvents()` itself by adding an option `getEvents({ orderBy: "processed_at" })`. Risk: every other consumer of `getEvents()` keeps using seq, so we now have two ordering primitives in the codebase, and the wrong one is the default.

The minimum-delta approach: a one-line change in `SqliteHistory.getMessages()`:
```ts
getMessages(): ModelMessage[] {
  const rows = this.getEvents()
    .filter((e) => (e as any).processed_at_ms != null)
    .sort((a, b) => {
      const ka = (a as any).processed_at_ms ?? Infinity;
      const kb = (b as any).processed_at_ms ?? Infinity;
      if (ka !== kb) return ka - kb;
      // seq tiebreaker (preserve write order within a single drain stamp)
      return (a as any).seq - (b as any).seq;
    });
  return eventsToMessages(rows);
}
```

`eventsToMessages` itself stays unchanged.

**Where does user.message land in the next-turn LLM messages array?**

Walk through interleaved scenario (matches `DUAL_TABLE_DESIGN.md` example):

After turn 1 finishes and turn 2 drains the queued "say HI", the events table looks like:
```
seq | type           | data.processed_at | row.processed_at
 10 | user.message   | "T=1"             | T=1   (stamped by drain)
 11 | agent.thinking | "T=2.5"           | T=2.5 (stamped at append)
 12 | agent.message  | "T=3"             | T=3
 13 | user.message   | "T=11"            | T=11  (typed T=5, drained T=11; data.processed_at rewritten by a316dc3)
 14 | agent.message  | "T=4"             | T=4
 …
 20 | agent.message  | "T=9"             | T=9
 21 | session.idle   | "T=10"            | T=10
```

`SqliteHistory.getMessages()` after the A change:
1. `getEvents()` reads ORDER BY seq → [10,11,12,13,14,…,20,21]
2. Sort by processed_at_ms with seq tiebreaker → [10,11,12,14,15,…,20,21,13]
3. `eventsToMessages` walks → builds `[user "count", assistant_text "1..3" + thinking, assistant_text "4..100", user "say HI"]`. **Correct.**

Note: this depends on the row's `processed_at_ms` (column) NOT the embedded JSON `data.processed_at`. The cf-do adapter already stashes the column value as `processed_at_ms` on the parsed event (`cf-do/index.ts:234-236`).

**Recovery (DO restart mid-turn)**

If the DO dies between `INSERT INTO events (…, processed_at = NULL, …)` and the drain UPDATE, on restart:
- `recoverInterruptedState` (`packages/session-runtime/src/recovery.ts`) runs first. It cares about orphan streams and orphan tool_use rows; it doesn't care about queued user inputs.
- `recoverEventQueue` (`session-do.ts:686-710`) finds the row via `SELECT DISTINCT session_thread_id FROM events WHERE processed_at IS NULL AND cancelled_at IS NULL AND type IN (…)` → re-fires drain → drain stamps processed_at and runs the turn.

If DO dies AFTER drain UPDATE but BEFORE `runAgentTurn` started writing agent events, the row has processed_at stamped but no agent reply followed. Next drain iteration's pending lookup misses it (processed_at is set). `recoverInterruptedState` doesn't address it. But the `_finalizeStaleTurns` path (`session-do.ts:5102`) handles stuck turns separately. The user's message is in the log; nothing replayed it. Acceptable behavior: log shows user.message followed by status_idle; user can re-send. Same as today.

**Multi-thread (sub-agents)**

Sub-agent path (`session-do.ts:3452-3692`): `subHistory = new InMemoryHistory()`. `userMsg` appended directly to it. `subHistory.append(userMsg)` → `InMemoryEventLog.append` (origin/main version, before 3a3e7ec routing) → into `_rows` with processed_at stamped. Harness reads `_rows` → user.message present → builds messages → ok.

For candidate A: revert the `InMemoryEventLog.append` routing (drop the `_pending` array entirely, since A doesn't have a queue concept). Sub-agent path is unchanged from origin/main.

Parent timeline: sub-agent runtime broadcasts (`session-do.ts:3640-3645`) tag events with `session_thread_id` and `parentHistory.append(taggedEvent)`. These land in the parent's events table with a `session_thread_id` column populated. `eventsToMessages` for the primary thread filters by `session_thread_id` (it doesn't currently — but it should; that's a separate latent bug, not specific to ordering). For the parent's REST/SSE views, sub-agent events are interleaved by processing time, which is the right behavior.

**Cost per user.message**
- 1 INSERT into events at append
- 1 UPDATE events at drain (stamps processed_at, rewrites data JSON)
- 0 R2 round-trips (small payload)
- 1 broadcast at append
- 1 broadcast at drain (the new "promoted" frame)
- Total: 1+1+0 SQL writes, 2 SSE frames

**What breaks if you ship today's code as-is** (i.e., 7d40027 with the LLM-replay fix from A but no SSE re-broadcast)
- LLM context becomes correct (the only safety-critical fix).
- Live console: 7d40027's heuristic still works for the common case.
- Live SSE-only consumer: their client sort by `processed_at` would put pending user.* events in indeterminate position because they never get the UPDATE. Solvable by keeping a "pending bin" in their UI, but they need the heuristic Console already implements.

**A's risk profile**
- Silent failure mode 1: future code that uses `history.getEvents()` and walks in returned order without re-sorting will replay in seq order = arrival order. The `processed_at` discipline is a CONVENTION enforced only at the `SqliteHistory.getMessages()` layer.
- Silent failure mode 2: forgetting the `processed_at IS NOT NULL` filter — pending events with NULL processed_at would sort to the start (NULL sorts first in JS `< Infinity`) or end depending on tiebreaker, and be projected into ModelMessage[] anyway. Either way, the LLM sees a user.message twice.
- Silent failure mode 3: two non-queue events stamped in the same ms (drain bursts can produce this, though rare) tie on processed_at; seq tiebreaker covers this. Not a real risk if the tiebreaker is in place from day 1, but easy to drop.

### Candidate B — Single table; ordering primitive = late-assigned monotonic sequence

**Wire format**

`/v1/sessions/:id/events` returns rows; pending rows expose `seq = null` (or absent) on the wire. SSE delivers events as the writer broadcasts them. Two new frame types: pending broadcast (insert) and promotion broadcast (drain).

**Storage schema (this is the load-bearing detail for B)**

The naive shape "make seq nullable" doesn't work — SQLite PRIMARY KEY columns are NOT NULL by definition (AUTOINCREMENT requires that). So B requires one of two physical shapes:

**B-1**: Two integer columns; `pending_seq INTEGER PRIMARY KEY AUTOINCREMENT` is row identity assigned at insert; `seq INTEGER` is nullable, indexed UNIQUE WHERE NOT NULL, populated at drain.

```sql
CREATE TABLE events (
  pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER,                                 -- NULL until promoted
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT …,
  processed_at INTEGER,
  cancelled_at INTEGER,
  session_thread_id TEXT
);
CREATE UNIQUE INDEX idx_events_seq
  ON events(seq) WHERE seq IS NOT NULL;
CREATE INDEX idx_events_pending
  ON events(session_thread_id, pending_seq)
  WHERE seq IS NULL AND cancelled_at IS NULL
    AND type IN ('user.message', 'user.tool_confirmation', 'user.custom_tool_result');
```

This is a DESTRUCTIVE schema change vs the existing `seq INTEGER PRIMARY KEY AUTOINCREMENT, …`. SQLite ALTER TABLE cannot change PK. Migration requires CREATE TABLE new, INSERT SELECT, DROP TABLE old, RENAME TABLE — non-trivial in DO storage SQL on populated DOs.

**B-2 (the survivable variant)**: Keep `seq INTEGER PRIMARY KEY AUTOINCREMENT` exactly as today. Add a separate `log_seq INTEGER` column, nullable, indexed UNIQUE WHERE NOT NULL.
- For non-queue events at insert: `log_seq = seq` (one extra UPDATE in same INSERT statement, or use a trigger, or two-statement INSERT).
- For queue events at insert: `log_seq = NULL`.
- At drain: `UPDATE events SET log_seq = (SELECT COALESCE(MAX(log_seq),0)+1 FROM events) WHERE seq = ?`. Concurrency: the drain mutex `_draining` per thread serializes per-thread, but cross-thread drains can race on MAX(log_seq). Either use a separate counter row in a tiny `seq_counters` table, or accept that DO storage SQL serializes writes within a DO so MAX+1 within a single transaction is safe.

All replay queries change from `ORDER BY seq` to `ORDER BY log_seq`. Migration: `ALTER TABLE events ADD COLUMN log_seq INTEGER; UPDATE events SET log_seq = seq WHERE log_seq IS NULL;`. Additive, survives ALTER TABLE.

I'll evaluate B as B-2 since it's the only realistic shape on existing prod DOs.

**Insert path (POST /event, user.message)**

```
INSERT INTO events (type, data, ts, processed_at, cancelled_at, session_thread_id, log_seq)
  VALUES ('user.message', json, now_s, NULL, NULL, threadId, NULL)
```

`seq` = AUTOINCREMENT assigned. `log_seq` = NULL. broadcast frame with `seq` set, `log_seq = null`, `processed_at = null`.

**Drain path**

```
SELECT seq, data FROM events
  WHERE session_thread_id = ? AND log_seq IS NULL AND cancelled_at IS NULL
    AND type IN (…)
  ORDER BY seq ASC LIMIT 1                -- pending_seq order = arrival order = correct FIFO
-- … process …
UPDATE events SET
  log_seq = (SELECT COALESCE(MAX(log_seq), 0) + 1 FROM events),
  processed_at = ?,
  data = ?                                 -- a316dc3-style JSON rewrite
  WHERE seq = ?
broadcast(system.user_message_promoted{event_id, log_seq, processed_at, seq})
```

**SSE protocol**
- Insert broadcast: existing user.* event with `processed_at: null`. (Optionally also: `system.user_message_pending{event_id, seq}`.)
- Promotion broadcast: `system.user_message_promoted{event_id, log_seq, processed_at}`.

Same wire surface as A, plus the additional `log_seq` field on the wire.

**LLM replay**

Change `SqliteHistory.getEvents()` to `ORDER BY log_seq ASC` (the canonical replay order). Add `WHERE log_seq IS NOT NULL` to exclude pending events. Cancelled-event filter stays in `eventsToMessages`.

Or: keep `getEvents()` ordering by `seq` (so cursors work) but change `getMessages()` to `getEvents()` then filter & sort by `log_seq` client-side.

**Where does user.message land?**

Same scenario as A. After turn 2 drains:
```
seq | log_seq | type           | processed_at
 10 |    1    | user.message   | T=1
 11 |    2    | agent.thinking | T=2.5
 12 |    3    | agent.message  | T=3
 13 |   12    | user.message   | T=11      <-- arrived T=5 (seq=13), drained T=11 (log_seq=12)
 14 |    4    | agent.message  | T=4
 …
 20 |   10    | agent.message  | T=9
 21 |   11    | session.idle   | T=10
 22 |   13    | agent.message  | T=12      (turn-2 reply)
```

`getEvents() WHERE log_seq IS NOT NULL ORDER BY log_seq` → [10,11,12,14,…,20,21,13,22,…]. `eventsToMessages` builds `[user "count", assistant_text "1..100", user "say HI", assistant "HI back"]`. **Correct.**

The crucial property: `log_seq` is monotonic with what the model saw. The same property as candidate C. The only difference is that the row identity (`seq`) is assigned earlier than the position in the log (`log_seq`).

**Recovery**

On DO restart mid-turn:
- Rows with `log_seq IS NULL` are queued. `recoverEventQueue` re-fires drain.
- Rows with `log_seq IS NOT NULL` are processed; they don't get touched again.

If DO dies between the SELECT-pending and the UPDATE, the row stays NULL and re-drains on restart. Idempotent.

If DO dies between UPDATE (log_seq filled) and runAgentTurn's first agent event, the row is in the log (right slot) but no agent reply. Same as A's case: log shows user message followed by silence; recovery's `_finalizeStaleTurns` cleans up the dangling D1 turn marker; user can re-send.

**Multi-thread (sub-agents)**

In B-2 the InMemoryHistory could mirror the same shape (extra `log_seq` field on each in-memory row). But sub-agents don't have a queueing concern — they get their `userMsg` synchronously and run to completion. So InMemoryHistory can just keep its current shape (push to `_rows`, log_seq = seq always for in-memory rows). Replay query for in-memory: same as today. No change needed.

Parent timeline: same sub-agent broadcast pattern as today.

**Cost per user.message**
- 1 INSERT into events
- 1 UPDATE events at drain (sets log_seq + processed_at + data)
- 0 R2 round-trips
- 1 broadcast at append
- 1 broadcast at promotion
- Cost: 1+1+0 writes, 2 SSE frames
- Plus: the UPDATE's `(SELECT COALESCE(MAX(log_seq),0)+1 FROM events)` is a full-table scan unless we index `log_seq DESC`. Index `idx_events_seq` covers UNIQUE-WHERE-NOT-NULL but doesn't necessarily make MAX fast; SQLite usually uses the index for MAX queries. In practice trivial cost.

**What breaks if you ship today's code (origin/main) as-is**
The LLM context bug stays open. Same as A.

**B's risk profile**
- Silent failure mode 1: forgetting `WHERE log_seq IS NOT NULL` in any read → pending events sort to the START (NULL ASC < any number) and inject into the LLM context as the first user message. Catastrophic prompt-cache drift.
- Silent failure mode 2: any code path that does `MAX(seq)` to "find the latest" thinks pending events count. `getLastEventSeq("user.message")` (`session-do.ts:1311`) becomes wrong — it'd return the seq of a still-queued message and `getEventsBetween` would slice from the wrong boundary.
- Silent failure mode 3: cross-thread drain race on `MAX(log_seq)+1`. DO storage SQL serializes writes (single-writer model), so this is actually safe — but the safety lives in the DO storage abstraction, not in B's design. If we ever add multi-DO sharding, this breaks.
- Silent failure mode 4: every legacy query in the codebase that does `ORDER BY seq` is now wrong. There are 7+ callsites grepable today (`getEvents`, `getEventsBetween`, `getLastEventSeq`, `getFirstEventAfter`, REST `/events`, REST `/threads/:tid/events`, WS replay). Each must be touched and re-tested.
- Naming hazard: `seq` and `log_seq` look almost identical. Future contributors will reach for `seq` because it's named more obviously and have to be told no.

The B-2 shape is the only one that's actually shippable. The B-1 shape (PK change) can't be migrated without a destructive table-rebuild on every DO at deploy time, with the failure mode that any concurrent write during rebuild is lost.

### Candidate C — Dual table

**Wire format**

`/v1/sessions/:id/events` returns the LOG (only processed events). NEW `/v1/sessions/:id/pending` returns the QUEUE. SSE delivers all events; new frame types `system.user_message_pending` (insert), `system.user_message_promoted` (drain), `system.user_message_cancelled` (interrupt-flushed).

**Storage schema**

Two tables. `events` keeps its existing shape (single primary key `seq AUTOINCREMENT`, processed_at stamped at every insert). `pending_events` is the new queue table:

```sql
CREATE TABLE pending_events (
  pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO within queue
  enqueued_at INTEGER NOT NULL,
  session_thread_id TEXT NOT NULL,
  type TEXT NOT NULL,         -- user.message | user.tool_confirmation | user.custom_tool_result
  event_id TEXT NOT NULL,     -- == data.id, for client correlation
  cancelled_at INTEGER,
  data TEXT NOT NULL          -- full JSON
);
CREATE INDEX idx_pending_thread_seq ON pending_events(session_thread_id, pending_seq);
CREATE INDEX idx_pending_active
  ON pending_events(session_thread_id, pending_seq) WHERE cancelled_at IS NULL;
```

Already in 3a3e7ec at `cf-do/index.ts:601-637`.

**Insert path (POST /event, user.message)**

`history.append(um)` → `CfDoEventLog.append` (3a3e7ec at `cf-do/index.ts:67-86`) → INSERT INTO pending_events.
broadcast frame: `system.user_message_pending{event_id, pending_seq, enqueued_at, session_thread_id, event}`. Optionally also broadcast the canonical user.* frame for back-compat.

**Drain path**

```
loop:
  row = pending.popNext(threadId)  -- atomic SELECT + DELETE per row
  if row is null: break
  event = JSON.parse(row.data)
  promotedSeq = eventLog.appendPromoted(event, Date.now())   -- INSERT INTO events RETURNING seq
  broadcast(system.user_message_promoted{event_id: row.event_id, pending_seq: row.pending_seq,
                                         seq: promotedSeq, processed_at})
  broadcast(event with processed_at filled)                 -- back-compat for clients that key on user.* type
  await runAgentTurn(...)                                   -- harness writes agent.* events into events
```

The two writes (`popNext` DELETE + `appendPromoted` INSERT) are not strictly atomic across tables. DO storage SQL is single-writer per DO so they don't interleave with each other, but a process death between DELETE and INSERT loses the event. **Mitigation: do INSERT first, then DELETE.** Failure mode flips to "duplicate-promote" instead of "lost event," and the duplicate check is cheap (event id is unique on the row's data).

Actually a cleaner shape: do them in the opposite order in `popNext`-then-`appendPromoted` style by holding the row in memory between the SELECT (without DELETE) and the INSERT, then deleting after the INSERT succeeds. The 3a3e7ec implementation does SELECT then DELETE inside `popNext` (cf-do/index.ts:391-413). This is incorrect for crash safety. The drain code should:
```
row = SELECT … LIMIT 1   -- read but don't delete
event = parse(row.data)
seq = appendPromoted(event)
DELETE FROM pending_events WHERE pending_seq = row.pending_seq
```

**SSE protocol**

Three new frames:
- `system.user_message_pending` at insert
- `system.user_message_promoted` at drain
- `system.user_message_cancelled` at interrupt-flush

Old SDK consumers ignore the `system.*` types (`packages/sdk/src/sse.ts` is a passthrough). New Console code consumes them to render outbox + correlate pending bubbles.

**LLM replay**

`eventsToMessages` and `getEvents()` are **unchanged from origin/main**. `events` only contains processed rows. seq order = drain order = correct.

This is the strongest property of C: the entire `eventsToMessages` projection — including the compaction-summary boundary handling, the cancelled_at filter, the tool-name pre-pass — keeps working identically. Zero changes.

**Where does user.message land?**

Same scenario. After turn 2:
```
events table:
seq | type           | processed_at | data.content
 10 | user.message   | T=1          | "count to 100"
 11 | agent.thinking | T=2.5        | (thoughts)
 12 | agent.message  | T=3          | "1..3"
 13 | agent.message  | T=4          | "4..5"
 …
 19 | agent.message  | T=9          | "100"
 20 | session.idle   | T=10         |
 21 | user.message   | T=11         | "say HI"      <-- INSERTed at drain, not at typing time
 22 | agent.message  | T=12         | "HI back"
 …
 24 | session.idle   | T=15         |

pending_events table: empty (msg2 row was DELETEd at drain)
```

`getEvents()` walks ORDER BY seq → `eventsToMessages` builds `[user "count", assistant "1..100", user "say HI", assistant "HI back"]`. **Correct.** No code changes in eventsToMessages.

**Recovery**

On DO restart with rows queued:
- 3a3e7ec wires `ensureSchema` to call `pending!.threadsWithPending()` and re-fire drain per thread (`session-do.ts:530-540`).
- `recoverEventQueue` (`session-do.ts:686-710`) reads the union of pending_events distinct threads + the legacy events partial-index threads.

DO dies between drain's `appendPromoted` INSERT and the `DELETE pending_events`: the user.* event is now in BOTH tables. On next drain, the row gets popped from pending_events again, and the harness runs the turn again. **Duplicate turn = duplicate token spend.** Mitigation: deduplicate by `event_id` in `appendPromoted` (look up `SELECT 1 FROM events WHERE json_extract(data,'$.id') = ? LIMIT 1`; if hit, just DELETE pending_events row and move on). Or use SQLite's `INSERT … ON CONFLICT(json_extract(data,'$.id')) DO NOTHING` if we add that index. Has a real cost.

DO dies between `appendPromoted` and `runAgentTurn`'s first emit: the user.message is in events table with processed_at = drain time. No agent reply followed. `_finalizeStaleTurns` cleans up the D1 row. User sees their message in the log; no agent reply. Identical to A and B's behavior in the same case.

**Multi-thread (sub-agents)**

Sub-agent path in 3a3e7ec is silently broken (see §1.5). Required fix: either:
- Sub-agent wraps `subHistory.append(userMsg)` to bypass the queue routing — call `subHistory._repo.appendPromoted(userMsg, Date.now())` directly. Ugly cross-layer call.
- Or InMemoryHistory exposes an `appendDirect()` method that bypasses queue routing.
- Or the sub-agent uses a different InMemoryHistory variant (`InMemoryHistoryNoQueue`) that doesn't have `_pending`.

Cleanest: drop the queue routing in `InMemoryEventLog.append` entirely. Sub-agents and tests don't have a queueing concern (no concurrent runs share an in-memory history). The queue routing should live in the SqliteHistory caller, not in the EventLogRepo port — i.e., `CfDoEventLog.append` should NOT auto-route to pending_events; instead, `SessionDO`'s POST /event handler should explicitly call `pending.enqueue(event)` for queue-input event types and `eventLog.append(event)` for everything else.

Refactor: pull the type-discrimination out of `CfDoEventLog.append` and into the SessionDO POST /event handler. Keeps the Repo port primitive ("just write a row") and makes the queue routing visible at the call site. Side benefit: the legacy backfill (legacy partial-index drain on `events`) becomes a one-liner in the same handler instead of bleeding into the adapter.

Parent timeline for sub-agent broadcasts: same as today (`session-do.ts:3640-3645`). Sub-agent broadcasts go through `parentHistory.append(taggedEvent)` which is a SqliteHistory; non-queue event types so they go straight to events table.

**Cost per user.message**
- 1 INSERT into pending_events (at append)
- 1 SELECT + 1 INSERT into events + 1 DELETE from pending_events (at drain)
- 0 R2 round-trips
- 1 broadcast at append (system.user_message_pending)
- 1 or 2 broadcasts at drain (system.user_message_promoted, plus optional canonical event re-broadcast)
- Cost: 4 SQL writes + 1 SQL read; 2-3 SSE frames. Highest of the three candidates.
- Plus: every DO that has a session also has a `pending_events` table that's empty 99.99% of the time. 0 storage cost (DO SQLite doesn't allocate empty pages for empty tables).

**What breaks if you ship today's code (origin/main) as-is**
LLM context bug stays open. Same as A and B.

**C's risk profile**
- Silent failure mode 1 (the sub-agent breakage in 3a3e7ec): code path that uses InMemoryHistory.append for queue-input events sees them silently disappear from getEvents. Already bit us; needs the routing-out-of-adapter fix.
- Silent failure mode 2: code that wants to surface "pending state" to the UI must know about `pending_events`. Forgetting it = pending bubbles vanish. This is a LOUD failure during testing (user types, sees nothing pending) — not silent corruption.
- Silent failure mode 3: cross-table promotion crash window. INSERT-then-DELETE order mitigates loss; deduplication-by-event-id handles the duplicate-promote case. Both need to be implemented; neither is in 3a3e7ec.
- Less-silent failure mode: every reader that wants "all events including pending" has to UNION two tables. The dual-table design accepts this (`/pending` is a separate endpoint). Anyone who naively `SELECT * FROM events` gets only the log, which is what most readers want.

### Candidate D? An honest look at "do nothing more"

The user invited a "no, the existing patches are enough" rebuttal. Let me steelman it.

The existing patches (a316dc3 + 7d40027) fix the DISPLAY path. The Console renders right-on-refresh, and live state is heuristically OK. REST polls return rows with the right `data.processed_at` so SDK consumers that key on that field can sort.

But the LLM replay (`eventsToMessages`) walks `getEvents()` which is `ORDER BY seq`. There is no patch on `7d40027` that touches this. The wire bug — model sees `user "say HI"` interleaved between two halves of an agent reply on the next turn — is real and unfixed.

A 1-line fix to `SqliteHistory.getMessages()` to sort by `processed_at_ms` (which is exactly the minimum-A change from §2.A) would close the bug with zero schema and zero new endpoints. But it's still a NEW commitment to "processed_at is the ordering primitive everywhere it matters" — which is candidate A.

So D = "ship one more 1-line patch that picks A as the primitive" is structurally A. Not a fourth option.

The next question: is there a real fourth that I haven't considered?

**Real candidate D** — Single table; insert into events ONLY at drain time; queue lives in DO storage (not in SQL).

Variant: instead of a `pending_events` SQL table, hold the queue in `ctx.storage.put("pending:<thread>:<arrival_idx>", event)` (DO key-value storage, not SQL). Drain pops the lowest-key entry, INSERTs into events with assigned seq.

Properties:
- Avoids the dual-table SQL surface
- Uses DO storage's transactional KV which IS atomic with SQL writes (same DO storage namespace)
- Queue list = `ctx.storage.list({ prefix: "pending:..." })`
- Cancel = `ctx.storage.delete(...)`
- No new SQL tables, no schema migration concerns at all

Counter-arguments:
- Mixing storage types (KV for queue, SQL for log) makes the codebase harder to reason about
- KV doesn't support indexed search by `session_thread_id` natively — you'd encode it into the key prefix
- `list({ prefix })` is acceptable but not as ergonomic as `SELECT WHERE`
- We lose the "everything in one consistent SQL story" property the codebase already has

I think candidate D is real but worse than C. Doesn't change the recommendation.

---

## 3. Compare on real risk

### 3.1 Silent-failure surface

| Candidate | Silent failure if forgotten |
|---|---|
| A | Forget `processed_at IS NOT NULL` filter → pending events injected into LLM context. Forget the `processed_at` sort → revert to seq order = today's bug. |
| B-2 | Forget `WHERE log_seq IS NOT NULL` → pending events sort to start of LLM context. Forget `ORDER BY log_seq` (use seq instead) → today's bug. `getLastEventSeq` semantics change. |
| C | Sub-agent uses InMemoryHistory wrong → queue-input vanishes (already happened in 3a3e7ec). Forget pending_events exists in a UI surface → outbox missing from one screen, loud. Forget INSERT-before-DELETE order → lose event on crash. |
| D (KV queue) | Mixed-storage discipline forgotten → queue appears in unexpected places. |

A and B share the worst failure mode: it's silent on the load-bearing path (LLM replay). C's failure modes are loud (UI shows nothing, sub-agent silently produces no output — but the silence is detected by any test that asserts "sub-agent produced text").

### 3.2 Moving parts

| Candidate | Schema | Adapters | Endpoints | SSE frames | Code paths touched |
|---|---|---|---|---|---|
| A | 0 | 0 ports added | 0 new | 1 new | 2 (eventsToMessages sort + drain re-broadcast) |
| B-2 | 1 column added | 1 method added (assignSeq) | 0 new | 2 new | 7+ (every ORDER BY seq site changes) |
| C | 1 table added | PendingQueueRepo (5 methods) + appendPromoted | 1 new (`/pending`) | 3 new | 4 (POST /event handler, drain, recovery, sub-agent) |
| D (KV queue) | 0 | New PendingQueue interface backed by DO KV | 1 new | 3 new | Same call sites as C |

A is smallest delta. C is a focused medium delta. B-2 is wider because the ordering primitive change touches every read.

### 3.3 What does Anthropic do internally? (admit unknown)

I don't know how Anthropic implements AMA internally. Reasoning about plausible designs at their scale:

- AMA's wire spec exposes `processed_at: null` for queued events in the same `/events` list. It does not expose `seq`. Wire shape is closest to A's "single store with a null/non-null discriminator."
- At scale, Anthropic likely doesn't store the full session in a single co-located store. Sessions probably shard across multiple backends. A separate "task queue" surface (Temporal-like) feeding a separate "event store" surface (Kafka-like) is the standard pattern. That's structurally **closest to C**.
- AMA's `interrupt` semantic ("jumps the queue") strongly implies the queue is a first-class object the platform reasons about — not just rows-with-a-flag in the main log. That's also a vote for C.
- The wire spec's choice to expose pending events in the same list as processed events is a presentation choice; it doesn't constrain the storage shape.

My honest read: AMA's wire shape pushes you toward "the consumer doesn't care if there are two stores — just give me the merged view." Implementation can be A, B, or C; the wire spec doesn't lock you in. But the steering primitives ("queue jumping," "processed in order") match C's mental model better than A/B.

### 3.4 Throwaway from existing checkpoints

| Candidate | a316dc3 (drain rewrites JSON.processed_at) | 7d40027 (client sort) | 3a3e7ec (dual-table schema + ports) |
|---|---|---|---|
| A | KEPT (essential for the SDK consumer) | KEPT (covers live SSE-only consumers without re-broadcast) | THROWAWAY |
| B-2 | KEPT (still useful for back-compat surface) | THROWAWAY (client renders by seq again) | THROWAWAY |
| C | KEPT (legacy backfill path uses it) | THROWAWAY (Console renders by seq again) | KEPT and EXTENDED |
| D | KEPT | KEPT | THROWAWAY |

C has the smallest throwaway given current state; it's also the only one that builds on `3a3e7ec`'s investment. A throws away the most because we'd be reverting `3a3e7ec`. B-2 throws away both `7d40027` and `3a3e7ec`.

---

## 4. Recommendation: **C**

### 4.1 The pick and why

I recommend **Candidate C — dual table**, with the following adjustments to the 3a3e7ec checkpoint:

1. **Pull queue routing OUT of `CfDoEventLog.append`.** The adapter should be primitive — write a row, don't decide where. The decision lives in the POST /event handler in SessionDO. This:
   - Fixes the silent sub-agent breakage by making `InMemoryHistory.append` a pure "append to log" operation.
   - Makes the dual-table semantics visible at the call site.
   - Removes the need for a separate `appendPromoted` method — drain just does `eventLog.append(event)` after `pending.popNext()` returns the row.

2. **Order drain's writes as INSERT-then-DELETE, not DELETE-then-INSERT.** The current 3a3e7ec `popNext` does SELECT-then-DELETE inside one method (cf-do/index.ts:391-413), then the caller is supposed to call appendPromoted. If the DO dies between popNext and appendPromoted, the event is lost. Restructure drain to:
   ```
   row = pending.peek(threadId)        -- new method: SELECT, no DELETE
   if !row: break
   event = JSON.parse(row.data) with processed_at filled
   eventLog.append(event)              -- INSERT, gets seq via AUTOINCREMENT
   pending.delete(row.pending_seq)     -- only after INSERT succeeds
   broadcast(...)
   runAgentTurn(...)
   ```
   Failure between INSERT and DELETE = duplicate-promote on next drain. Mitigation: drain checks "is event_id already in events table?" before INSERT, OR adds a UNIQUE index on `events(json_extract(data, '$.id'))`. The check is cheap (event_id is a 22-char ULID-like; an indexed lookup is sub-millisecond on DO storage SQL).

3. **POST /event handlers stop calling `history.append` for queue-input events.** They explicitly call `pending.enqueue(event)`. The handler emits the new `system.user_message_pending` SSE frame. They still call `drainEventQueue(thread)` fire-and-forget.

4. **Drop the legacy backfill from `drainEventQueue`** unless we have evidence of stuck pre-deploy rows in production. The `idx_events_pending` partial index on `events` becomes a no-op (zero matching rows) for new sessions. For existing sessions with stuck `processed_at IS NULL` user.* rows in the `events` table, we can write a one-shot migration script that re-routes them through pending_events, OR accept that any session active at deploy time loses its in-flight queue state (acceptable for the small window).

5. **Sub-agent harness: confirm the path doesn't depend on queue semantics.** It doesn't — sub-agents call `subHistory.append(userMsg)` directly, run synchronously, return. No drain, no pending. Per (1) above, after the routing pull-out, this works as in origin/main.

6. **`/v1/sessions/:id/pending` endpoint is good but not strictly required for the LLM-replay correctness fix.** Ship it as part of the same change since it's small, but it's separable.

### 4.2 Kill criterion for the recommendation

I'd be wrong if any of the following is observed in dogfooding the C build:

- **Drain-loss rate > 0** in a one-week soak with synthetic interleaved-typing load. Measure: emit a synthetic event after every drain that records `pending.countActive() == 0 OR drainAgain()` was called. Should be 0 at session-end.
- **Duplicate-promote rate > 0.01%** (events table containing two rows with the same `data.id`). Measure: SQL audit query at session-end.
- **Legacy-session breakage on deploy** — a session created on `7d40027` whose user.* events are still pending at the moment we deploy the C build. If we drop the legacy backfill (per 4.1.4) and observe lost queued events at deploy boundary, we'd have to add the backfill back. Cheap to add later; expensive to drop the choice.
- **Sub-agent latency or error-rate regression** of any kind. The routing pull-out should be net-zero for sub-agents; if the migration introduces a regression, the design is too coupled.

If any of these signals appears, the right pivot is to fall back to A. A is the smallest delta from `7d40027` and is provably correct for the LLM-replay path with one line of code.

### 4.3 Why not B (the user's prior)

B-2 is the only physically realistic shape (B-1's PK change can't be migrated cleanly). It does close the LLM-replay correctness gap by making `log_seq` the canonical ordering primitive. But:

1. **It requires changing every `ORDER BY seq` callsite.** There are 7+ today. Each is a chance for silent corruption if a future read forgets `WHERE log_seq IS NOT NULL`. C requires zero changes to `eventsToMessages` and `getEvents` — `events` table semantics stay identical to today, just with row-routing changed at insert time. The "primitive that survives both read paths" is genuinely `seq` in C; in B it's `log_seq` and `seq` becomes a vestigial cursor.

2. **The "single primitive" framing the user asked for is actually preserved BETTER by C.** In C, `events.seq` is the primitive. seq order = drain order = LLM-saw-this-order. In B, `events.seq` is no longer the primitive (it's row-identity) and the new primitive `log_seq` lives next to it on the same row. Two columns, two semantics, same name pattern. C's "queue is one table, log is another" is more obviously a separation than B's "two integer columns on one row, one of which is sometimes NULL."

3. **The `interrupt-jumps-the-queue` AMA semantic is structurally cleaner in C.** In C, interrupt = `cancelAllForThread(thread)` on pending_events, which is a single UPDATE on a focused index. In B-2, it's `UPDATE events SET cancelled_at = ? WHERE log_seq IS NULL AND ...` which requires that partial index to exist and the right rows to be visible to it.

If B-1 (the cleaner B with PK rewrite) were physically migratable, the call would be much closer. B-1 is not migratable on existing DOs without a destructive copy-rename, which the codebase has never had to do. So B-2 is the only B in play, and C wins on every criterion against B-2.

### 4.4 Why C over A specifically

A is the smallest delta and structurally honest. The reasons C wins despite being more work:

- **`seq` order = drain order** is a property worth preserving. It survives every existing query in the codebase, including third-party SDK consumers that might be doing their own ordering. A breaks that property by making `seq` no longer reflect logical order.
- **The dual-table separation aligns with the AMA "queue jumps + interrupt" mental model**, even though the wire spec doesn't expose two surfaces.
- **3a3e7ec is largely correct** at the storage-and-port layer. C builds on it; A throws it away.
- **Loud failure modes** for forgetting (UI breaks, sub-agent silent) vs A's silent failures (LLM context wrong) are easier to catch in dogfooding.
- C's ONE genuinely silent failure mode (the cross-table promotion crash window) has a focused mitigation (INSERT-before-DELETE + dedup-by-event-id). A's silent failures are diffuse (any future query that walks getEvents).

### 4.5 What C costs you

- ~3-4 days of focused implementation to finish the 3a3e7ec wiring (drain rewrite, POST /event handlers, sub-agent fixup, /pending endpoint, Console outbox UI, SSE frame plumbing, dedup-by-event-id index).
- A modest increase in DO SQL writes per user message (4 vs 2 for the dual-table promotion).
- Console rewrite to consume `system.user_message_pending`/`promoted`/`cancelled` frames; can throw away the 7d40027 client sort heuristic (or keep both during transition).

### 4.6 What you commit to AGAINST when picking C

- You do not pick A. The minimum-delta fix to LLM-replay sort is intentionally NOT enough; you accept the additional schema + endpoint cost in return for `seq` keeping its meaning.
- You do not pick B. The single-table-with-late-seq variant is ruled out because the seq column rename is destructive on existing DOs, and the silent-failure surface (forget WHERE seq IS NOT NULL) is worse than C's surface.
- You do not pick D (KV queue). The cleaner storage uniformity of "everything in SQL" is more valuable than the slight schema simplification of "no new SQL table."

---

## 5. Outstanding TODOs (only relevant since the pick isn't B)

Per the user's request: "If your recommendation isn't B, explain why B isn't the answer in 2-3 sentences."

B-1's PK change can't be migrated on existing prod DOs without a destructive table-rebuild that'd force every pre-existing DO into a coordinated copy-rename-drop dance. B-2 (the survivable variant with `seq` + `log_seq`) preserves correctness but requires touching every `ORDER BY seq` callsite in the codebase and renames `seq` from "the ordering primitive" to "row identity / pagination cursor"; the rename hazard is high. C achieves the same correctness while leaving `seq` as the primitive everywhere it matters and confining queue semantics to a focused new surface.

---

## 6. Summary paragraph

Pick **C — dual table**. The `pending_events` schema and ports already shipped at `3a3e7ec` are mostly right; finish them by pulling queue-routing out of `CfDoEventLog.append` (it should live at the SessionDO POST `/event` site, not in the adapter), reordering drain to INSERT-then-DELETE for crash safety, and adding event-id dedup. After this, `events.seq` keeps its existing meaning across every read path — REST list, SSE delivery, WS replay, LLM-replay, recovery slice, sub-agent thread context — and the LLM-replay path needs **zero changes to `eventsToMessages` or `getEvents`**, because rows in `events` are by construction in drain order. The only non-obvious failure mode is the cross-table promotion window, which is mitigated by ordering writes correctly and adding a uniqueness check on `data.id`. Kill the recommendation if you observe any drain-loss or duplicate-promote events in a one-week soak, in which case fall back to A (one-line sort fix in `SqliteHistory.getMessages`) — A is provably correct for LLM replay and ships in an hour, but it makes `processed_at` the canonical primitive and turns `seq` into a vestigial cursor, which is a worse long-term property than C's "seq stays seq."

---

## Critical Files for Implementation

- `/tmp/oss-dual/apps/agent/src/runtime/session-do.ts` — POST `/event` handlers (lines 1612-1717), drain (1049-1202), sub-agent fan-out (3452-3692), broadcast (2920-2929), recovery wiring (655-710, 5018-5092)
- `/tmp/oss-dual/packages/event-log/src/cf-do/index.ts` — `CfDoEventLog.append` (44-126), `appendPromoted` (137-177), `CfDoPendingQueue` (376-519), `ensureSchema` (529-637)
- `/tmp/oss-dual/packages/event-log/src/memory/index.ts` — InMemoryEventLog routing (24-102), InMemoryPendingQueue (132-179) — must be reverted or reshaped to fix the silent sub-agent breakage
- `/tmp/oss-dual/apps/agent/src/runtime/history.ts` — `eventsToMessages` (45-115) and `SqliteHistory` (473-499) — should NOT change under recommendation C
- `/tmp/oss-dual/apps/console/src/pages/SessionDetail.tsx` — timeline render + client sort (lines 670-740), to be updated to consume `system.user_message_*` SSE frames
