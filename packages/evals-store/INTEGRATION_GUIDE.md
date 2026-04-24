# INTEGRATION_GUIDE.md — `@open-managed-agents/evals-store`

OPE-9: KV → D1 migration of `eval_runs`. This guide lists every change the
integration step needs to wire the new service into the codebase. Execute
these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package was already added to `apps/main/package.json`
  workspace deps in this branch). `apps/agent` does not consume this package
  — eval data is exclusively read/written by `apps/main`.
- Migration file picked: **`0012_eval_runs_table.sql`**.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside existing `MemoryStoreService` /
`CredentialService` / `SessionService`):

```ts
import {
  EvalRunService,
  createCfEvalRunService,
} from "@open-managed-agents/evals-store";
```

Add to the `Services` interface:

```ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  sessions: SessionService;
  evals: EvalRunService;          // ← add
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    sessions: createCfSessionService(env),
    evals: createCfEvalRunService(env),     // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/evals-store/test-fakes": "./packages/evals-store/src/test-fakes.ts",
"@open-managed-agents/evals-store": "./packages/evals-store/src/index.ts",
```

After this lands, the test file imports can be swapped from relative
(`../../packages/evals-store/src/...`) to package-name imports for
consistency with the credentials-store test (optional cleanup — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after the most recent migration import (currently
`cred0009`, possibly `sess0010` after the sessions-store integration lands):

```ts
// @ts-expect-error
import eval0012 from "../apps/main/migrations/0012_eval_runs_table.sql?raw";
```

Append `eval0012 as string,` to the `MIGRATIONS_RAW` array:

```ts
const MIGRATIONS_RAW: string[] = [
  auth0001 as string,
  int0002 as string,
  pub0003 as string,
  inst0004 as string,
  drop0005 as string,
  gh0006 as string,
  mem0007 as string,
  cred0009 as string,
  // sess0010 (added by sessions-store integration)
  // 0011 reserved for parallel store work
  eval0012 as string,            // ← add
];
```

(0011 may be claimed by another in-flight store — coordinate before
re-numbering. The store works with whatever migration number lands as long
as the `?raw` import + array entry stay aligned.)

---

## 4. Route + cron switches — every site that touches `evalrun:` or `evalrun_active:` KV

Each row gives: file path + approximate line range + the **before** pattern
to match + the **after** replacement. All HTTP routes use
`c.var.services.evals.<method>`. The cron entry point and any worker-scope
caller uses `buildCfServices(env).evals.<method>` (or pre-builds the
container once at module scope).

### 4a. `apps/main/src/routes/evals.ts`

#### POST /runs (create) — lines 64-121

Replace the two-put non-atomic KV pattern (lines 114-118) with a single
service call. The route still builds the initial `tasks[]` blob — that
stays as the opaque `results` field on the row.

```ts
// (Keep the agent_id / environment_id existence checks at lines 85-90 —
//  the service does not validate FK targets.)

// (Keep the route-layer task validation — the service treats `results` as
//  opaque JSON, so the per-task non-empty messages check stays here.)

const initialResults = {
  task_count: body.tasks.length,
  completed_count: 0,
  failed_count: 0,
  tasks: body.tasks.map((spec) => {
    const trialCount = Math.max(1, spec.trials || 1);
    const trials = Array.from({ length: trialCount }, (_, i) => ({
      trial_index: i,
      status: "pending" as const,
    }));
    return { id: spec.id, spec, status: "pending", trials, trial_total: trialCount };
  }),
};

const run = await c.var.services.evals.create({
  tenantId: t,
  agentId: body.agent_id,
  environmentId: body.environment_id,
  results: initialResults,
  // status defaults to "pending" — matches existing route behavior. Pass
  // status: "running" if you want to skip the pending phase entirely (the
  // cron tick will still pick it up via listActive).
});

return c.json({ run_id: run.id, task_count: body.tasks.length });
```

Drop the imports `kvKey`, `kvPrefix`, `kvListAll` from this file IF they're
only used for the `evalrun` keys (they likely are — verify with grep).

#### GET /runs/:id — lines 124-129

```ts
app.get("/runs/:id", async (c) => {
  const t = c.get("tenant_id");
  const run = await c.var.services.evals.get({
    tenantId: t,
    runId: c.req.param("id"),
  });
  if (!run) return c.json({ error: "Run not found" }, 404);
  // The route's existing response shape was the entire EvalRunRecord. To
  // keep API back-compat, flatten the row + results blob:
  return c.json({
    id: run.id,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    status: run.status,
    created_at: run.started_at,        // back-compat: started_at IS the create time
    started_at: run.started_at,
    ended_at: run.completed_at ?? undefined,
    error: run.error ?? undefined,
    ...(run.results as Record<string, unknown>),  // task_count / tasks / counts
  });
});
```

If you'd rather not preserve the flattened shape, return `run` directly and
note the API change in the migration PR description. The console / CLI may
need updates either way.

#### GET /runs (list) — lines 132-151

Replace the kvListAll + JSON.parse loop entirely:

```ts
app.get("/runs", async (c) => {
  const t = c.get("tenant_id");
  const limitParam = c.req.query("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const runs = await c.var.services.evals.list({
    tenantId: t,
    limit,
    // Optionally surface ?agent_id= / ?environment_id= / ?status= filters —
    // all are indexed.
    agentId: c.req.query("agent_id") || undefined,
    environmentId: c.req.query("environment_id") || undefined,
    status: c.req.query("status") as EvalRunStatus | undefined,
  });

  // Same back-compat flattening as GET /runs/:id (or return raw rows).
  return c.json({
    data: runs.map((run) => ({
      id: run.id,
      tenant_id: run.tenant_id,
      agent_id: run.agent_id,
      environment_id: run.environment_id,
      status: run.status,
      created_at: run.started_at,
      started_at: run.started_at,
      ended_at: run.completed_at ?? undefined,
      error: run.error ?? undefined,
      ...(run.results as Record<string, unknown>),
    })),
  });
});
```

`EvalRunStatus` import goes from `@open-managed-agents/evals-store`.

### 4b. `apps/main/src/eval-runner.ts`

The runner orchestrates the per-tick state machine. Today it does:
`loadRun → mutate run.tasks/run.status → saveRun (KV.put whole blob)`.
After migration the mutation pattern stays — only the storage flips.

#### `loadRun` helper — lines 67-70

```ts
// Old: env.CONFIG_KV.get(kvKey(tenantId, "evalrun", runId))
// New:
async function loadRun(env: Env, tenantId: string, runId: string): Promise<EvalRunRecord | null> {
  const services = buildCfServices(env);
  const row = await services.evals.get({ tenantId, runId });
  if (!row) return null;
  return rowToRecord(row);
}
```

Helper for shape-conversion (keep `EvalRunRecord` interface intact for the
rest of the file):

```ts
function rowToRecord(row: EvalRunRow): EvalRunRecord {
  const partial = (row.results ?? {}) as Partial<EvalRunRecord>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    environment_id: row.environment_id,
    status: row.status as EvalRunStatus,
    created_at: row.started_at,
    started_at: row.started_at,
    ended_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
  };
}
```

#### `saveRun` helper — lines 72-74

```ts
// Old: env.CONFIG_KV.put(kvKey(tenant, "evalrun", run.id), JSON.stringify(run))
// New: extract the per-tick mutable state into the results blob and call
//      service.update — terminal transitions go through markCompleted instead.
async function saveRun(env: Env, run: EvalRunRecord): Promise<void> {
  const services = buildCfServices(env);
  if (run.status === "completed" || run.status === "failed") {
    await services.evals.markCompleted({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error,
    });
  } else {
    await services.evals.update({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error ?? null,
    });
  }
}

function extractResults(run: EvalRunRecord): unknown {
  return {
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    tasks: run.tasks,
  };
}
```

#### `removeFromActive` helper — line 77

Delete entirely. The active list is now derived from the `status` column
via `listActive` (see `tickEvalRuns` below). The `evalrun_active:{runId}`
KV key writes/deletes go away.

```ts
// REMOVE the whole removeFromActive function.
```

Also remove the call sites — `advanceRun` (lines 279, 305-306, 335) calls
`removeFromActive` after terminal transitions. The status flip in
`markCompleted` is now self-sufficient: `listActive` will simply skip the
row on the next tick.

#### `tickEvalRuns` entry point — lines 314-339

```ts
export async function tickEvalRuns(env: Env): Promise<{ advanced: number; total: number }> {
  const services = buildCfServices(env);
  const activeRows = await services.evals.listActive();
  let advanced = 0;
  for (const row of activeRows) {
    const run = rowToRecord(row);
    try {
      await advanceRun(env, run);
      advanced++;
    } catch (err: unknown) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.ended_at = new Date().toISOString();
      await saveRun(env, run);   // saveRun handles terminal via markCompleted
    }
  }
  return { advanced, total: activeRows.length };
}
```

Drop the `kvListAll(env.CONFIG_KV, "evalrun_active:")` import path entirely.

#### Optional: cache services across ticks

Each `buildCfServices` call is cheap (object construction), but if you'd
like to cache once per worker isolate:

```ts
let cachedServices: Services | null = null;
function getServices(env: Env): Services {
  if (!cachedServices) cachedServices = buildCfServices(env);
  return cachedServices;
}
```

Use `getServices(env)` in place of inline `buildCfServices(env)`. Same
optimization recommended in the eval-runner section of the sessions-store
guide.

### 4c. `apps/main/src/routes/agents.ts` (DELETE /:id)

After (or alongside) the existing sessions-store `hasActiveByAgent` check,
add an evals safety check:

```ts
const [hasActiveSessions, hasActiveEvals] = await Promise.all([
  c.var.services.sessions.hasActiveByAgent({ tenantId: t, agentId: id }),
  c.var.services.evals.hasActiveByAgent({ tenantId: t, agentId: id }),
]);
if (hasActiveSessions || hasActiveEvals) {
  return c.json({
    error: "Cannot delete agent with active sessions or eval runs. Wait for them to finish or archive sessions first.",
  }, 409);
}
```

If you want to also cascade-delete completed/failed runs (mirrors the
sessions-store pattern for force-delete):

```ts
await c.var.services.evals.deleteByAgent({ tenantId: t, agentId: id });
```

### 4d. `apps/main/src/routes/environments.ts` (DELETE /:id)

Same pattern as 4c. The evals service exposes
`hasActiveByEnvironment({ tenantId, environmentId })` for the safety check.

### 4e. `test/integration/evals-route.test.ts` — line 296 + 309

The test currently asserts the existence of the `evalrun_active:{run_id}`
KV key as a proxy for "the run is in the cron-scan list". After migration
the cron list comes from `services.evals.listActive()` (status-driven),
not KV. Replace those two assertions:

```ts
// Old:
const activeBefore = await env.CONFIG_KV.get(`evalrun_active:${run_id}`);
expect(activeBefore).toBeTruthy();
// ...
const activeAfter = await env.CONFIG_KV.get(`evalrun_active:${run_id}`);
expect(activeAfter).toBeNull();

// New (using the public service):
const services = buildCfServices(env);   // or import via context
const activeBefore = await services.evals.listActive();
expect(activeBefore.some((r) => r.id === run_id)).toBe(true);
// ...
const activeAfter = await services.evals.listActive();
expect(activeAfter.some((r) => r.id === run_id)).toBe(false);
```

The other integration assertions (status transitions via GET /runs/:id)
keep working unchanged as long as the route handler preserves the response
shape (per the back-compat flattening in 4a).

---

## 5. Schema decisions

- **Indexes**:
  - `(tenant_id, started_at DESC)` — primary list path (evals.ts:149 default
    order, the kvListAll + sort replacement).
  - `(tenant_id, agent_id, started_at DESC)` — list-by-agent + agent-delete
    safety scan (`hasActiveByAgent`) + cascade (`deleteByAgent`).
  - `(tenant_id, environment_id, started_at DESC)` — environment-delete
    safety check.
  - **Partial** `(status, started_at ASC) WHERE status='pending' OR status='running'`
    — `listActive` cron-tick scan. Replaces the `evalrun_active:` KV index.
    Partial keeps it O(active) instead of O(all-runs).
- **No UNIQUE constraints**: eval runs have no natural uniqueness besides
  `id` (PRIMARY KEY).
- **JSON column**: `results` (nullable). Stores the full per-tick mutable
  state (task_count, completed_count, failed_count, tasks[] including each
  trial's session_id / trajectory_id / current_message_index / error).
  Opaque to the store — route + eval-runner own the shape.
- **REAL column**: `score` (nullable). Aggregate numeric score for future
  ranking / dashboard queries. Not currently populated by the route — the
  service accepts it on `markCompleted` so the eval-runner can compute and
  pass when terminal.
- **No `created_at` distinct from `started_at`**: collapsed because the
  pending phase is transient (the cron picks the run up within ~1min and
  flips to running). The integration's `rowToRecord` aliases both fields to
  `started_at` for back-compat with the `EvalRunRecord` shape.
- **Foreign keys**: none. `agent_id`, `environment_id`, `tenant_id` are
  plain TEXT. Cascades live in the route layer's agent-delete and
  environment-delete handlers (4c + 4d).
- **Status as TEXT**: schema doesn't enforce the EvalRunStatus enum;
  service layer is the source of truth. Same convention as sessions-store.
  The partial index uses literal string equality (`status = 'pending' OR
  status = 'running'`) so adding a new active-state value (e.g.
  `"resuming"`) requires a migration to widen the partial predicate.

---

## 6. Open questions

1. **Pending vs running status**: the spec named the active states as
   "running/completed/failed" but the existing code uses pending/running/
   completed/failed. I kept the four-state union for back-compat — both
   `pending` and `running` are scanned by `listActive`. If you want to drop
   `pending` and have `create` always set `status="running"`, add
   `status: "running"` in step 4a's create call and update the partial
   index in the migration to `WHERE status = 'running'`. Either works.

2. **Cron poll-vs-stream**: `listActive` is a cross-tenant table scan
   (bounded by the partial index). At today's volumes that's fine; at >10k
   active runs it could become a hot spot. Preferred next step is to add
   a per-tenant "active count" cap in the create path or a sharded
   sweeper, not to re-introduce a separate KV index.

3. **Score population**: the schema reserves a `score REAL` column but no
   caller currently computes a score. Suggest: in `eval-runner.ts`'s
   terminal-transition path, compute `completed_count / task_count` (or a
   weighted variant) and pass to `markCompleted({ score })`. Out of scope
   for this package.

4. **Trajectory blobs cleanup on delete**: when an eval run is deleted (or
   cascade-deleted via `deleteByAgent`), the per-trial trajectory keys in
   CONFIG_KV under `t:{tenant}:trajectory:{trajectory_id}` are NOT touched.
   The store doesn't know about trajectory ids (they're inside the opaque
   `results` blob). Either: (a) add a `deleteTrajectoriesForRun` helper at
   the route layer that walks `results.tasks[].trials[].trajectory_id` and
   bulk-deletes, or (b) accept the orphan (cheap KV writes, no PII risk).
   My default in step 4c is "accept the orphan" — flip if you want a clean
   cutover.

5. **Schema flexibility for future eval kinds**: the `results` JSON is
   intentionally opaque so adding new task/trial fields doesn't need a
   migration. If you ever want to query *inside* the JSON (e.g. "find runs
   where any trial mentions stack overflow"), promote that field to a
   dedicated column at that point. Today no such query exists.

6. **Migration number**: I picked `0012` because the worktree already had
   `0009_credentials_table.sql` and `0010_sessions_tables.sql`, with
   `0011` reserved for parallel store work in flight (vaults-store /
   files-store / model-cards-store packages exist but their migrations
   aren't yet in the tree). If a parallel branch lands `0011` first,
   re-number the migration file + update the test-worker import — the
   service code is migration-number-agnostic.
