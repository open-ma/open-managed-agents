# INTEGRATION_GUIDE.md — `@open-managed-agents/agents-store`

KV → D1 migration of the `agents` entity. This guide lists every change the
integration step needs to wire the new service into the codebase. Execute
these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package was already added to `apps/main/package.json`
  and `apps/agent/package.json` workspace deps in this branch).
- Migration file picked: **`0002_agents_tables.sql`** (separate file pending
  fold-in into `0001_schema.sql` by the integrator).

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside existing service imports):

```ts
import {
  AgentService,
  createCfAgentService,
} from "@open-managed-agents/agents-store";
```

Add to the `Services` interface:

```ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  vaults: VaultService;
  sessions: SessionService;
  files: FileService;
  evals: EvalRunService;
  modelCards: ModelCardService;
  agents: AgentService;            // ← add
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    vaults: createCfVaultService(env),
    sessions: createCfSessionService(env),
    files: createCfFileService(env),
    evals: createCfEvalRunService(env),
    modelCards: createCfModelCardService(env),
    agents: createCfAgentService(env),     // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/agents-store/test-fakes": "./packages/agents-store/src/test-fakes.ts",
"@open-managed-agents/agents-store": "./packages/agents-store/src/index.ts",
```

After this lands, the test file imports can be swapped from relative
(`../../packages/agents-store/src/...`) to package-name imports for
consistency with the credentials-store test (optional cleanup — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after `schema0001`:

```ts
// @ts-expect-error
import agents0002 from "../apps/main/migrations/0002_agents_tables.sql?raw";
```

Append `agents0002 as string,` to the `MIGRATIONS_RAW` array:

```ts
const MIGRATIONS_RAW: string[] = [
  schema0001 as string,
  agents0002 as string,            // ← add
];
```

(After integrator folds `0002_agents_tables.sql` into `0001_schema.sql`,
both lines come back out — `schema0001` already covers the new tables.)

---

## 4. Route + DO switches — every site that touches `t:*:agent:*` KV

Each row gives: file path + approximate line range + the **before** pattern
to match + the **after** replacement. All HTTP routes use
`c.var.services.agents.<method>`. SessionDO and any sandbox-default-only
worker uses `buildCfServices(env).agents.<method>` (or pre-builds once in
the DO constructor / module).

---

### 4a. `apps/main/src/routes/agents.ts`

The whole file is a one-to-one swap onto the AgentService. Concrete changes:

#### POST `/` (create) — lines 82–142

Replace the manual object construction + `KV.put` with a service `create`:

```ts
// (Keep the validateModel + aux_model validation EXACTLY as is — those
//  predicate the create on model-cards-service state.)

const created = await c.var.services.agents.create({
  tenantId,
  input: {
    name: body.name,
    model: body.model,
    system: body.system,
    tools: body.tools,
    harness: body.harness,
    description: body.description,
    mcp_servers: body.mcp_servers,
    skills: body.skills,
    callable_agents: body.callable_agents,
    metadata: body.metadata,
    model_card_id: body.model_card_id,
    aux_model: body.aux_model,
    aux_model_card_id: body.aux_model_card_id,
    // appendable_prompts not in the create payload today — leave undefined.
  },
});
return c.json(formatAgent(created), 201);
```

#### GET `/` (list) — lines 144–167

Replace the `kvListAll` + `filter(name has ":v")` + `Promise.all(KV.get)` with
a single service call:

```ts
const tenantId = c.get("tenant_id");
const limitParam = c.req.query("limit");
const order = c.req.query("order") === "asc" ? "asc" : "desc";
let limit = limitParam ? parseInt(limitParam, 10) : 100;
if (isNaN(limit) || limit < 1) limit = 100;
if (limit > 1000) limit = 1000;

const agents = await c.var.services.agents.list({
  tenantId,
  includeArchived: true,                  // legacy GET returned everything; see below
});

// Order + limit at the route layer to preserve the existing query semantics.
agents.sort((a, b) => a.created_at.localeCompare(b.created_at) * (order === "asc" ? 1 : -1));
return c.json({ data: agents.slice(0, limit).map(formatAgent) });
```

Drop the `kvListAll` + `kvPrefix` imports from this file IF they're only used
for agents (otherwise leave them).

#### GET `/:id` — lines 169–176

```ts
const agent = await c.var.services.agents.get({
  tenantId: c.get("tenant_id"),
  agentId: c.req.param("id"),
});
if (!agent) return c.json({ error: "Agent not found" }, 404);
return c.json(formatAgent(agent));
```

#### POST/PUT `/:id` (update) — lines 179–280

Replace the whole hand-rolled "merge fields, bump version, write history,
write current" block with one service call. Keep the validateModel checks
in front (they need the existing snapshot for fallback semantics).

```ts
const updateAgent = async (c: any) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const existing = await c.var.services.agents.get({ tenantId: t, agentId: id });
  if (!existing) return c.json({ error: "Agent not found" }, 404);

  const body = await c.req.json() as { /* same shape as today */ };

  // Validate model — uses `existing` for the fallback `effectiveModel`.
  if (body.model !== undefined || body.model_card_id !== undefined) {
    const effectiveModel = body.model ?? existing.model;
    const effectiveCardId = body.model_card_id === null
      ? undefined
      : (body.model_card_id ?? existing.model_card_id);
    const modelCheck = await validateModel(c.var.services, t, effectiveModel, effectiveCardId);
    if (!modelCheck.valid) return c.json({ error: modelCheck.error }, 400);
  }
  // (aux_model validation block stays the same — uses `existing` for fallback.)

  try {
    const updated = await c.var.services.agents.update({
      tenantId: t,
      agentId: id,
      input: {
        name: body.name,
        model: body.model,
        system: body.system,
        tools: body.tools,
        harness: body.harness,
        description: body.description,
        mcp_servers: body.mcp_servers,
        skills: body.skills,
        callable_agents: body.callable_agents,
        metadata: body.metadata,
        model_card_id: body.model_card_id,
        aux_model: body.aux_model,
        aux_model_card_id: body.aux_model_card_id,
        // appendable_prompts not in update payload today.
      },
      expectedVersion: body.version,
    });
    return c.json(formatAgent(updated));
  } catch (err) {
    if (err instanceof AgentVersionMismatchError) {
      return c.json({ error: "Version mismatch. Agent has been updated since you last read it." }, 409);
    }
    if (err instanceof AgentNotFoundError) {
      return c.json({ error: "Agent not found" }, 404);
    }
    throw err;
  }
};
```

Add the imports at the top of the file:

```ts
import { AgentNotFoundError, AgentVersionMismatchError } from "@open-managed-agents/agents-store";
```

#### GET `/:id/versions` — lines 283–301

```ts
const id = c.req.param("id");
const t = c.get("tenant_id");
const exists = await c.var.services.agents.get({ tenantId: t, agentId: id });
if (!exists) return c.json({ error: "Agent not found" }, 404);

const versions = await c.var.services.agents.listVersions({ tenantId: t, agentId: id });
// listVersions returns historical-only (versions 1..current-1) — already sorted ASC.
return c.json({ data: versions.map((v) => formatAgent(v.snapshot)) });
```

#### GET `/:id/versions/:version` — lines 304–311

```ts
const id = c.req.param("id");
const t = c.get("tenant_id");
const version = parseInt(c.req.param("version"), 10);
if (isNaN(version)) return c.json({ error: "Invalid version" }, 400);
const ver = await c.var.services.agents.getVersion({ tenantId: t, agentId: id, version });
if (!ver) return c.json({ error: "Version not found" }, 404);
return c.json(formatAgent(ver.snapshot));
```

#### POST `/:id/archive` — lines 313–324

```ts
try {
  const archived = await c.var.services.agents.archive({
    tenantId: c.get("tenant_id"),
    agentId: c.req.param("id"),
  });
  return c.json(formatAgent(archived));
} catch (err) {
  if (err instanceof AgentNotFoundError) return c.json({ error: "Agent not found" }, 404);
  throw err;
}
```

#### DELETE `/:id` — lines 326–357

The active-sessions + active-evals safety checks stay in this route file —
they query other services (sessions + evals). Replace just the `KV.get` +
`KV.delete` lines:

```ts
const id = c.req.param("id");
const t = c.get("tenant_id");
const existing = await c.var.services.agents.get({ tenantId: t, agentId: id });
if (!existing) return c.json({ error: "Agent not found" }, 404);

// (hasActiveSessions + hasActiveEvals checks stay AS IS — they're correct.)

await c.var.services.agents.delete({ tenantId: t, agentId: id });
return c.json({ type: "agent_deleted", id });
```

---

### 4b. `apps/main/src/routes/sessions.ts` — line 222

```ts
// Old:
//   const agentData = await c.env.CONFIG_KV.get(kvKey(t, "agent", body.agent));
//   if (!agentData) return c.json({ error: "Agent not found" }, 404);
//   const agentSnapshot = JSON.parse(agentData) as AgentConfig;
// New:
const agentSnapshot = await c.var.services.agents.get({ tenantId: t, agentId: body.agent });
if (!agentSnapshot) return c.json({ error: "Agent not found" }, 404);
```

`agentSnapshot` already has the right shape (extends `AgentConfig`). The
`tenant_id` field on the row is harmless for downstream consumers — they
already ignore unknown fields. If you want a strict pure-AgentConfig pass to
SessionDO, destructure: `const { tenant_id: _t, ...agentSnapshot } = row;`.

---

### 4c. `apps/main/src/routes/internal.ts` — line 120

```ts
// Old:
//   const agentData = await c.env.CONFIG_KV.get(kvKey(tenantId, "agent", body.agentId));
//   if (!agentData) return c.json({ error: "agent not found in tenant" }, 404);
//   let agentSnapshot = JSON.parse(agentData) as AgentConfig;
// New:
let agentSnapshot = await c.var.services.agents.get({
  tenantId,
  agentId: body.agentId,
});
if (!agentSnapshot) return c.json({ error: "agent not found in tenant" }, 404);
```

The downstream "spread + augment with mcp_servers" pattern is unchanged.

---

### 4d. `apps/main/src/routes/evals.ts` — line 91

```ts
// Old:
//   const [agentData, envData] = await Promise.all([
//     c.env.CONFIG_KV.get(kvKey(t, "agent", body.agent_id)),
//     c.env.CONFIG_KV.get(kvKey(t, "env", body.environment_id)),
//   ]);
//   if (!agentData) return c.json({ error: "Agent not found" }, 404);
// New:
const [agent, envData] = await Promise.all([
  c.var.services.agents.get({ tenantId: t, agentId: body.agent_id }),
  c.env.CONFIG_KV.get(kvKey(t, "env", body.environment_id)),     // env still KV
]);
if (!agent) return c.json({ error: "Agent not found" }, 404);
```

(Environments are the next migration — leave the env KV.get path alone.)

---

### 4e. `apps/main/src/eval-runner.ts` — line 143

```ts
// Old:
//   const agentData = await env.CONFIG_KV.get(kvKey(t, "agent", run.agent_id));
//   if (!agentData) throw new Error(`agent ${run.agent_id} not found`);
//   const agentSnapshot = JSON.parse(agentData) as AgentConfig;
// New:
const agentSnapshot = await getServices(env).agents.get({
  tenantId: t,
  agentId: run.agent_id,
});
if (!agentSnapshot) throw new Error(`agent ${run.agent_id} not found`);
```

`getServices(env)` is the cached holder already in eval-runner.ts:69-73 —
no new wiring needed.

---

### 4f. `apps/agent/src/runtime/session-do.ts` — line 181-187 (`getAgentConfig`)

Replace the CONFIG_KV fallback with the service:

```ts
private async getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  if (this.state.agent_snapshot && agentId === this.state.agent_id) {
    return this.state.agent_snapshot;
  }
  // Use getById — sandbox-default may not have a tenant context that matches
  // the agent's, but the DO already trusts its own session state. The service
  // handles cross-tenant lookups via the agents.id PRIMARY KEY.
  const services = buildCfServices(this.env);
  const row = await services.agents.getById({ agentId });
  if (!row) return null;
  // Strip tenant_id so the returned object is pure AgentConfig.
  const { tenant_id: _t, ...config } = row;
  return config;
}
```

Two callers to verify after the swap:
- session-do.ts:852 — main agent fetch at warmup
- session-do.ts:1442 — sub-agent (callable_agents) lookup
- session-do.ts:1562 — agent-as-tool dispatch

All three pass through `getAgentConfig` so the single change above covers them.

---

## 5. Schema decisions

- **Two-table approach**: `agents` (current state) + `agent_versions`
  (append-only history). Mirrors `memory_versions`. Picked over
  single-table-with-`is_current`-flag because:
  - Cleanest queries: current row is always one PK lookup; history is one
    indexed range scan.
  - No constraint maintenance: no need to enforce "exactly one current per
    id" via a partial UNIQUE.
  - Matches the legacy KV semantics 1:1 — `t:{t}:agent:{id}` → `agents`,
    `t:{t}:agent:{id}:v{N}` → `agent_versions`. Migration mental model is a
    direct translation with zero data restructuring.
- **`config` JSON column**: stores the FULL `AgentConfig` (incl. all the
  nested mcp_servers, skills, callable_agents, metadata, etc.). Hot fields
  surfaced as their own columns are: `tenant_id`, `version`, `created_at`,
  `updated_at`, `archived_at`. No other field is currently queried, so no
  more denormalization needed. (If a future feature needs "list agents by
  model_card_id" — e.g. cascade safety on model card delete — add a
  `model_card_id` column + index in a follow-up migration.)
- **Indexes**:
  - `idx_agents_tenant (tenant_id, archived_at)` — primary list path.
  - `idx_agent_versions_tenant_agent (tenant_id, agent_id, version)` —
    listVersions hot path + getVersion lookup.
- **No UNIQUE constraints**: `agents.id` is the PK. `(agent_id, version)`
  is the PK on `agent_versions` so duplicate-version inserts fail loudly
  (would only happen on a buggy concurrent update — can't happen via the
  service since update is gated on `requireAgent` + `expectedVersion`).
- **No FK constraints**: per project convention. Cascade-on-delete lives in
  `D1AgentRepo.deleteWithVersions` (D1.batch).
- **Archive coupling**: `archive()` writes `archived_at` AND mirrors it
  inside the `config` JSON, so consumers reading from the parsed config
  (e.g. `formatAgent` / SessionDO snapshot fallback) see a consistent
  value with the column-level filter.
- **`getById` cross-tenant**: needed for SessionDO's `getAgentConfig`
  fallback path. The DO trusts its own tenant_id state, but the cf-default
  binding may not always match — `getById` sidesteps the mismatch by
  hitting the `agents.id` PK directly.

---

## 6. Open questions

1. **`appendable_prompts` create payload**: today the `POST /v1/agents`
   handler doesn't accept `appendable_prompts` (it's set elsewhere — likely
   via the appendable-prompts service). The service's `NewAgentInput`
   accepts it for completeness, but the route swap leaves it `undefined`
   matching legacy behavior. Confirm during integration.

