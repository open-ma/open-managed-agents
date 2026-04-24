# INTEGRATION_GUIDE.md — `@open-managed-agents/sessions-store`

OPE-8: KV → D1 migration of `sessions` and `session_resources`. This guide
lists every change the integration step needs to wire the new service into
the codebase. Execute these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package was already added to `apps/main/package.json`
  and `apps/agent/package.json` workspace deps in this branch).
- Migration file picked: **`0010_sessions_tables.sql`**.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside existing `MemoryStoreService` /
`CredentialService`):

```ts
import {
  SessionService,
  createCfSessionService,
} from "@open-managed-agents/sessions-store";
```

Add to the `Services` interface:

```ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  sessions: SessionService;        // ← add
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    sessions: createCfSessionService(env),   // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/sessions-store/test-fakes": "./packages/sessions-store/src/test-fakes.ts",
"@open-managed-agents/sessions-store": "./packages/sessions-store/src/index.ts",
```

After this lands, the test file imports can be swapped from relative
(`../../packages/sessions-store/src/...`) to package-name imports for
consistency with the credentials-store test (optional cleanup — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after `cred0009`:

```ts
// @ts-expect-error
import sess0010 from "../apps/main/migrations/0010_sessions_tables.sql?raw";
```

Append `sess0010 as string,` to the `MIGRATIONS_RAW` array:

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
  sess0010 as string,            // ← add
];
```

---

## 4. Route + DO switches — every site that touches `session:` or `sesrsc:` KV

Each row gives: file path + approximate line range + the **before** pattern
to match + the **after** replacement. All HTTP routes use
`c.var.services.sessions.<method>`. SessionDO and any sandbox-default-only
worker uses `buildCfServices(env).sessions.<method>` (or pre-builds
once in the DO constructor).

### 4a. `apps/main/src/routes/sessions.ts`

#### POST / (create) — lines 273–387

Old: build SessionMeta object, KV.put session record, then loop over
`body.resources` and KV.put each resource (lines 285, 328, 342, 363, 375).

After (using one atomic call):

```ts
// (Keep the agent_snapshot / environment_snapshot / vaultIds / fastPathTokens
//  preparation EXACTLY as is — those happen before the session create.)

// Build the resources array (id + session_id + created_at are stamped by
// the service; pass everything else, including any `credential_id` derived
// from fastPathTokens). DO NOT include secret material — env_secret.value
// and github_repository.authorization_token still go to CONFIG_KV under the
// `secret:{sessionId}:{resourceId}` keys (lines 361 + 374 stay).
const initialResources = (body.resources ?? []).flatMap((res) => {
  if (res.type === "file" && res.file_id) {
    // …file copy + R2 + scopedFile creation as before…
    return [{ type: "file" as const, file_id: scopedFileId, mount_path: res.mount_path }];
  }
  if (res.type === "memory_store" && res.memory_store_id) {
    return [{
      type: "memory_store" as const,
      memory_store_id: res.memory_store_id,
      mount_path: res.mount_path,
      access: res.access === "read_only" ? "read_only" : "read_write",
      prompt: typeof res.prompt === "string" ? res.prompt.slice(0, 4096) : undefined,
    }];
  }
  if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
    const repoUrl = res.url || res.repo_url!;
    return [{
      type: "github_repository" as const,
      url: repoUrl,
      repo_url: repoUrl,
      mount_path: res.mount_path || "/workspace",
      checkout: res.checkout,
    }];
  }
  if (res.type === "env_secret" && res.name && res.value) {
    return [{ type: "env_secret" as const, name: res.name }];
  }
  return [];
});

const { session, resources: createdResources } =
  await c.var.services.sessions.create({
    tenantId: t,
    agentId: body.agent,
    environmentId: body.environment_id,
    title: body.title || "",
    vaultIds,
    agentSnapshot,
    environmentSnapshot,
    resources: initialResources,
  });
const sessionId = session.id;   // replaces `const sessionId = generateSessionId();`

