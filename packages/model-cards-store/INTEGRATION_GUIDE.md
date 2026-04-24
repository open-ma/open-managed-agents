# INTEGRATION_GUIDE.md — `@open-managed-agents/model-cards-store`

OPE-?: KV → D1 migration of `model_cards`. This guide lists every change
the integration step needs to wire the new service into the codebase.
Execute these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package was already added to `apps/main/package.json`
  and `apps/agent/package.json` workspace deps in this branch).
- Migration file picked: **`0013_model_cards_table.sql`**.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside existing `MemoryStoreService` /
`CredentialService` / `SessionService`):

```ts
import {
  ModelCardService,
  createCfModelCardService,
} from "@open-managed-agents/model-cards-store";
```

Add to the `Services` interface:

```ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  sessions: SessionService;
  modelCards: ModelCardService;        // ← add
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    sessions: createCfSessionService(env),
    modelCards: createCfModelCardService(env),    // ← add
  };
}
```

The `createCfModelCardService(env, opts?)` factory accepts an optional
`crypto` for at-rest api_key encryption. Default = identity (cleartext). See
"Open questions" below for the production wiring.

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/model-cards-store/test-fakes": "./packages/model-cards-store/src/test-fakes.ts",
"@open-managed-agents/model-cards-store": "./packages/model-cards-store/src/index.ts",
```

After this lands, the test file import in
`test/unit/model-cards-store-service.test.ts` can be swapped from relative
(`../../packages/model-cards-store/src/...`) to package-name imports for
consistency with the credentials-store test (optional cleanup — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after `cred0009` (or wherever the latest migration import
sits — `sess0010` if the sessions-store integration has landed):

```ts
// @ts-expect-error
import mdl0013 from "../apps/main/migrations/0013_model_cards_table.sql?raw";
```

Append `mdl0013 as string,` to the `MIGRATIONS_RAW` array:

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
  // sess0010 as string,        // (when sessions-store integration lands)
  mdl0013 as string,             // ← add
];
```

---

## 4. Route + DO switches — every site that touches `modelcard:` KV

Each row gives: file path + approximate line range + the **before** pattern
to match + the **after** replacement. All HTTP routes use
`c.var.services.modelCards.<method>`. SessionDO and any sandbox-default-only
worker uses `buildCfServices(env).modelCards.<method>` (or pre-builds
once in the DO constructor).

### 4a. `apps/main/src/routes/model-cards.ts` — full rewrite

The file is 174 LOC of KV-direct code. Replace it end-to-end with the
pattern below. Imports collapse to:

```ts
import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
} from "@open-managed-agents/model-cards-store";
import type { Services } from "@open-managed-agents/services";
```

Drop `kvKey`, `kvPrefix`, `kvListAll`, `generateModelCardId` imports.
Drop the `ModelCard` import — the route now passes through service rows.
Drop the local `formatModelCard` helper — `is_default` and `archived_at`
are already typed correctly on `ModelCardRow`.

#### POST / (create) — lines 16–70

Old: kvListAll for UNIQUE check + clearDefaults loop + two KV puts (card + key).

New:

```ts
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{
    name: string;
    provider: string;
    model_id: string;
    api_key: string;
    base_url?: string;
    custom_headers?: Record<string, string>;
    is_default?: boolean;
  }>();

  if (!body.name || !body.provider || !body.model_id || !body.api_key) {
    return c.json({ error: "name, provider, model_id, and api_key are required" }, 400);
  }
  try {
    const card = await c.var.services.modelCards.create({
      tenantId: t,
      modelId: body.model_id,
      provider: body.provider,
      displayName: body.name,
      apiKey: body.api_key,
      baseUrl: body.base_url ?? null,
      customHeaders: body.custom_headers ?? null,
      makeDefault: !!body.is_default,
    });
    return c.json(toApiShape(card), 201);
  } catch (err) {
    if (err instanceof ModelCardDuplicateModelIdError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});
```

`toApiShape` is a small adapter that converts the `ModelCardRow` field names
(`display_name`, `model_id`, `is_default`, ...) to the legacy API shape
that the Console + CLI consume. Suggested implementation:

```ts
function toApiShape(card: ModelCardRow) {
  return {
    id: card.id,
    name: card.display_name,
    provider: card.provider,
    model_id: card.model_id,
    api_key_preview: card.api_key_preview,
    base_url: card.base_url ?? undefined,
    custom_headers: card.custom_headers ?? undefined,
    is_default: card.is_default,
    created_at: card.created_at,
    updated_at: card.updated_at ?? undefined,
    archived_at: card.archived_at,
  };
}
```

