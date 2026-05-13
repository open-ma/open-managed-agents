# Dual-table event log + full LLM-call logging

Branch: `feat/dual-table-and-llm-logs` (off `origin/main`).

This document is the design target the code in this branch is built against.
It is intentionally written before the code changes so the architectural
intent is reviewable in isolation.

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
sessions stay stuck on "Pending..." until a hard reload.

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

## 2. Schema diff

### Before

```sql
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  processed_at INTEGER,
  cancelled_at INTEGER,
  session_thread_id TEXT
);
CREATE INDEX idx_events_pending
  ON events(session_thread_id, seq)
  WHERE processed_at IS NULL AND cancelled_at IS NULL
    AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result');
```

`user.*` and agent events shared the same `seq` namespace; pending state
was encoded by `processed_at IS NULL` on the same row.

### After

```sql
-- events: only contains *processed* events. seq is assigned at append time
-- and is now monotonic with respect to what the model has actually seen.
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

-- pending_events: AMA-spec pending queue. user.* events live here
-- between events.send() and drainEventQueue picking them up. Promoted
-- (DELETE here, INSERT into events) in drain order.
CREATE TABLE pending_events (
  pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at INTEGER NOT NULL,
  session_thread_id TEXT NOT NULL,
  type TEXT NOT NULL,         -- only user.message / user.tool_confirmation / user.custom_tool_result
  event_id TEXT NOT NULL,     -- mirrors data.id, lets the client correlate pending->event-log row
  cancelled_at INTEGER,       -- set by user.interrupt
  data TEXT NOT NULL          -- full event JSON
);
CREATE INDEX idx_pending_thread_seq
  ON pending_events(session_thread_id, pending_seq);
CREATE INDEX idx_pending_active
  ON pending_events(session_thread_id, pending_seq)
  WHERE cancelled_at IS NULL;
```

The legacy partial pending-index on `events` is intentionally kept for
backward-compatibility on existing DOs (it reads as zero rows once the
new code path stops producing pending rows in `events`). New code never
inserts pending user.* into `events`; the `idx_events_pending` index
becomes a no-op zero-row index that drops out of query plans.

`user.interrupt`, `user.define_outcome` keep going to `events` directly —
they are control events, not turn inputs.

### Migration story