// (then continue with sandbox /init using sessionId, AND keep the existing
//  loops that write `secret:{sessionId}:{resourceId}` keys for env_secret +
//  github_repository tokens — those don't move into the sessions store.)
```

Important: keep `await c.env.CONFIG_KV.put(kvKey(t, "secret", sessionId, resourceId), ...)`
and the `r2.put(fileR2Key(...))` calls. Sessions store does NOT manage
secret payloads or R2 objects — those continue to live in their respective
stores.

#### GET / (list) — lines 389–423

Replace the kvListAll + loop entirely:

```ts
const sessions = await c.var.services.sessions.list({
  tenantId: c.get("tenant_id"),
  agentId: agentIdFilter ?? undefined,
  includeArchived,
  order,
  limit,
});
return c.json({ data: sessions });
```

Drop the imports `kvListAll` and `kvPrefix` from this file IF they're only
used for sessions (otherwise leave them).

#### GET /:id — lines 425–460

Replace `await c.env.CONFIG_KV.get(kvKey(... "session", id))` with
`await c.var.services.sessions.get({ tenantId, sessionId: id })`. The
SessionRow shape exposes `agent_snapshot` and `environment_snapshot` as the
parsed objects, not strings — adjust `response.agent = session.agent_snapshot`
to reference the new field name (it's the same name today, just confirm).

#### POST /:id/archive — lines 462–474

```ts
const session = await c.var.services.sessions.archive({
  tenantId: c.get("tenant_id"),
  sessionId: c.req.param("id"),
});
return c.json(session);
```

Catch `SessionNotFoundError` → 404.

#### POST /:id (update) — lines 476–504

```ts
const updated = await c.var.services.sessions.update({
  tenantId: c.get("tenant_id"),
  sessionId: c.req.param("id"),
  title: body.title,
  metadata: body.metadata,   // service handles per-key null-deletes
});
return c.json(updated);
```

#### DELETE /:id — lines 506–529

After the sandbox `/destroy` call:

```ts
await c.var.services.sessions.delete({
  tenantId: c.get("tenant_id"),
  sessionId: c.req.param("id"),
});
// Cascade still owned by callers: drop secret KV keys + sidx
// (sidx cleanup is now optional — getById replaces sidx; but back-compat
// removal is fine).
```

The `SessionService.delete` cascades session_resources in the same batch.
Caller still must purge `secret:{sessionId}:{resourceId}` KV entries (do
this AFTER the sessions delete, by listing them via the sandbox or by
listing remaining KV `secret:` keys — the routes already track the
resourceIds at create time, so easiest is iterate `createdResources` if
available, else `kvListAll(c.env.CONFIG_KV, kvPrefix(t, "secret", sessionId))`).

#### POST /:id/events, /:id/files, GET /:id/events, /:id/trajectory, /:id/threads, /:id/threads/:thread_id/events, /:id/stream, /:id/events/stream

Every `await c.env.CONFIG_KV.get(kvKey(... "session", id))` becomes
`await c.var.services.sessions.get({ tenantId, sessionId: id })`. The
`session.archived_at` boolean check at line 541 stays valid (the field is
present on SessionRow). `session.agent_snapshot` references stay valid.

Lines: 535, 605, 669, 723, 748, 813, 828, 851, 922, 942.

#### POST /:id/resources — lines 849–918

Old: kvListAll for count + per-resource memory_store check + KV.put.

New:

```ts
try {
  const resource = await c.var.services.sessions.addResource({
    tenantId: c.get("tenant_id"),
    sessionId,
    resource: {
      type: body.type,
      file_id: body.file_id,
      memory_store_id: body.memory_store_id,
      mount_path: body.mount_path,
      access: body.type === "memory_store"
        ? (body.access === "read_only" ? "read_only" : "read_write")
        : undefined,
      prompt: body.type === "memory_store" && typeof body.prompt === "string"
        ? body.prompt.slice(0, 4096)
        : undefined,
    },
  });
  return c.json(resource.resource, 201);
} catch (err) {
  if (err instanceof SessionResourceMaxExceededError) return c.json({ error: err.message }, 400);
  if (err instanceof SessionMemoryStoreMaxExceededError) return c.json({ error: err.message }, 422);
  if (err instanceof SessionArchivedError) return c.json({ error: err.message }, 409);
  if (err instanceof SessionNotFoundError) return c.json({ error: "Session not found" }, 404);
  throw err;
}
```

The pre-validation that `body.file_id` exists in CONFIG_KV (line 877)
should stay — sessions store does not validate file existence.

#### GET /:id/resources — lines 920–936

```ts
const resources = await c.var.services.sessions.listResources({
  tenantId: c.get("tenant_id"),
  sessionId,
});
return c.json({ data: resources.map((r) => r.resource) });
```

#### DELETE /:id/resources/:resource_id — lines 938–951

```ts
await c.var.services.sessions.deleteResource({
  tenantId: c.get("tenant_id"),
  sessionId,
  resourceId,
});
return c.json({ type: "resource_deleted", id: resourceId });
```

Caller still must delete the matching `secret:{sessionId}:{resourceId}` KV
key if the resource was env_secret or github_repository.

### 4b. `apps/main/src/routes/internal.ts`

#### POST /sessions (create) — lines 269–296

Replace lines 269–287 (the manual session record + KV.put) with:

```ts
const { session, resources: createdResources } =
  await c.var.services.sessions.create({
    tenantId,
    agentId: body.agentId,
    environmentId: body.environmentId,
    title: "",
    vaultIds,
    agentSnapshot,
    environmentSnapshot: envConfig,
    metadata: sessionMetadata,
    // initial resources = [] here — repo resource added below
  });
