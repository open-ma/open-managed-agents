# Dual-table event log

Branch: `feat/dual-table-and-llm-logs` (off `origin/main`).

This document is the design target the code in this branch is built against.
Status: implemented through commit 7 (Part A) + commit 6 (Part B).
LLM body logging (Part B) was originally documented separately here; below
reflects what actually shipped.

## 1. Why we are doing this

Today every user-side event (`user.message`, `user.tool_confirmation`,
`user.custom_tool_result`) is appended directly to the same `events` table
that holds agent output. `seq` is assigned at click-send time. If the user
sends a message while the agent is mid-stream, that message lands at
`seq=N` *inside* the prior turn:

```
seq  type
 47  user.message     "first prompt"
 48  agent.message    "answer 1, part a"
 49  user.message     "second prompt"   <-- arrived during turn 1
 50  agent.message    "answer 1, part b"
 51  agent.message    "answer 2, part a"
```

A `SELECT * ORDER BY seq` then renders the second user bubble *between*
the two halves of answer 1. Commit `7d40027` patched this on the client
by re-sorting on `processed_at`, but `processed_at` is only stamped
server-side at drain time and SSE never re-broadcasts the row, so live
sessions stay stuck on "Pending..." until a hard reload. More
critically, the LLM-replay path (`eventsToMessages` walks `getEvents()`
which is `ORDER BY seq`) builds messages in arrival order, so the model
sees `[user "first", assistant "answer 1 part a", user "second",
assistant "answer 1 part b", ...]` on the next turn — silent prompt-cache
drift + corrupted reasoning.

The Anthropic AMA spec separates these two tables explicitly:

> Message queuing — User events are queued server-side and processed in
> order. (managed-agents-events.md)
> All received events carry id, type, and processed_at (ISO 8601; null
> if not yet processed by the agent). interrupt jumps the queue and
> forces idle.

So the architecture is:

- A **pending queue** receives `events.send()`.
- The **event log** only contains *processed* events. `seq` is assigned
  at dequeue time, so `seq` order == drain order, monotonic with what
  the model actually saw.
- `events.list()` returns the event log; the pending queue is observable
  via a separate endpoint.
- `interrupt` is a special endpoint that drains the queue and halts the
  agent; queued items become visible (and stay) in the queue with
  `cancelled_at`, NOT in the event log.

We migrate the OMA implementation to that shape.

## 2. Schema

```sql
-- events: only contains *processed* events. seq is assigned at INSERT
-- time and is now monotonic with respect to what the model has actually
-- seen (drain INSERTs in promotion order).
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  processed_at INTEGER,
  cancelled_at INTEGER,
  session_thread_id TEXT
);
CREATE INDEX idx_events_type ON events(type, seq);
-- Expression index on data.id powers drain dedup (commit 2).
CREATE INDEX idx_events_event_id ON events(json_extract(data, '$.id'));

-- pending_events: AMA-spec pending queue. user.message /
-- user.tool_confirmation / user.custom_tool_result events live here
-- between events.send() and drainEventQueue picking them up.
-- Promoted (INSERT into events, then DELETE here) in drain order.
CREATE TABLE pending_events (
  pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at INTEGER NOT NULL,
  session_thread_id TEXT NOT NULL,
  type TEXT NOT NULL,         -- only the three turn-input types
  event_id TEXT NOT NULL,     -- mirrors data.id, lets the client correlate pending->events row
  cancelled_at INTEGER,       -- set by user.interrupt
  data TEXT NOT NULL          -- full event JSON
);
CREATE INDEX idx_pending_thread_seq
  ON pending_events(session_thread_id, pending_seq);
CREATE INDEX idx_pending_active
  ON pending_events(session_thread_id, pending_seq)
  WHERE cancelled_at IS NULL;
```

The legacy partial pending-index on `events`
(`idx_events_pending` from `a316dc3`) stays defined for backward
compatibility on existing DOs (it reads zero rows once new code stops
producing pending rows in `events`).

`user.interrupt`, `user.define_outcome` keep going to `events` directly —
they are control events, not turn inputs.

### Migration story