2. **`tools` default**: the create path defaults to
   `[{ type: "agent_toolset_20260401" }]` when caller passes no tools
   (mirrors agents.ts:125). I baked this into `service.create` so callers
   can drop the `tools: body.tools || [{ type: "agent_toolset_20260401" }]`
   line — pass `body.tools` straight through.

3. **`updated_at` on create**: the service stamps `updated_at = created_at`
   on insert. Legacy code did the same (agents.ts:138). If you'd prefer
   `null` until first update (matching credentials/sessions stores), say so
   and I'll flip it.

4. **`hasActiveByAgent` from sessions + evals**: I left those in the
   `routes/agents.ts` DELETE handler — they're correct as-is. The agents
   service does NOT own this cross-store check (agents service has no
   knowledge of sessions/evals). Route layer orchestrates.

5. **`tenant_id` in returned `AgentRow`**: `AgentRow = AgentConfig &
   { tenant_id: string }`. Most consumers don't care, but `formatAgent` in
   the route file currently spreads the agent and may surface `tenant_id`
   in the API response. Recommend: filter it out in `formatAgent`
   (`const { tenant_id: _t, ...rest } = agent`) to match the pre-migration
   wire format. Trivial follow-up — flag if you want me to handle.

6. **Snapshot timing on archive**: `archive()` does NOT write a history row
   (legacy behavior — archive at agents.ts:321 just toggled archived_at +
   bumped updated_at via the existing path; no snapshot was ever written).
   If you want archive to be a versioned event, say so and I'll add an
   `archiveWithSnapshot` variant. Default: keep legacy parity.

7. **Migration fold-in**: I wrote `0002_agents_tables.sql` per the
   instructions. When you fold into `0001_schema.sql`, place it next to
   the SESSIONS section (between SESSIONS and FILES) so the entity grouping
   stays alphabetical-ish. The contents are clean copy-paste — no
   transformation needed.