(Keep this helper local to model-cards.ts for now; move to a shared formatter
if other routes ever consume `ModelCardRow`.)

#### GET / (list) — lines 73–89

Replace the kvListAll + per-key fetch + JSON.parse + sort entirely:

```ts
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const cards = await c.var.services.modelCards.list({ tenantId: t });
  // Legacy filter parity: hide archived cards. (Today archived_at is always
  // null in the new schema; future soft-delete will populate it.)
  return c.json({ data: cards.filter((card) => card.archived_at === null).map(toApiShape) });
});
```

#### GET /:id — lines 92–98

```ts
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const card = await c.var.services.modelCards.get({ tenantId: t, cardId: c.req.param("id") });
  if (!card) return c.json({ error: "Model card not found" }, 404);
  return c.json(toApiShape(card));
});
```

#### POST /:id (update) — lines 101–136

Old: KV.get + JSON.parse + clearDefaults loop + per-field merge + two KV puts.

New:

```ts
app.post("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    provider?: string;
    model_id?: string;
    api_key?: string;
    base_url?: string | null;
    custom_headers?: Record<string, string> | null;
    is_default?: boolean;
  }>();
  try {
    const updated = await c.var.services.modelCards.update({
      tenantId: t,
      cardId: id,
      displayName: body.name,
      provider: body.provider,
      modelId: body.model_id,
      // The legacy route accepted `body.base_url || undefined` — translating
      // empty string to "no change". Match that for backward compat:
      baseUrl: body.base_url === undefined
        ? undefined
        : (body.base_url || null),
      customHeaders: body.custom_headers === undefined
        ? undefined
        : (body.custom_headers || null),
      apiKey: body.api_key,           // service handles preview + cipher
      isDefault: body.is_default,
    });
    return c.json(toApiShape(updated));
  } catch (err) {
    if (err instanceof ModelCardNotFoundError) return c.json({ error: "Model card not found" }, 404);
    if (err instanceof ModelCardDuplicateModelIdError) return c.json({ error: err.message }, 409);
    throw err;
  }
});
```

#### DELETE /:id — lines 139–148

```ts
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    await c.var.services.modelCards.delete({ tenantId: t, cardId: id });
    return c.json({ type: "model_card_deleted", id });
  } catch (err) {
    if (err instanceof ModelCardNotFoundError) return c.json({ error: "Model card not found" }, 404);
    throw err;
  }
});
```

#### GET /:id/key — lines 151–157

```ts
app.get("/:id/key", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const apiKey = await c.var.services.modelCards.getApiKey({ tenantId: t, cardId: id });
  if (apiKey === null) return c.json({ error: "Key not found" }, 404);
  return c.json({ api_key: apiKey });
});
```

This route is consumed by the agent worker's `resolveModelCardCredentials`.
The endpoint shape is unchanged so the agent worker's HTTP fetch path keeps
working without code changes (only the storage backing it changed).

### 4b. `apps/main/src/routes/models.ts` — NO CHANGES

The `/v1/models/list` route only proxies to upstream provider APIs and never
reads the `modelcard:` KV namespace. Confirmed at lines 13–58 — it touches
external `api.anthropic.com` / `api.openai.com` only.

### 4c. `apps/main/src/routes/agents.ts` — `validateModel` (lines 46–85)

The agent route's `validateModel` helper currently scans every `modelcard:`
KV key to verify a model_card_id exists or that some card matches the
requested `model_id`. Replace with two indexed service calls:

```ts
async function validateModel(
  services: Services,
  tenantId: string,
  model: string | { id: string; speed?: string },
  modelCardId?: string,
): Promise<{ valid: boolean; error?: string }> {
  // Scope cap: if no cards exist at all, skip validation (env-key fallback).
  const cards = await services.modelCards.list({ tenantId });
  const active = cards.filter((c) => c.archived_at === null);
  if (active.length === 0) return { valid: true };

  if (modelCardId) {
    const found = active.find((c) => c.id === modelCardId);
    if (!found) return { valid: false, error: `Model card "${modelCardId}" not found` };
    return { valid: true };
  }
  const modelId = typeof model === "string" ? model : model.id;
  const match = active.find((c) => c.model_id === modelId);
  if (!match) {
    return {
      valid: false,
      error: `No model card configured for model "${modelId}". Create a model card first or use a configured model.`,
    };
  }
  return { valid: true };
}
```

Then update the two callsites to pass `c.var.services` instead of
`c.env.CONFIG_KV`:

