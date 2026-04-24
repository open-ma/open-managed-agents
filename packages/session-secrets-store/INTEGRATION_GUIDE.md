# INTEGRATION_GUIDE.md — `@open-managed-agents/session-secrets-store`

Storage-port decoupling of the per-session, per-resource secret payloads
(`env_secret.value` and `github_repository.token`). The values stay in KV
under the same `t:{tenantId}:secret:{sessionId}:{resourceId}` keys; only
the *interface* moves behind a typed service. This guide lists every change
the integration step needs to wire the new service into the codebase.
Execute these mechanically.

---

## 0. Prereqs

- The package was added under `packages/session-secrets-store/`. Run
  `pnpm install` to materialize the workspace symlink, then add a workspace
  dependency line to:
  - `apps/main/package.json` →
    `"@open-managed-agents/session-secrets-store": "workspace:*"`
  - `apps/agent/package.json` → same
  - `packages/services/package.json` → same
- No DB migration: secrets stay in KV intentionally. SessionDO needs a
  read-only secret blob at session warmup and runs in a worker context that
  doesn't have full D1 bindings. See the package README "Why this stays
  in KV (intentional)".

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside the existing store imports):

```ts
import {
  SessionSecretService,
  createCfSessionSecretService,
} from "@open-managed-agents/session-secrets-store";
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
  sessionSecrets: SessionSecretService;   // ← add
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
    sessionSecrets: createCfSessionSecretService(env),   // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/session-secrets-store/test-fakes": "./packages/session-secrets-store/src/test-fakes.ts",
"@open-managed-agents/session-secrets-store": "./packages/session-secrets-store/src/index.ts",
```

---

## 3. `test/test-worker.ts` — no migration needed

KV-only store; nothing to add to `MIGRATIONS_RAW`. Skip this step.

---

## 4. Route + DO switches — every site that touches `secret:` KV

Each row gives: file path + line number + the **before** pattern to match +
the **after** replacement. All HTTP routes use
`c.var.services.sessionSecrets.<method>`. SessionDO uses
`buildCfServices(this.env).sessionSecrets.<method>` (or pre-builds once;
SessionDO already does `buildCfServices(this.env)` on the surrounding line).

### 4a. `apps/main/src/routes/sessions.ts`

#### Line 373 — env_secret resource creation

```ts
// Before:
await c.env.CONFIG_KV.put(kvKey(t, "secret", sessionId, created.id), res.value);

// After:
await c.var.services.sessionSecrets.put({
  tenantId: t,
  sessionId,
  resourceId: created.id,
  value: res.value,
});
```

#### Line 383 — github_repository resource creation

```ts
// Before:
await c.env.CONFIG_KV.put(kvKey(t, "secret", sessionId, created.id), token);

// After:
await c.var.services.sessionSecrets.put({
  tenantId: t,
  sessionId,
  resourceId: created.id,
  value: token,
});
```

#### Lines 604-605 — session.delete cascade

```ts
// Before:
const secretKeys = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "secret", id));
await Promise.all(secretKeys.map((k) => c.env.CONFIG_KV.delete(k.name)));

// After (one call; the adapter does the paginated KV.list internally):
await c.var.services.sessionSecrets.deleteAllForSession({
  tenantId: t,
  sessionId: id,
});
```

#### Line 1031 — single-resource delete

```ts
// Before:
await c.env.CONFIG_KV.delete(kvKey(t, "secret", sessionId, resourceId));

// After:
await c.var.services.sessionSecrets.deleteOne({
  tenantId: t,
  sessionId,
  resourceId,
});
```

#### Drop now-unused imports

If sessions.ts no longer uses `kvPrefix` / `kvListAll` after the four
swaps above (check with `grep -n` for other usages first — line 17 has
`import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";`), trim the
import to just what's still used. As of this guide's authoring `kvKey`
is still needed for `agent` / `env` reads at lines 222, 233, 874 (those
move under their own future stores), but `kvPrefix` + `kvListAll` are
secrets-only and can go.

