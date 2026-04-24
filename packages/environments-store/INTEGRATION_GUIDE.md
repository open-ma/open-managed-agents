# INTEGRATION_GUIDE.md — `@open-managed-agents/environments-store`

KV → D1 migration of `environments` (the `t:{tenant}:env:{id}` KV layout).
This guide lists every change the integration step needs to wire the new
service into the codebase. Execute these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package has already been added to
  `apps/main/package.json` and `apps/agent/package.json` in this branch).
- Migration file: **`0003_environments_table.sql`** — a separate file the
  integrator will fold into `apps/main/migrations/0001_schema.sql` later.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import alongside the other store factories:

```ts
import {
  EnvironmentService,
  createCfEnvironmentService,
} from "@open-managed-agents/environments-store";
```

Add to the `Services` interface (alphabetical, between `credentials` and `evals`):

```ts
export interface Services {
  credentials: CredentialService;
  environments: EnvironmentService;     // ← add
  evals: EvalRunService;
  files: FileService;
  memory: MemoryStoreService;
  modelCards: ModelCardService;
  sessions: SessionService;
  vaults: VaultService;
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    environments: createCfEnvironmentService(env),   // ← add
    evals: createCfEvalRunService(env),
    files: createCfFileService(env),
    memory: createCfMemoryStoreService(env),
    modelCards: createCfModelCardService(env),
    sessions: createCfSessionService(env),
    vaults: createCfVaultService(env),
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/environments-store/test-fakes": "./packages/environments-store/src/test-fakes.ts",
"@open-managed-agents/environments-store": "./packages/environments-store/src/index.ts",
```