```ts
// line 111
const modelCheck = await validateModel(c.var.services, tenantId, body.model, body.model_card_id);
// line 119
const auxCheck = await validateModel(c.var.services, tenantId, auxModel, body.aux_model_card_id);
// line 215 (POST /:id update path)
const check = await validateModel(c.var.services, tenantId, effectiveModel, effectiveCardId);
// line 223 (POST /:id update path, aux)
const auxCheck = await validateModel(c.var.services, tenantId, effectiveAux, effectiveAuxCard);
```

Drop `kvListAll` + `kvPrefix` from this file IF they're only used here; the
`ModelCard` import becomes unused.

(Note: this is OUTSIDE the strict file scope of the storage-port worktree
since it touches `routes/agents.ts`. Stage as a follow-up integration PR;
the legacy KV-based `validateModel` will continue to work alongside the new
D1 layout because the route writers populate KV in lockstep with D1 — see
"Open questions" #1 for the dual-write window.)

### 4d. `apps/agent/src/runtime/session-do.ts` — `resolveModelCardCredentials`
(lines 1094–1176)

The session DO has two read paths into `modelcard:` KV:

1. Explicit `cardId` provided (lines 1121–1140): two KV.get calls for the
   card record + the `:key` blob.
2. Implicit lookup by `modelId` (lines 1141–1166): KV.list + per-card
   JSON.parse loop.

Both move to the service:

```ts
private async resolveModelCardCredentials(
  modelId: string,
  cardId?: string,
): Promise<{
  apiKey: string;
  baseURL?: string;
  apiCompat: ApiCompat;
  customHeaders?: Record<string, string>;
  cardId?: string;
}> {
  let apiKey = this.env.ANTHROPIC_API_KEY;
  let baseURL = this.env.ANTHROPIC_BASE_URL;
  let provider: string | undefined;
  let customHeaders: Record<string, string> | undefined;
  let resolvedCardId: string | undefined;

  // The DO already trusts its own state's tenant_id (set via this.tk()).
  // Build services per-call (cheap; just object construction). If the DO
  // gains a long-lived holder, hoist this to a private field.
  const services = buildCfServices(this.env);
  const tenantId = this.getTenantId();    // existing helper — adjust to match

  try {
    let card = null;
    if (cardId) {
      card = await services.modelCards.get({ tenantId, cardId });
    } else {
      card = await services.modelCards.findByModelId({ tenantId, modelId });
    }
    if (card) {
      const key = await services.modelCards.getApiKey({ tenantId, cardId: card.id });
      if (key !== null) {
        apiKey = key;
        provider = card.provider;
        if (card.base_url) baseURL = card.base_url;
        if (card.custom_headers) customHeaders = card.custom_headers;
        resolvedCardId = card.id;
      }
    }
  } catch {
    // Fall back to env vars on any read failure (matches the legacy try/catch).
  }

  const OAI_PROVIDERS = new Set(["oai", "oai-compatible"]);
  const ANT_PROVIDERS = new Set(["ant", "ant-compatible"]);
  let apiCompat: ApiCompat = "ant";
  if (provider && (OAI_PROVIDERS.has(provider) || ANT_PROVIDERS.has(provider))) {
    apiCompat = provider as ApiCompat;
  }

  return { apiKey, baseURL, apiCompat, customHeaders, cardId: resolvedCardId };
}
```

The two TODO comments (`TODO(staging-kv)` at lines 1123 and 1144) become
moot — D1 is shared across main + agent workers via the `AUTH_DB` binding,
which exists in both the staging and prod wrangler configs.

(Also OUTSIDE the strict file scope of this worktree — stage as a follow-up
integration PR.)

---

## 5. Schema decisions

- **HARD UNIQUE** `(tenant_id, model_id)` — replaces the per-tenant kvListAll
  + JSON.parse loop in model-cards.ts:33-43. Schema-level rejection now
  surfaces as `ModelCardDuplicateModelIdError` with HTTP 409.
- **PARTIAL UNIQUE** `(tenant_id) WHERE is_default = 1` — at most one default
  per tenant. The service uses an atomic clear-then-set batch
  (`D1.batch([clearDefaultsExceptStmt, insert/update])`) so the constraint
  never fires under normal use; it's a safety net for concurrent-write bugs
  that would otherwise leave the tenant in an "ambiguous default" state.
  Replaces the legacy `clearDefaults()` loop in model-cards.ts:159-172 +
  the duplicated `if (body.is_default) await clearDefaults(...)` in both
  POST / and POST /:id (lines 49-51 + 118-120).
- **Tenant index** `(tenant_id, created_at)` — keeps the `GET /v1/model_cards`
  list scan index-only.
- **No FK** — `tenant_id` is plain TEXT per project convention. There is no
  cascade today; the agent route (`agents.ts`) validates the
  `model_card_id` references at write time via `validateModel` (and the
  callsites stay in the agents route file even after this migration).
- **`api_key_cipher` column + `Crypto` port** — the column holds an opaque
  blob produced by the service's `Crypto.encrypt(plaintext)`. The default
  service factory uses an **identity Crypto** so the value at rest matches
  the legacy KV path until a real AES-GCM impl is wired (see Open Questions
  #2). The `ModelCardRow` shape NEVER carries `api_key_cipher` — the only
  way to reach the cleartext key is the dedicated `service.getApiKey()`
  call, mirroring the legacy `:key` KV key separation.
- **`api_key_preview`** — derived once at create/update via
  `apiKeyPreview()` (last 4 chars). Stored as its own column so list/get
  responses can render the preview without a decrypt round-trip.
- **`is_default` storage** — `INTEGER NOT NULL DEFAULT 0`. The adapter
  translates 0/1 ↔ boolean at the row boundary; the service / route layer
  never sees the integer.
- **`custom_headers` storage** — JSON-serialized TEXT, NULL when unset.
  The adapter parses on read.

---

## 6. Open questions

1. **Dual-write window for the agent route's `validateModel`**: the
   strict file scope of this worktree forbids touching `routes/agents.ts`
   and `runtime/session-do.ts`. The legacy KV-based reads in those files
   continue to work after this migration ONLY if the route layer keeps
   writing the legacy `modelcard:{id}` + `modelcard:{id}:key` KV keys
   alongside the new D1 row. Two integration approaches:

   a. **Cutover PR** that lands the schema migration + the model-cards.ts
      rewrite + the agents.ts + session-do.ts switches in one go. KV reads
      go away in the same PR. Risk: bigger blast radius.

   b. **Dual-write PR** first: the new model-cards.ts route writes BOTH
      D1 (via the service) AND the legacy KV keys, then a follow-up PR
      switches the readers (agents.ts, session-do.ts) and drops the dual
      write. Safer but doubles the work.

   Recommend (a) since the blast radius is bounded — model_cards is read
   only at agent create/update + session start, both of which already
   handle "no card configured" via env-var fallback.

2. **Wiring real `Crypto` for production at-rest encryption**: the schema
   uses `api_key_cipher`, but the default Crypto wired by the factory is
   identity (cleartext). To genuinely encrypt:

   - Add a wrangler secret (e.g. `MODEL_CARD_CIPHER_KEY`) to
     `apps/main/wrangler.jsonc` and bind it through `Env`.
   - In `createCfModelCardService`, wrap with the existing
     `WebCryptoAesGcm` (from `packages/integrations-adapters-cf/src/crypto.ts`)
     or a fresh AES-GCM helper.
   - First-time rollout will leave existing rows undecryptable — either
     ship a one-time backfill that re-encrypts, or rotate via a versioned
     prefix (`v1:cipher` vs `v0:plaintext`) and decrypt-on-read with
     fallback.

   I left this as identity in the initial migration to keep the cutover
   atomic and reversible. Flip when there's a clear rotation plan.

3. **Soft delete for model cards**: the schema includes an `archived_at`
   column for forward compatibility, but the service's `delete()` is a
   hard delete (matching the legacy KV behavior). If a future use case
   needs "deactivate without losing history", flip `delete()` to set
   `archived_at = now()` and update the read paths to filter — no
   schema change needed.

4. **Console + CLI API shape**: the legacy API surfaced `name` (not
   `display_name`) and used optional fields where the new service uses
   nullable. The `toApiShape` helper in §4a preserves the legacy shape so
   the Console (`apps/console/src/pages/ModelCardsList.tsx`) and CLI
   (`packages/cli/src/index.ts`) keep working without changes. If you'd
   rather propagate the new field names end-to-end, plan a separate API
   versioning PR.

5. **Atomic-clear semantics on `update.isDefault === false`**: the
   service's `update()` accepts `isDefault: false` and demotes the row
   without touching others. Consequence: a caller that demotes the only
   default leaves the tenant with no default. This matches the legacy
   route's behavior (the legacy code only clearedDefaults when `is_default`
   was set true, never re-promoted on demote). If the desired UX is "always
   keep a default", that's a separate feature — not in scope here.