const sessionId = session.id;
```

Drop the `kvKey(tenantId, "session", sessionId)` put.

The `sidx:{sessionId}` write (lines 294-296) is now obsolete — `getById`
replaces it. RECOMMEND: keep it for two weeks for back-compat with the
GET /sessions/:id fallback path, then delete in a follow-up PR.

#### Lines 302–321 (githubRepoUrl materialization)

The `kvKey(tenantId, "secret", sessionId, resourceId)` put STAYS (it's
a secret). Replace the `kvKey(tenantId, "sesrsc", ...)` put with:

```ts
await c.var.services.sessions.addResource({
  tenantId,
  sessionId,
  resource: {
    type: "github_repository",
    url: body.githubRepoUrl,
    repo_url: body.githubRepoUrl,
    mount_path: "/workspace",
  },
});
```

#### POST /sessions/:id/events (resume) — lines 339–371

Replace `await c.env.CONFIG_KV.get(kvKey(tenantId, "session", sessionId))`
with `await c.var.services.sessions.get({ tenantId, sessionId })`.

#### GET /sessions/:id (cross-tenant lookup) — lines 381–409

The whole block becomes:

```ts
app.get("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const session = await c.var.services.sessions.getById({ sessionId });
  if (!session) return c.json({ error: "session not found" }, 404);
  return c.json(session);
});
```

The `sidx:` lookup + the legacy paginated tenant-prefix scan both go away.
`getById` is O(1) via the `sessions.id` PRIMARY KEY.

### 4c. `apps/main/src/routes/agents.ts` (DELETE /:id) — lines 332–352

Replace the `kvListAll(... "session")` + JSON.parse loop with a single
indexed query:

```ts
const hasActive = await c.var.services.sessions.hasActiveByAgent({
  tenantId: t,
  agentId: id,
});
if (hasActive) {
  return c.json({ error: "Cannot delete agent with active sessions. Archive or delete sessions first." }, 409);
}
```

(Optional follow-up: when the route allows force-delete, call
`c.var.services.sessions.deleteByAgent({ tenantId: t, agentId: id })`
to cascade.)

### 4d. `apps/main/src/routes/environments.ts` (DELETE /:id) — lines 213–232

Same pattern:

```ts
const hasActive = await c.var.services.sessions.hasActiveByEnvironment({
  tenantId: t,
  environmentId: id,
});
if (hasActive) {
  return c.json({ error: "Cannot delete environment referenced by active sessions" }, 409);
}
```

### 4e. `apps/main/src/eval-runner.ts`

Lines 110 + 140: replace the KV put + KV get with service calls.

```ts
// ~line 91 — after building agentSnapshot + environmentSnapshot
const { session } = await buildCfServices(env).sessions.create({
  tenantId: t,
  agentId: run.agent_id,
  environmentId: run.environment_id,
  title: `eval ${run.id} :: ${task.id}`,
  agentSnapshot,
  environmentSnapshot,
});
const sessionId = session.id;
// (delete the manual KV.put on line 110)