After this lands, `test/unit/environments-store-service.test.ts` imports
can be flipped from relative (`../../packages/environments-store/src/...`)
to package-name imports for consistency with the credentials-store test
(cosmetic — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after `schema0001`:

```ts
// @ts-expect-error
import env0003 from "../apps/main/migrations/0003_environments_table.sql?raw";
```

Append `env0003 as string,` to the `MIGRATIONS_RAW` array:

```ts
const MIGRATIONS_RAW: string[] = [
  schema0001 as string,
  env0003 as string,            // ← add
];
```

(After the integrator folds `0003` into `0001`, this entry can be removed.)

---

## 4. Route + DO switches — every site that touches `t:{tenant}:env:` KV

Each row gives: file path + approximate line range + the **before** pattern
+ the **after** replacement. All HTTP routes use
`c.var.services.environments.<method>`. SessionDO and the eval-runner use
`buildCfServices(env).environments.<method>` (or the cached `getServices(env)`
helper that already exists in `eval-runner.ts`).

### 4a. `apps/main/src/routes/environments.ts` (full rewrite)

#### Imports

Add at the top:

```ts
import {
  EnvironmentNotFoundError,
  toEnvironmentConfig,
} from "@open-managed-agents/environments-store";
```

Drop `kvKey, kvPrefix, kvListAll` if they're no longer used elsewhere in
this file (they aren't after the rewrite).

Drop `generateEnvId` import — id generation moves into the service.

#### POST / (create) — lines 53–92

```ts
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    description?: string;
    config: EnvironmentConfig["config"];
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);

  const row = await c.var.services.environments.create({
    tenantId: t,
    name: body.name,
    description: body.description,
    config: body.config || { type: "cloud" },
    status: canBuild ? "building" : "ready",
    sandboxWorkerName: canBuild ? null : "sandbox-default",
  });

  if (canBuild) {
    try {
      await triggerBuild(c.env, toEnvironmentConfig(row), c.req.url);
    } catch (e) {
      console.log(`[env] triggerBuild failed: ${e instanceof Error ? e.message : String(e)}`);
      const updated = await c.var.services.environments.update({
        tenantId: t,
        environmentId: row.id,
        status: "error",
        buildError: e instanceof Error ? e.message : String(e),
      });
      return c.json(toEnvironmentConfig(updated), 201);
    }
  }

  return c.json(toEnvironmentConfig(row), 201);
});
```

`triggerBuild` still takes an `EnvironmentConfig` (the GitHub workflow
inputs only need `id` + `config.packages`), so the row → config conversion
keeps the helper unchanged.

#### POST /:id/build-complete — lines 96–134

```ts
app.post("/:id/build-complete", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    status: "ready" | "error";
    sandbox_worker_name?: string;
    error?: string;
  };

  const updates: Parameters<typeof c.var.services.environments.update>[0] = {
    tenantId: t,
    environmentId: id,
    status: body.status,
  };

  if (body.status === "ready") {
    const workerName = body.sandbox_worker_name || `sandbox-${id}`;
    updates.sandboxWorkerName = workerName;
    updates.buildError = null;   // clear any previous error

    if (c.env.CLOUDFLARE_API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
      try {
        const bindingName = envIdToBindingName(id);
        await addServiceBinding(
          c.env.CLOUDFLARE_ACCOUNT_ID, "managed-agents", c.env.CLOUDFLARE_API_TOKEN,
          bindingName, workerName,
        );
      } catch (err) {
        console.log(`[env] addServiceBinding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Keep the t:svcbind:* KV entry as historical breadcrumb (optional —
    // see Open Question #2).
    await c.env.CONFIG_KV.put(kvKey(t, "svcbind", id), workerName);
  } else if (body.error) {
    updates.buildError = body.error;
  }

  try {
    const updated = await c.var.services.environments.update(updates);
    console.log(`[env] build-complete for ${id}: status=${body.status} worker=${updated.sandbox_worker_name}`);
    return c.json(toEnvironmentConfig(updated));
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) return c.json({ error: "Environment not found" }, 404);
    throw err;
  }
});
```

#### GET / (list) — lines 137–147

```ts
app.get("/", async (c) => {
  const list = await c.var.services.environments.list({
    tenantId: c.get("tenant_id"),
    // historical KV listed everything, including archived rows
  });
  return c.json({ data: list.map(toEnvironmentConfig) });
});
```

#### GET /:id — lines 150–156

```ts
app.get("/:id", async (c) => {
  const row = await c.var.services.environments.get({
    tenantId: c.get("tenant_id"),
    environmentId: c.req.param("id"),
  });
  if (!row) return c.json({ error: "Environment not found" }, 404);
  return c.json(toEnvironmentConfig(row));
});
```

#### PUT /:id — lines 159–201

```ts
app.put("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    description?: string;
    config?: EnvironmentConfig["config"];
  };

  const updates: Parameters<typeof c.var.services.environments.update>[0] = {
    tenantId: t,
    environmentId: id,
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;

  if (body.config !== undefined) {
    const configChanged = JSON.stringify(body.config) !== JSON.stringify(existing.config);
    updates.config = body.config;

    if (configChanged) {
      const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);
      if (canBuild) {
        updates.status = "building";
        updates.sandboxWorkerName = null;
        updates.buildError = null;
      } else {
        updates.sandboxWorkerName = existing.sandbox_worker_name || "sandbox-default";
        updates.status = "ready";
      }
    }
  }

  let updated = await c.var.services.environments.update(updates);

  if (body.config !== undefined && updates.status === "building") {
    try {
      await triggerBuild(c.env, toEnvironmentConfig(updated), c.req.url);
    } catch {
      updated = await c.var.services.environments.update({
        tenantId: t,
        environmentId: id,
        status: "error",
      });
    }
  }

  return c.json(toEnvironmentConfig(updated));
});
```

#### POST /:id/archive — lines 204–214

```ts
app.post("/:id/archive", async (c) => {
  try {
    const row = await c.var.services.environments.archive({
      tenantId: c.get("tenant_id"),
      environmentId: c.req.param("id"),
    });
    return c.json(toEnvironmentConfig(row));
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) return c.json({ error: "Environment not found" }, 404);
    throw err;
  }
});
```

#### DELETE /:id — lines 217–245

(The `hasActiveByEnvironment` checks for sessions + evals stay exactly as
they are — only the existence check + the actual KV.delete change.)

```ts
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");

  const exists = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!exists) return c.json({ error: "Environment not found" }, 404);

  const hasActiveSessions = await c.var.services.sessions.hasActiveByEnvironment({
    tenantId: t,
    environmentId: id,
  });
  if (hasActiveSessions) {
    return c.json({ error: "Cannot delete environment referenced by active sessions" }, 409);
  }

  const hasActiveEvals = await c.var.services.evals.hasActiveByEnvironment({
    tenantId: t,
    environmentId: id,
  });
  if (hasActiveEvals) {
    return c.json({
      error: "Cannot delete environment referenced by active eval runs",
    }, 409);
  }

  await c.var.services.environments.delete({ tenantId: t, environmentId: id });
  return c.json({ type: "environment_deleted", id });
});
```

### 4b. `apps/main/src/routes/sessions.ts` — `getSandboxBinding`

The KV.get on line 52 (inside `getSandboxBinding`) becomes a service call.
Drop the `JSON.parse(envData) as EnvironmentConfig` — the row already has
the parsed shape.

#### Lines 47–101

```ts
async function getSandboxBinding(
  env: Env,
  services: Services,                         // ← add
  environmentId: string,
  tenantId: string,
): Promise<{ binding: Fetcher | null; error?: string; status?: 404 | 500 | 503 }> {
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow) return { binding: null, error: "Environment not found", status: 404 };

  if (envRow.status === "building") {
    return { binding: null, error: "Environment is still building", status: 503 };
  }
  if (envRow.status === "error") {
    return { binding: null, error: `Environment build failed: ${envRow.build_error || "unknown error"}`, status: 500 };
  }
  if (!envRow.sandbox_worker_name) {
    return { binding: null, error: "No sandbox worker configured for this environment", status: 500 };
  }

  const bindingName = `SANDBOX_${envRow.sandbox_worker_name.replace(/-/g, "_")}`;
  // …rest unchanged…
}
```

Update every call site in `routes/sessions.ts` to pass `c.var.services` as
the second arg. Lines: 226, 493, 561, 622, 688, 747, 800, 842, 909, 926.

The pre-fetch at line 233-234 (snapshot for SessionDO):

```ts
// OLD
const envSnapshotData = await c.env.CONFIG_KV.get(kvKey(t, "env", body.environment_id));
const environmentSnapshot = envSnapshotData ? (JSON.parse(envSnapshotData) as EnvironmentConfig) : undefined;