Schema bootstrap is purely additive (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`). No backfill or data migration runs.

For an existing session at deploy time:

- The `events` table may contain old user.* rows with `processed_at IS
  NULL` (pre-fix sessions). They stay in `events` forever.
- The legacy partial index `idx_events_pending` will still pick them up
  on the next drain after the deploy, so any genuinely pending rows at
  deploy time still get drained. We keep the legacy drain query as a
  one-shot pre-step in `drainEventQueue` for back-compat (see §3).
- The visual ordering of *those* old sessions in the console is
  unchanged (still wrong-by-seq). Acceptable: we are explicitly not
  back-filling. Fresh sessions get the correct ordering immediately.

Old SDK consumers that read `processed_at IS NULL` rows from `/events`
will see fewer such rows over time. None should be relying on this as a
queue surface — the real surface is the new `/v1/sessions/:id/pending`
endpoint.

## 3. Drain semantics (rewritten)

`drainEventQueue(threadId)` becomes:

```
loop:
  begin a sql transaction (DO storage SQL is auto-transactional but we
  do the SELECT + DELETE + INSERT in one synchronous block so a
  concurrent interrupt can't race us between SELECT and DELETE)

  row = SELECT pending_seq, data, type, event_id, enqueued_at
        FROM pending_events
        WHERE session_thread_id = ?  AND cancelled_at IS NULL
        ORDER BY pending_seq ASC LIMIT 1
  if no row: break

  parse(row.data) -> event
  event.processed_at = now (ISO)
  // Promote: insert into events with newly-assigned seq, then delete
  // from pending_events.
  INSERT INTO events (type, data, processed_at, session_thread_id, ts)
       VALUES (event.type, JSON.stringify(event), now_ms, threadId, now_secs)
  promotedSeq = last_insert_rowid()
  DELETE FROM pending_events WHERE pending_seq = row.pending_seq

  // Broadcast: tell every connected client that this pending row has
  // been promoted into the event log so they can drop the pending
  // bubble and render the new event-log row.
  broadcast({
    type: "system.user_message_promoted",
    pending_seq: row.pending_seq,
    event_id: event.id,            // === row.event_id
    seq: promotedSeq,
    session_thread_id: threadId,
  })
  broadcast(event)                  // the canonical user.message frame, now with processed_at filled
                                    // and an `_promoted: true` sidecar so the client knows it is the
                                    // "real" copy of a previously-pending message.

  hand the event to the harness (runAgentTurn -> processUserMessage / handleToolConfirmation / etc.)
  on harness error: write session.error, break
```

- The mutex on `_draining` per `threadId` stays exactly as today.
- `event.id` is stamped on `append()` if missing (same as today's
  `stampEvent`). The id flows through three places — pending row,
  promotion event, promoted event-log row — so the client can correlate.
- The legacy backfill: at the START of `drainEventQueue` we run the
  legacy pending-index query against the OLD `events` table once per
  invocation. If it returns a row, we treat it like a freshly-promoted
  event (UPDATE its `processed_at` + broadcast `system.user_message_promoted`)
  and continue. After all legacy rows are drained, the loop falls
  through to the new `pending_events`-based loop. This means existing
  sessions with stuck pending rows recover gracefully on the first
  drain after deploy without any manual migration.

## 4. SSE / broadcast protocol changes

### New on-the-wire frames

- `system.user_message_pending` — emitted when a user.* event is enqueued.
  Same `data` payload as the user.* event, carries `pending_seq` and
  `enqueued_at`. Client renders this in the bottom outbox region.

  ```json
  {
    "type": "system.user_message_pending",
    "pending_seq": 7,
    "enqueued_at": 1715000000000,
    "session_thread_id": "sthr_primary",
    "event": { "type": "user.message", "id": "sevt_abc", "content": [...] }
  }
  ```

- `system.user_message_promoted` — emitted when the pending row is
  consumed by drain and inserted into the event log.

  ```json
  {
    "type": "system.user_message_promoted",
    "pending_seq": 7,
    "event_id": "sevt_abc",
    "seq": 42,
    "session_thread_id": "sthr_primary"
  }
  ```

- `system.user_message_cancelled` — emitted when `user.interrupt`
  cancels a pending row.

  ```json
  {
    "type": "system.user_message_cancelled",
    "pending_seq": 7,
    "event_id": "sevt_abc",
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
- The pending broadcast at enqueue time is a NEW frame, so old clients
  don't see it. Their existing UX (where typing immediately shows the
  user bubble) is preserved by the new frontend code maintaining a
  client-side optimistic outbox of the just-typed text — same as today.

### Client compatibility risks

- The SDK in `packages/sdk/` doesn't filter on `system.*` event types
  today — it forwards every WS frame to the consumer. Consumers that
  iterate by `type` and switch on the known set will silently ignore
  the new frames. No breaking change.
- `apps/main/src/routes/sessions.ts` SSE bridge forwards every WS frame
  unmodified except for the `session_thread_id` filter. The new
  `system.*` frames carry `session_thread_id` so the filter still works.

## 5. New REST endpoint

- `GET /v1/sessions/:id/pending?session_thread_id=…`

  Response:
  ```json
  {
    "data": [
      { "pending_seq": 7, "enqueued_at": 1715000000000, "type": "user.message",
        "event_id": "sevt_abc", "session_thread_id": "sthr_primary",
        "cancelled_at": null,
        "data": { "type": "user.message", "id": "sevt_abc", "content": [...] } }
    ]
  }
  ```

  Filtered by `session_thread_id` (default `sthr_primary`). Ordered by
  `pending_seq ASC`. Cancelled rows are omitted by default; pass
  `?include_cancelled=true` to include them.

  Forwarded by `apps/main/src/routes/sessions.ts` -> SessionDO
  `/sessions/:id/pending` exactly like the existing `/events` endpoint.

## 6. LLM request/response logging (Part B)

### Storage layout

- Bucket: reuse `FILES_BUCKET` (same R2 binding the event-log spill
  path uses). Avoids a new bucket binding per env.
- Key: `t/{tenant}/sessions/{session_id}/llm/{event_id}.json`
- Body schema:

  ```json
  {
    "event_id": "sevt_…",
    "model": "claude-sonnet-4-6",
    "started_at": 1715000000000,
    "ended_at": 1715000005678,
    "latency_ms": 5678,
    "request": {
      "method": "POST",
      "url": "https://api.anthropic.com/v1/messages",
      "headers": { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      "body": "<full request JSON, not truncated>"
    },
    "response": {
      "status": 200,
      "headers": { "content-type": "text/event-stream" },
      "body": "<full response body — for SSE responses, the assembled stream of bytes>"
    },
    "request_bytes": 12345,
    "response_bytes": 67890
  }
  ```

### Hook point

`observingFetch` in `apps/agent/src/harness/provider.ts` is the seam.
We extend it to:

1. Capture request body before `fetch()`.
2. For non-streaming responses, `res.clone().text()` after `fetch()`.
3. For streaming responses (`Content-Type: text/event-stream`), wrap
   `res.body` in a `TransformStream` that copies bytes to a buffer
   while passing them through to the consumer. When the stream
   completes (or errors), flush to R2.
4. Redact `Authorization`, `x-api-key`, `anthropic-api-key` headers
   before persisting.

### Wiring

`observingFetch` today is a free function, with no access to
SessionDO/tenant id. We extend it to take an optional
`{ logBucket, logKey, eventId }` capture context, threaded through
`resolveModel` -> `createAnthropic({ fetch })` via a closure built per
call. To get the right `event_id`, we need to know the
`span.model_request_start_id` *before* the model call fires. The
existing `experimental_onStepStart` hook in `default-loop.ts` mints
this id; we lift it out so it is generated *before* the streamText
call and passed into both the span event AND the fetch closure.

Concretely:

- `default-loop.ts` constructs a `LlmCallLogger` with
  `{ tenant, session_id, files_bucket }` per-step and threads it into
  the per-step fetch closure.
- The fetch closure tags each call with the step's `eventId`.
- On flush, we PUT `t/{tenant}/sessions/{session_id}/llm/{event_id}.json`
  to R2, fire-and-forget.
- The matching `span.model_request_end` event grows a
  `body_r2_key` field pointing to the R2 object.

### Read endpoint

- `GET /v1/sessions/:id/llm-calls/:event_id` -> R2 fetch -> JSON
  pass-through. Tenant-scoped via the same auth as `/v1/sessions/:id`.
  Forwarded by `apps/main` to SessionDO at
  `/sessions/:id/llm-calls/:event_id`.

### Opt-out

Two knobs (default ON):

- Per-tenant: not yet wired; would be a `tenants` row column. TODO.
- Per-env: `env.LLM_LOGS_DISABLED === "1"` skips the capture entirely.
  The fetch closure becomes a passthrough to the previous behavior.

### Redaction

- HTTP headers: drop `Authorization`, `x-api-key`, `anthropic-api-key`,
  `openai-api-key`, `x-anthropic-api-key`. Other headers pass through
  verbatim.
- Request body: not redacted. The whole point of this feature is that
  ops can see exactly what the model saw, including tool inputs that
  may carry user PII. Storage is private R2 keyed under the tenant
  prefix, so RBAC is identical to the rest of the session data.

## 7. Manual test plan

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
   - Console shows the `HI` bubble inline in the timeline (NOT outbox).
   - `system.user_message_promoted` was broadcast.
4. Send `user.interrupt` while a third pending message is queued:
   - The pending row gets `cancelled_at`.
   - `GET /v1/sessions/:id/pending?include_cancelled=true` shows it
     with cancelled_at filled.
   - Console shows the bubble struck-through in the outbox.

### Part A — backward compat

5. Open an existing prod-style session that has a stuck `processed_at
   IS NULL` row in the legacy `events` table. The first drain after
   deploy promotes the legacy row (UPDATE in place, broadcast
   `system.user_message_promoted`) and the loop continues into
   `pending_events`.

### Part B — LLM logging

6. After any agent turn completes, take an `event_id` from a
   `span.model_request_end` event and fetch
   `GET /v1/sessions/:id/llm-calls/:event_id`. Response is the full
   request/response JSON, with API keys redacted in the request
   headers.
7. Set `LLM_LOGS_DISABLED=1` in dev vars. Run a turn. R2 PUTs do not
   fire. The `body_r2_key` field is absent on `span.model_request_end`.

## 8. Outstanding TODOs / risks

- **Sub-agent threads use `InMemoryHistory` (not `SqliteHistory`).** The
  sub-agent path doesn't go through DO SQL, so the pending-queue
  refactor doesn't strictly apply. Sub-agent `user.message`-like
  events are produced internally by the orchestrator and never come
  through `events.send()`, so this is fine as-is. Documented here to
  flag that anyone wiring sub-agent user input would need to extend
  `InMemoryEventLog` similarly.

- **Recovery replay.** `recoverInterruptedState` doesn't read from
  `pending_events`. If the DO dies while drain is mid-cycle (between
  `INSERT INTO events` and `DELETE FROM pending_events`), we'd
  duplicate-promote on next drain. Mitigation: do the SELECT + INSERT
  + DELETE as a single SQL operation in DO storage, which is
  transactional within the storage namespace. Worst case a duplicate
  agent.message event lands; today the same risk exists for any
  mid-turn DO crash so we don't strictly worsen anything.

- **Schedule-tool wakeups inject a synthetic `user.message` directly
  into `history.append()`.** That now means they go to
  `pending_events` and get drain-promoted. Acceptable — the wakeup
  bubble in the console will briefly appear in the outbox before
  being promoted. Alternative: route wakeups directly to `events`.
  Decided against: wakeups SHOULD go through the same drain path as
  real user input so the harness logic stays uniform.

- **`getLastEventSeq("user.message")`** is used by `recoverEventQueue`
  to compute "is the last user.message a real user input?". After this
  refactor, the answer is always-yes for promoted rows, but pending
  rows aren't reflected. This is fine because `recoverEventQueue` is
  itself a re-trigger of drain, which now reads from `pending_events`
  directly.

- **LLM logging can balloon R2 cost** on a high-volume tenant. No
  metering today; the `LLM_LOGS_DISABLED` env switch is the kill.
  Future work: per-tenant flag in D1 + a sampling rate.

- **Streaming response capture** uses a `TransformStream` between the
  fetch result and the AI SDK consumer. This is a known pattern but
  doubles bandwidth (we hold full response bytes in memory for the
  R2 PUT). For very long responses (>5MB), this could OOM the DO.
  Mitigation: cap at e.g. 2MB and elide the rest; flag with
  `_truncated: true` in the persisted body.

- **The legacy `idx_events_pending` partial index** stays defined but
  matches zero rows under the new code. Cost is negligible (DO SQLite
  partial indexes only consume space when matching rows exist).