### 4b. `apps/main/src/routes/internal.ts`

#### Lines 312-315 — Linear bot github_repository ingestion

```ts
// Before:
// Token continues to live in CONFIG_KV under `secret:{sessionId}:{resourceId}`.
await c.env.CONFIG_KV.put(
  kvKey(tenantId, "secret", sessionId, added.id),
  ghToken,
);

// After:
// Token continues to live in the per-session secret store, fronted by the
// session-secrets-store service. The KV layout is unchanged; the service
// owns the key format internally.
await c.var.services.sessionSecrets.put({
  tenantId,
  sessionId,
  resourceId: added.id,
  value: ghToken,
});
```

This route imports `kvKey` from `../kv-helpers` — confirm whether other
sites in the same file still need it before trimming.

### 4c. `apps/agent/src/runtime/session-do.ts`

#### Line 974 — SessionDO loading secrets at session warmup

The surrounding code (lines 965-987) already builds `services` via
`buildCfServices(this.env)` on line 965, so the swap is a one-liner:

```ts
// Before:
const secretData = await this.env.CONFIG_KV.get(this.tk("secret", sessionId, row.id));

// After (uses the already-built `services` from line 965):
const secretData = await services.sessionSecrets.get({
  tenantId: this.state.tenant_id,
  sessionId,
  resourceId: row.id,
});
```

The `tk("secret", ...)` helper call disappears here. `tk` is still used
elsewhere in the file (lines 185, 194, 218, 1286 for `agent` / `env` /
`cred` keys) so leave the helper itself in place.

---

## 5. Verifying nothing else writes to `secret:` KV

After the six swaps above, this should return zero hits:

```sh
grep -rn 'kvKey.*"secret"\|kvPrefix.*"secret"\|tk("secret"' apps/ packages/
```

If anything remains, route it through `services.sessionSecrets` the same way.

---

## 6. Schema decisions

- **Stays in KV** by design: SessionDO at warmup needs a small read-only
  secret view inside a worker context that historically hasn't had full D1
  bindings. KV is the right shape for "session-scoped read-only secret
  blob". The interface is decoupled so a future Redis / per-tenant KV /
  Postgres-pgcrypto adapter can swap behind `SessionSecretRepo` without
  touching consumer code.
- **No FK constraints**: KV anyway, and per project convention cascade
  lives in the application layer. `deleteAllForSession` walks the
  prefix — adapter implementation, not a database constraint.
- **Key format owned by the adapter**: the `t:{tenantId}:secret:{sessionId}:{resourceId}`
  layout lives in `KvSessionSecretRepo.keyFor` / `prefixFor`. No
  consumer code references the format string.
- **`deleteAllForSession` is paginated**: KV.list returns at most 1000
  keys per call. The adapter follows the cursor (`page.list_complete`)
  until exhausted, deleting each page in parallel.
- **Last-writer-wins on `put`**: matches the previous KV.put semantics. No
  conflict detection — secrets are written exactly once at resource
  create time and never updated in place.

---

## 7. Open questions

1. **Eventual consistency on cascade delete**: `deleteAllForSession` walks
   `KV.list({ prefix })` which is eventually consistent. For session
   teardown this is fine — the session row is already gone, no consumer
   is concurrently inserting more secrets. If you ever expose a
   "drop secrets for a still-active session" path, callers should expect
   that a secret put&lt;1s before the cascade may survive. Today no such
   path exists.

2. **No typed errors**: `errors.ts` is empty by design. Every method
   either succeeds, returns null (`get` on miss), or returns a count
   (`deleteAllForSession`). If a future consumer needs to distinguish
   "not found" from "store unavailable", add a typed error here and
   surface it from the adapter.

3. **`createCfSessionSecretService` accepts `Pick<Env, "CONFIG_KV">`**
   rather than the full `Env` to make the dependency explicit and to
   simplify test wiring (mock object only needs `CONFIG_KV`). The
   buildCfServices factory passes the full `Env` — the `Pick` just
   narrows the contract.