// ~line 140 in buildAndStoreTrajectory
const session = await buildCfServices(env).sessions.get({ tenantId: t, sessionId });
if (!session) throw new Error(`session ${sessionId} not found`);
```

(Or build services once at module/entrypoint scope.)

### 4f. `apps/agent/src/runtime/session-do.ts`

Two resource-list reads need to switch:

#### Line ~966 (mountResources at warmup)

```ts
// Old: this.env.CONFIG_KV.list({ prefix: this.tk("sesrsc", sessionId) + ":" })
// New:
const services = buildCfServices(this.env);
const rows = await services.sessions.listResourcesBySession({ sessionId });
const resources = rows.map((r) => r.resource);
```

The `secretStore` read (line 978) stays as-is — secrets remain in CONFIG_KV.

#### Line ~1640 (memory_store discovery for tools)

```ts
// Old: this.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` })  ← also a tenant-prefix bug per TODO
// New:
const services = buildCfServices(this.env);
const rows = await services.sessions.listResourcesBySession({ sessionId });
for (const row of rows) {
  if (row.type === "memory_store" && row.resource.memory_store_id) {
    memoryAttachments.push({
      store_id: row.resource.memory_store_id,
      access: row.resource.access === "read_only" ? "read_only" : "read_write",
      prompt: typeof row.resource.prompt === "string" ? row.resource.prompt : undefined,
    });
  }
}
```

This also fixes the missing-tenant-prefix bug noted in the existing TODO
(line 1638-1640) — `listResourcesBySession` queries the `session_id` column
directly, no tenant prefix needed.

---

## 5. Schema decisions

- **Indexes**:
  - `(tenant_id, created_at DESC)` — primary list path (sessions.ts:417 default order).
  - `(tenant_id, agent_id, archived_at)` — list-by-agent + agent-delete cascade scan.
  - `(tenant_id, environment_id, archived_at)` — environment-delete safety check.
  - `(session_id, created_at ASC)` — listResources(sessionId) hot path.
  - `(session_id, type)` — countResourcesByType for the memory_store quota
    (was sessions.ts:884-895 KV scan + JSON.parse + filter).
- **No UNIQUE constraints**: sessions don't have a natural uniqueness
  besides `id` (PRIMARY KEY). Resources are unique by `id` only — multiple
  identical (type, file_id) pairs are intentionally allowed (a user can
  attach the same file twice with different mount_paths).
- **JSON columns**: `vault_ids`, `agent_snapshot`, `environment_snapshot`,
  `metadata` (sessions); `config` (resources). All nullable except `config`.
- **Foreign keys**: none. `agent_id`, `environment_id`, `session_id`,
  `tenant_id` are plain TEXT. Cascades live in `SessionService.delete{,
  ByAgent}` and the route layer's environment-delete refusal path.
- **Resource `config` JSON**: stores the FULL `SessionResource` payload
  (round-trips id + session_id + created_at along with the rest). Slightly
  redundant with the dedicated columns but lets readers parse one JSON and
  hand the result straight to the SessionDO `mountResources` consumer
  without re-shaping.
- **Status as TEXT**: schema doesn't enforce the SessionStatus enum;
  service layer is the source of truth. SQLite would need a CHECK
  constraint to enforce in-DB and we've avoided those project-wide.

---

## 6. Open questions

1. **`sidx:{sessionId}` cleanup**: I left the `sidx:` writes/reads alive
   in the integration steps as a deprecation window. Decision needed: drop
   immediately (since `getById` replaces it cleanly via PK lookup and there
   are no rolling deploys to worry about) or keep for one release. My
   default in step 4b is "keep for back-compat" — flip to "drop" if you
   want a cleaner cutover.

2. **`secret:{sessionId}:{resourceId}` KV cleanup on DELETE**: the route
   layer must still delete these after `service.delete()`. The current
   route doesn't enumerate them — it relies on TTL or explicit knowledge.
   Suggest: add a helper `deleteSessionSecrets(env, tenantId, sessionId)`
   that does `kvListAll(env.CONFIG_KV, kvPrefix(tenantId, "secret", sessionId))`
   then `Promise.all(deletes)`. Out of scope for this package (pure KV
   ops), but worth a callout in the route refactor.

3. **`updateSnapshots` API surface**: I exposed `agentSnapshot` /
   `environmentSnapshot` as updatable fields on `service.update`. No
   current caller mutates them, but the existing route file's
   POST /v1/sessions/:id (line 477) doesn't allow it either, so I matched
   it. If you want to lock those down (immutable post-create like
   `mcp_server_url` is for credentials), let me know and I'll add a
   service-layer guard.

4. **eval-runner builds services per-call**: the example in step 4e
   shows `buildCfServices(env).sessions.create(...)` per invocation.
   If you have a long-lived holder for services in the eval-runner module
   already, prefer that. Each `buildCfServices` call is cheap (just object
   construction), so per-call is fine but not ideal.

5. **Resource secret-stripping on the API surface**: there's no equivalent
   to `stripSecrets` here because resources never store secret material in
   D1 (env_secret.value and github_repository.authorization_token go to
   `secret:` KV). If a future resource type stores something secret in
   `config`, add a service-layer stripper following the credentials-store
   `stripSecrets` pattern.