Schema bootstrap is purely additive (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` guarded by
`PRAGMA table_info` check). No backfill or data migration runs.

For an existing session at deploy time:

- Old `events` rows with `processed_at IS NULL` (pre-fix sessions)
  stay in `events` forever.
- The drain loop has a one-shot legacy backfill block that promotes
  any stuck pending rows (UPDATE processed_at + broadcast
  `system.user_message_promoted`) on the first drain after deploy.
  The harness does NOT auto-run them — sessions active at deploy
  boundary lose their in-flight queue state. Acceptable for the
  small window. A `TODO(dual-table-followup)` marks the block for
  removal after a soak window.

## 3. Where the queue routing lives

**Adapters are primitive**: `CfDoEventLog.append` and
`InMemoryEventLog.append` always write a row to the canonical events
log with `processed_at` stamped now. They DO NOT decide queue vs log
based on event type — that decision moved to the call site.

**SessionDO POST `/event` handles routing**:
- `user.message` / `user.tool_confirmation` / `user.custom_tool_result`
  → `pending.enqueue(event)` + broadcast `system.user_message_pending`
- `user.interrupt` → `pending.cancelAllForThread(...)` (broadcasts
  `system.user_message_cancelled` per row) + `events.append(event)` +
  optional `session.status_idle`
- `user.define_outcome` → `events.append(event)` (control event)

The same routing applies to internal injectors (wakeup callback,
background-task notifications): they call `pending.enqueue` so the
harness sees them via the same drain path as real user input.

## 4. Drain semantics — peek-then-append-then-delete with dedup

```
loop:
  row = pending.peek(threadId)            -- SELECT, no DELETE
  if !row: break

  parse(row.data) -> event
  event.processed_at = nowIso             -- AMA spec: ingestion time
  eventId = event.id

  if eventId is in events.json_extract(data, '$.id'):
    -- A previous drain already INSERTed this event but crashed before
    -- the DELETE. Skip the re-INSERT; deleting the stale pending row
    -- is enough.
    promotedSeq = (existing row's seq)
  else:
    history.append(event)                 -- INSERT into events, AUTOINCREMENT seq
    promotedSeq = (just-inserted seq)

  pending.delete(row.pending_seq)         -- only after INSERT succeeds

  broadcast(event)                        -- canonical user.* with processed_at filled
  broadcast(system.user_message_promoted{
    event_id, pending_seq, seq: promotedSeq, processed_at, session_thread_id
  })

  runAgentTurn(...)                       -- harness writes agent.* events into events
```

Crash-safety:
- Crash between INSERT and DELETE → next drain peeks the same row,
  dedup hits via `idx_events_event_id`, skips re-INSERT, just
  deletes the stale pending row. No duplicate harness invocation.
- Crash before INSERT → next drain re-peeks, runs the whole
  promote-and-turn cycle. Idempotent.
- Crash between DELETE and `runAgentTurn`'s first agent event → the
  events row exists with processed_at set, no agent reply. Identical
  to today's behavior for the same case (`_finalizeStaleTurns`
  cleanup).

The `_draining` per-thread mutex stays exactly as today; cross-thread
drains run in parallel.

## 5. SSE / broadcast protocol changes

### New on-the-wire frames (typed in `packages/api-types`)

- `SystemUserMessagePendingEvent` — broadcast at enqueue
  ```json
  {
    "type": "system.user_message_pending",
    "event_id": "sevt_abc",
    "pending_seq": 7,
    "enqueued_at": 1715000000000,
    "session_thread_id": "sthr_primary",
    "event": { "type": "user.message", "id": "sevt_abc", "content": [...] }
  }
  ```

- `SystemUserMessagePromotedEvent` — broadcast at drain after INSERT
  ```json
  {
    "type": "system.user_message_promoted",
    "event_id": "sevt_abc",
    "pending_seq": 7,
    "seq": 42,
    "processed_at": "2026-05-14T...",
    "session_thread_id": "sthr_primary"
  }
  ```

- `SystemUserMessageCancelledEvent` — broadcast at user.interrupt
  per cancelled pending row.
  ```json
  {
    "type": "system.user_message_cancelled",
    "event_id": "sevt_abc",
    "pending_seq": 7,
    "session_thread_id": "sthr_primary",
    "cancelled_at": 1715000000123
  }
  ```

After promotion, the SessionDO ALSO broadcasts the canonical
`user.message` event frame (now with `processed_at` filled in). The
client uses `event_id` / `pending_seq` to swap the pending bubble for
the event-log bubble. This means:

- Existing clients (older SDK) that don't know about the new `system.*`
  frames just keep working: they receive the canonical user.message
  frame at promotion time (just like today) plus extra harmless
  `system.*` frames they ignore.
- New clients (this branch's console) listen for the `system.*` frames
  to render the outbox + know exactly when to drop the pending bubble.

### WS replay on connect

GET `/ws` first replays the events table, then emits a
`system.user_message_pending` frame for each active row in
`pending_events` so a fresh client sees the outbox state without an
extra GET `/pending`.

## 6. New REST endpoint

`GET /v1/sessions/:id/pending?session_thread_id=…&include_cancelled=…`

```json
{
  "data": [
    {
      "pending_seq": 7,
      "enqueued_at": 1715000000000,
      "type": "user.message",
      "event_id": "sevt_abc",
      "session_thread_id": "sthr_primary",
      "cancelled_at": null,
      "data": { "type": "user.message", "id": "sevt_abc", "content": [...] }
    }
  ]
}
```

Filtered by `session_thread_id` (default `sthr_primary`). Ordered by
`pending_seq ASC`. Cancelled rows are omitted by default; pass
`?include_cancelled=true` to include them. Forwarded by
`apps/main/src/routes/sessions.ts` -> SessionDO `/sessions/:id/pending`
exactly like the existing `/events` endpoint.

## 7. Sub-agent paths

Sub-agents (`runSubAgent` in session-do.ts) use `InMemoryHistory`
which composes `InMemoryEventLog`. After commit 1's refactor, that
adapter is also a primitive — `append` always pushes to `_rows` so
`getEvents` / `getMessages` see every appended event immediately.
Sub-agents don't use a queue (they run synchronously); the
`InMemoryPendingQueue` is parallel to `InMemoryEventLog` (not embedded)
so accidental crosswiring is structurally impossible.

The sub-agent path is unchanged from origin/main behavior in this
respect.

## 8. Console (apps/console)

`SessionDetail.tsx` retired the 7d40027 client-side sort (server-side
ordering via events.seq is now correct) and the `nonUserSeen[]`
heuristic for "is this still pending" (server tells us via
system.user_message_pending). The new state slice
`pendingByEventId: Map<event_id, PendingEntry>` is:
- Seeded on initial load from GET `/v1/sessions/:id/pending`.
- Updated by `system.user_message_pending` (add) /
  `_promoted` / `_cancelled` (remove) SSE frames.
- Defensive-cleared on `session.error` and `user.interrupt`.

Pending entries render as a separate "outbox" section at the bottom
of the timeline, never mixed inline.

## 9. LLM full request/response logging (Part B)

### Hook point

AI SDK `wrapLanguageModel` + `LanguageModelMiddleware`.
`apps/agent/src/harness/llm-logging-middleware.ts` exports
`llmLoggingMiddleware(ctx)` returning an object with `wrapStream` +
`wrapGenerate`. Default-loop wraps the model right before the
`streamText` call:

```ts
const wrappedModel = ctx.env.llmLog
  ? wrapLanguageModel({ model, middleware: llmLoggingMiddleware({...}) })
  : model;
```

`wrapStream` tees the stream via a TransformStream so the harness
still gets every chunk live; we accumulate a copy of stream parts
(typed JSON objects, not raw bytes) and PUT to R2 on flush.
`wrapGenerate` does the analogous thing for non-streaming calls
(unused today by default-loop but available).

### Storage

- Bucket: reuse `FILES_BUCKET` (same R2 binding the event-log spill
  path uses). No new bucket binding.
- Key: `t/{tenant}/sessions/{session_id}/llm/{event_id}.json` via
  `llmLogKey(tenant, session, event_id)` — single source of truth.
- Body schema:
  ```json
  {
    "event_id": "sevt_…",
    "model": "claude-sonnet-4-6",
    "started_at": "2026-05-14T...",
    "ended_at": "2026-05-14T...",
    "latency_ms": 5678,
    "request": {
      "params": { "...": "redacted-headers + full request params" },
      "provider_request": { "body": "..." }
    },
    "response": {
      "stream_parts": [ ...full set of stream parts... ],
      "response_meta": { "headers": {...} }
    }
  }
  ```

### Wiring

`HarnessContext.env.llmLog` carries `{ tenant_id, session_id, r2 }`.
SessionDO populates this for both primary and sub-agent harness
invocations from `FILES_BUCKET`. The `spanIdResolver` closure in
default-loop reads the per-step `stepStartId` (minted in
`experimental_onStepStart` BEFORE the provider doStream call), so
the middleware always sees the right id at `wrapStream` time.

The matching `span.model_request_end` events grow a `body_r2_key`
field pointing to the R2 object so consumers don't have to know the
key layout.

### Read endpoint

`GET /v1/sessions/:id/llm-calls/:event_id` in
`apps/main/src/routes/sessions.ts`:
- Auth: same tenant scoping as `/events`
- Key prefix is tenant-scoped so a tenant can't read another
  tenant's logs even via id-guess
- Returns 404 with the attempted key when the object is absent
  (LLM logging disabled at write time, retention purge, etc.)

### Redaction

- Headers: drop `Authorization`, `x-api-key`, `anthropic-api-key`,
  `openai-api-key`, `x-anthropic-api-key`. Other headers pass
  through.
- Request body: not redacted. The whole point is operators can see
  exactly what the model saw, including tool inputs that may carry
  user PII. Storage is private R2 keyed under the tenant prefix —
  RBAC is identical to the rest of session data.

### Opt-out

- Per-env: `env.LLM_LOGS_DISABLED === "1"` skips the wrap + drops
  `body_r2_key` from span events.
- Per-tenant: `TODO(llm-logging-followup): add a flag in tenant
  config + check it in SessionDO before constructing llmLog`.

### Failure mode

Any R2 / serialization error inside the middleware is logged to
console and swallowed. The model call's success path is independent
of LLM logging — a dead R2 must not break the agent. Errors during
the provider call itself ARE captured (we PUT a body containing
`{ error, error_class }`) so post-mortems aren't blocked by the
fact that the call failed.

## 10. Manual test plan

### Part A — pending queue + drain ordering

1. Create a session, send a long-running user.message ("count to 100
   one number per line"). While the agent streams, send a second
   user.message ("ignore that, say HI").
2. While agent is mid-stream:
   - `GET /v1/sessions/:id/pending` returns one row (`HI`).
   - `GET /v1/sessions/:id/events` does NOT contain `HI`.
   - Console shows the `HI` bubble in the bottom outbox.
3. After turn 1 ends and turn 2 starts:
   - `GET /v1/sessions/:id/pending` returns empty.
   - `GET /v1/sessions/:id/events` ordered by `seq` shows
     `user.message(count) -> agent.message(...) -> user.message(HI) -> agent.message(HI back)`.
   - Console shows the `HI` bubble inline in the timeline (not outbox).
   - `system.user_message_promoted` was broadcast.
4. Send `user.interrupt` while a third pending message is queued:
   - The pending row gets `cancelled_at`.
   - `GET /v1/sessions/:id/pending?include_cancelled=true` shows it
     with cancelled_at filled.
   - Console outbox empties.

### Part B — LLM logging

5. After any agent turn completes, take an `event_id` from a
   `span.model_request_end` event and fetch
   `GET /v1/sessions/:id/llm-calls/:event_id`. Response is the full
   request/response JSON, with API keys redacted in the request
   headers.
6. Set `LLM_LOGS_DISABLED=1` in dev vars. Run a turn. R2 PUTs do not
   fire. The `body_r2_key` field is absent on `span.model_request_end`.

## 11. Outstanding TODOs / risks

- **`recoverInterruptedState` + sub-agents.** Documented unchanged
  from origin/main. Sub-agents run synchronously inside the parent
  turn so they don't need their own queue recovery.

- **Schedule-tool wakeups + background-task notifications inject
  synthetic `user.message` events**. Routed through `pending.enqueue`
  + the same drain path as real user input so the harness logic
  stays uniform. The wakeup bubble briefly appears in the outbox
  before being promoted — same UX as a typed message.

- **Legacy backfill in drain.** A one-shot UPDATE block at the start
  of `drainEventQueue` promotes any pre-deploy `processed_at IS NULL`
  rows in `events` (broadcasts `_promoted` so the UI refreshes).
  Marked `TODO(dual-table-followup): remove after soak window`.

- **LLM logging can balloon R2 cost** on a high-volume tenant. No
  metering today; the `LLM_LOGS_DISABLED` env switch is the kill.
  Future work: per-tenant flag in tenant-config + a sampling rate.

- **Stream-part capture** holds the entire response in memory for the
  R2 PUT. For very long responses this could OOM the DO. Mitigation
  TODO: cap at e.g. 2MB and elide the rest with `_truncated: true`
  in the persisted body.

- **Aux model calls (web_fetch summarization).** The aux model is
  resolved + invoked through the same `resolveModel` path as the
  primary, but those calls don't go through default-loop so they
  do not get the middleware. If aux calls need full-body logging,
  wire `llmLoggingMiddleware` at the aux call site too.