// NEW
const envRow = await c.var.services.environments.get({ tenantId: t, environmentId: body.environment_id });
const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;
```

The `fetchEnvironmentConfig` closure (line 873-875) is in the
`refreshProviderCredentialsForSession` path:

```ts
async function fetchEnvironmentConfig(): Promise<EnvironmentConfig | null> {
  const row = await services.environments.get({
    tenantId: c.get("tenant_id"),
    environmentId: session.environment_id,
  });
  return row ? toEnvironmentConfig(row) : null;
}
```

Add the import:

```ts
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
```

### 4c. `apps/main/src/routes/internal.ts`

#### Lines 123–127 (env lookup before sandbox dispatch)

```ts
// OLD
const envSnapshotData = await c.env.CONFIG_KV.get(
  kvKey(tenantId, "env", body.environmentId),
);
if (!envSnapshotData) return c.json({ error: "environment not found in tenant" }, 404);
const envConfig = JSON.parse(envSnapshotData) as EnvironmentConfig;

// NEW
const envRow = await c.var.services.environments.get({
  tenantId,
  environmentId: body.environmentId,
});
if (!envRow) return c.json({ error: "environment not found in tenant" }, 404);
const envConfig = toEnvironmentConfig(envRow);
```

The `envConfig.sandbox_worker_name` check on line 131 stays valid (the
shape matches because of `toEnvironmentConfig`). The `environment_snapshot`
field on the session create (line 173) also keeps the same shape.

Add the import:

```ts
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
```

### 4d. `apps/main/src/eval-runner.ts`

#### Top-level `getSandboxBinding` helper — lines 24–55

```ts
async function getSandboxBinding(env: Env, environmentId: string, tenantId: string): Promise<Fetcher | null> {
  const envRow = await getServices(env).environments.get({ tenantId, environmentId });
  if (!envRow || !envRow.sandbox_worker_name) return null;
  const bindingName = `SANDBOX_${envRow.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (env as unknown as Record<string, unknown>)[bindingName] as Fetcher | undefined;
  if (binding) return binding;
  // …keep the SessionDO fallback unchanged…
}
```

#### `createTaskSession` — line 146-147

```ts
// OLD
const envSnapshotData = await env.CONFIG_KV.get(kvKey(t, "env", run.environment_id));
const environmentSnapshot = envSnapshotData ? (JSON.parse(envSnapshotData) as EnvironmentConfig) : undefined;

// NEW
const envRow = await getServices(env).environments.get({ tenantId: t, environmentId: run.environment_id });
const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;
```

Add the import:

```ts
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
```

### 4e. `apps/agent/src/runtime/session-do.ts`

Two reads need to switch — both inside the SessionDO class.

#### `getEnvConfig` — lines 189-196

```ts
private async getEnvConfig(envId: string): Promise<EnvironmentConfig | null> {
  if (this.state.environment_snapshot && envId === this.state.environment_id) {
    return this.state.environment_snapshot;
  }
  const services = buildCfServices(this.env);
  const row = await services.environments.get({
    tenantId: this.state.tenant_id,
    environmentId: envId,
  });
  return row ? toEnvironmentConfig(row) : null;
}
```

Add the import:

```ts
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
```

#### Top-level `getSandboxBinding` — lines 24–35

```ts
async function getSandboxBinding(env: Env, environmentId: string, tenantId: string): Promise<Fetcher | null> {
  const services = buildCfServices(env);
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow || !envRow.sandbox_worker_name) return null;
  const bindingName = `SANDBOX_${envRow.sandbox_worker_name.replace(/-/g, "_")}`;
  // …rest unchanged…
}
```

(The `getServices(env)` cache pattern that eval-runner uses doesn't exist
in session-do.ts — `buildCfServices(this.env)` per call is fine here too,
mirroring the existing usages on lines 965, 1118, 1612.)

---

## 5. Schema decisions

- **Indexes**:
  - `(tenant_id, archived_at)` — primary list path, also serves the
    historical-KV-style "list everything in tenant" scan (the
    `archived_at` column is indexed but the route default `includeArchived: true`
    doesn't filter on it, so SQLite uses the index for `tenant_id` and just
    returns archived rows alongside).
- **No UNIQUE constraints**: environment names are not enforced unique at
  the DB level — multiple `prod` environments per tenant are allowed (the
  legacy KV layout had no uniqueness either).
- **JSON columns**: `config` (NOT NULL — every environment has at least
  `{ type: "cloud" }`) and `metadata` (NULL allowed, parsed lazily).
- **Foreign keys**: none. `tenant_id` is plain TEXT. The cross-store
  cascade (refuse delete if active sessions / evals reference the env)
  lives in the route layer's DELETE handler, not in this store.
- **Hot fields denormalized**: `status` and `sandbox_worker_name` are
  dedicated columns rather than living inside the `config` JSON, because
  `getSandboxBinding` reads them on every session-attached request and
  parsing JSON per row would be wasteful.
- **`status` as TEXT**: schema doesn't enforce the EnvironmentStatus enum;
  the service layer is the source of truth. SQLite would need a CHECK
  constraint to enforce in-DB and we've avoided those project-wide.
- **Tri-state nullables on update**: `description`, `sandbox_worker_name`,
  `build_error`, `metadata` use `undefined = leave / null = clear / value
  = set` semantics so the route can express "clear build_error after a
  retry" (PUT path) distinctly from "leave it alone" (rename-only path).

---

## 6. Open questions

1. **`t:{tenant}:svcbind:{id}` KV entry on build-complete**: the legacy
   route writes this alongside the env record but I cannot find a reader
   in the current codebase. Suggested step 4a keeps the write for now as a
   harmless breadcrumb. Drop in a follow-up PR once we confirm nothing
   reads it. (Search: `kvKey.*svcbind` returns only the writer in
   `routes/environments.ts:127`.)

2. **`includeArchived` default**: the service defaults to `true` to match
   the historical KV scan, which returned every row. The new
   `routes/environments.ts` GET / could opt into `includeArchived: false`
   to hide archived rows from the API — but that's a behavior change.
   Default to keeping the legacy behavior; flip when the console is ready
   to show an "archived" filter.

3. **`environment_snapshot` round-trip**: routes currently construct the
   sessions-store snapshot via `JSON.parse(...) as EnvironmentConfig`. The
   new path goes through `toEnvironmentConfig(row)` which **omits null
   fields** to preserve the historical "field absent" wire shape. If any
   downstream consumer of `environment_snapshot` checks
   `snapshot.description === null` (vs `snapshot.description == null`)
   they'd silently break — none do today, but worth a search before merge.

4. **`triggerBuild` signature**: kept as `(env, EnvironmentConfig, url)`
   for minimal-diff. Future cleanup: switch to taking
   `(env, { id, packages }, url)` since those are the only two fields the
   GitHub Actions dispatch payload uses.

5. **Cross-tenant `getById`**: not exposed. Every reader today looks up
   by `(tenantId, environmentId)` so there's no `sidx:`-style reverse
   index to migrate. Add `getById` if a future console "lookup by env id"
   admin tool needs it.
