# Code structure audit — May 2026

Scope: large files in `apps/agent/src/runtime/` and `apps/main/src/routes/`
that have grown past the size at which they're hard to navigate or extend.
This is a survey + recommendation, not a refactor — actual splits should
be PRs after team review.

## Top offenders by file size

| LOC | File | Notes |
|---|---|---|
| 3984 | `apps/agent/src/runtime/session-do.ts` | The Durable Object class. 37 methods. Several mega-methods (see below). Biggest immediate value. |
| 1790 | `apps/main/src/routes/sessions.ts` | All `/v1/sessions/*` routes in one file. Some natural sub-files exist (events, files, exec, debug). |
| 1233 | `apps/agent/src/harness/tools.ts` | `buildTools()` + every tool definition + MCP wiring. |
| 915 | `apps/agent/src/harness/default-loop.ts` | Recently improved (Phase 3 unified-runtime); main loop + projection logic still co-located. |
| 859 | `apps/main/src/routes/skills.ts` | Skill upload + zip + persist. Self-contained — fine. |
| 839 | `apps/main/src/eval-runner.ts` | Eval scheduler. Has natural phases (advance trial / persist trajectory / score). |
| 788 | `apps/main/src/routes/integrations.ts` | OAuth + webhook handlers. Already split per-provider in `apps/integrations/`. Skim — probably ok. |
| 591 | `apps/main/src/routes/internal.ts` | Mixed bag — splittable. |

## Top offenders by method size (within `session-do.ts`)

| LOC | Method | Why it's big | Extract to |
|---|---|---|---|
| **864** | `pollBackgroundTasks()` | Background tool watchdog: list rows, classify alive/dead, broadcast updates, GC stale rows, container keepalive. 4 distinct phases inlined. | `runtime/background-tasks.ts` — the polling state machine has nothing to do with DO lifecycle. |
| **651** | `fetch(request)` | HTTP router. Giant `if (path === "/foo")` chain — every internal endpoint inlined. | Move per-endpoint handlers to a route table or sub-files (`routes/init.ts`, `routes/events.ts`, `routes/destroy.ts`, …). The DO becomes a thin dispatcher. |
| **362** | `warmUpSandbox()` | Sandbox boot + mount memory stores + restore workspace backup + propagate outbound context + container keepalive primer. | `runtime/sandbox-warmup.ts`. The DO holds the sandbox; warmup is an orchestration concern. |
| **292** | `fanOutToHooks()` | Event → external hook bridge (Linear / Slack / GitHub). Per-hook conditional branches. | `runtime/event-hooks.ts` with one function per integration. Already partially in `apps/integrations/`. |
| 160 | `alarm()` | Schedule dispatch + `_checkOrphanTurns` + container keepalive + cron rearm. | Already lean for what it does. Sub-handlers (schedule dispatch) could be extracted but lower value. |
| 157 | `_ensureCfAgentsSchema()` | DDL for the DO storage tables. | Move to `runtime/do-schema.ts` (a pure SQL string + bootstrap fn). |
| 135 | `getEventsBetween()` | Query + recovery-aware filtering. Pure logic. | Already extractable; small win. |

## Concrete refactor candidates (ordered by value-to-risk ratio)

### 1. Extract `pollBackgroundTasks` (HIGH value, LOW risk)

864 lines that don't touch DO state directly — all SQL via `ctx.storage.sql`,
no in-memory invariants beyond the DO instance pointer. Move to:

```
apps/agent/src/runtime/background-tasks.ts
  export class BackgroundTaskPoller {
    constructor(deps: { sql, broadcast, getOrCreateSandbox })
    async pollOnce(): Promise<void> { /* what's now inline */ }
  }
```

`SessionDO.alarm()` → `await this.bgPoller.pollOnce()`. Saves 864 LOC from
the DO file with no behavior change.

### 2. Route-table-ify `fetch()` (HIGH value, MEDIUM risk)

The DO's `fetch` is a Hono-app shape but written as raw if-else. Refactor:

```ts
// runtime/do-routes.ts
const routes: Record<string, RouteHandler> = {
  "POST /init": handleInit,
  "POST /event": handleEvent,
  "POST /destroy": handleDestroy,
  "GET /events/stream": handleSseStream,
  // ...
};
```

Or just adopt Hono inside the DO (apps/agent already imports it). Cuts the
fetch method from 651 → ~50 LOC. Risk: streaming endpoints have specific
flush semantics that need careful porting.

### 3. Hooks fan-out → `runtime/event-hooks.ts` (MEDIUM value, LOW risk)

`fanOutToHooks(event)` has 4 branches — Linear, Slack, GitHub, generic —
each independent. Make each a registered handler:

```ts
const hooks: Array<{ matches: (e) => boolean; handle: (e) => Promise<void> }> = [...];
for (const h of hooks) if (h.matches(event)) await h.handle(event);
```

### 4. Split `apps/main/src/routes/sessions.ts` (MEDIUM value, LOW risk)

1790 LOC for one route family. Natural splits:
- `sessions/crud.ts` — POST/GET/PUT/DELETE
- `sessions/events.ts` — POST events, GET events stream, JSON events
- `sessions/files.ts` — file upload/download (currently 100+ LOC)
- `sessions/exec.ts` — debug/recovery probes

### 5. `default-loop.ts` `buildMessages` extraction (LOW value)

Already cleaner after Phase 3. The cache-control logic + tool emission are
slightly intertwined; could pull `applyAnthropicCacheControl` and the SSE
processing into helpers. Not urgent.

## What to leave alone

- `apps/main/src/routes/skills.ts` (859) — self-contained, zip handling is
  inherently hairy; further split adds nav cost without functional win.
- `apps/agent/src/harness/tools.ts` (1233) — every tool is logically
  independent; already easy to scan because each tool has a clear section.
  Splitting risks breaking the "one place to see all tool inputs" trick.
- `apps/main/src/eval-runner.ts` (839) — the scheduler logic IS one big
  state machine, splitting hides the flow.

## Quick wins not requiring refactor

These are 1-line / 1-file edits that improve nav without moving code:

- Section-header comments (`// ── Section: foo ──────`) inside the
  900-line methods so editor outline view groups them. Already done for
  some files; expand to `pollBackgroundTasks` and `fetch`.
- Region folding markers (`//#region foo` / `//#endregion`) — VS Code +
  several editors fold these natively.
- `@deprecated` JSDoc on the `cf_agents_*` legacy methods that survived
  Phase 4 (cf_agents_state, cf_agents_schedules) so IntelliSense flags
  them.

## Recovery + DIP work already landed (this branch)

For context — the unified-runtime refactor (Phases 1-5) already extracted
~3000 lines worth of fiber/runFiber/keepAliveWhile from session-do.ts into
`packages/session-runtime/`. The numbers above are AFTER that. The pieces
that remain are CF-specific concerns (DO storage, SessionDO RPC, sandbox
container lifecycle) — they wouldn't easily move into the platform-neutral
`session-runtime` package.

## Recommendation

If the team picks one item, **#1 (extract `pollBackgroundTasks`)** is the
best ratio: 864 LOC out of the DO file, no behavior change, no public
API change. ~1 hour with tests staying green.

If picking two, **#1 + #4 (split sessions.ts)** — the 1790-LOC route
file is a daily friction point for anyone touching session routes.

Past that, the splits start trading nav cost for code complexity (more
files to jump between for one feature). Prefer leaving as-is unless a
specific feature needs surgery in that file.
