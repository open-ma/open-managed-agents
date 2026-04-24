# INTEGRATION_GUIDE.md — `@open-managed-agents/outbound-snapshots-store`

Ports/Adapters refactor of the per-session outbound credential snapshot KV
write. The snapshot is the untenanted blob keyed `outbound:{sessionId}` that
the outbound MITM worker (`apps/agent/src/outbound.ts`) reads to inject
Authorization headers into the sandbox container's HTTPS calls. SessionDO
publishes it at `/init`, deletes it at `/destroy`, and the outbound worker
rewrites it in place after a successful OAuth refresh.

This guide lists every change the integration step needs to wire the new
service into the codebase. Execute these mechanically.

---

## 0. Prereqs

- Add the package to `apps/agent/package.json` workspace deps:

  ```jsonc
  "@open-managed-agents/outbound-snapshots-store": "workspace:*"
  ```

  Then run `pnpm install`.

- No migration — this is a KV-backed adapter, not a D1 store.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside the existing store imports):

```ts
import {
  OutboundSnapshotService,
  createCfOutboundSnapshotService,
} from "@open-managed-agents/outbound-snapshots-store";
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
  outboundSnapshots: OutboundSnapshotService;   // ← add
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
    outboundSnapshots: createCfOutboundSnapshotService(env),   // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/outbound-snapshots-store/test-fakes": "./packages/outbound-snapshots-store/src/test-fakes.ts",
"@open-managed-agents/outbound-snapshots-store": "./packages/outbound-snapshots-store/src/index.ts",
```

---

## 3. `test/test-worker.ts` — no migration needed

This store is KV-backed. There is nothing to import into `MIGRATIONS_RAW`.

If a future test wires the in-memory adapter, swap to:

```ts
import { createInMemoryOutboundSnapshotService } from "@open-managed-agents/outbound-snapshots-store/test-fakes";
```

---

## 4. Call site switches — every site that touches `outbound:{sessionId}` KV

Two files: `apps/agent/src/runtime/session-do.ts` and
`apps/agent/src/outbound.ts`. Each row gives: file path + line range + the
**before** pattern + the **after** replacement.

### 4a. `apps/agent/src/runtime/session-do.ts`

#### Drop the inline TTL constant — line 132

```ts
// Old:
const OUTBOUND_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;

// New:
import { DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS } from "@open-managed-agents/outbound-snapshots-store";
// (and drop the local constant; the imported default is the canonical value)
```

The DO should already have `buildCfServices(this.env)` somewhere (per the
sessions-store integration). If not, build it once in the DO constructor or
cache it lazily.

#### POST /init publish — lines 469-479

```ts
// Old:
await this.env.CONFIG_KV.put(
  `outbound:${params.session_id}`,
  JSON.stringify({
    tenant_id: params.tenant_id,
    vault_ids: params.vault_ids ?? [],
    vault_credentials: params.vault_credentials,
  }),
  { expirationTtl: OUTBOUND_SNAPSHOT_TTL_SECONDS },
);

// New:
await services.outboundSnapshots.publish({
  sessionId: params.session_id,
  snapshot: {
    tenant_id: params.tenant_id,
    vault_ids: params.vault_ids ?? [],
    vault_credentials: params.vault_credentials,
  },
});
```

The default TTL is applied automatically by the service. If you want to
override it (e.g. shorter window for an eval session), pass `ttlSeconds: N`.

#### DELETE /destroy cleanup — lines 521-525

```ts
// Old:
if (this.state.session_id && this.env.CONFIG_KV) {
  try {
    await this.env.CONFIG_KV.delete(`outbound:${this.state.session_id}`);
  } catch {}
}

// New:
if (this.state.session_id) {
  try {
    await services.outboundSnapshots.delete({ sessionId: this.state.session_id });
  } catch {}
}
```

The `env.CONFIG_KV` truthiness guard goes away — the service is constructed
once at DO scope and is always present. The try/catch stays: destroy must
never fail because of a best-effort cleanup.

### 4b. `apps/agent/src/outbound.ts`

#### Drop the inline `OutboundSnapshot` type + helper — lines 18-38, 145-153

Remove the local `interface OutboundSnapshot { ... }` declaration and import
the canonical one:

```ts
import {
  type OutboundSnapshot,
  DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS,
  createCfOutboundSnapshotService,
} from "@open-managed-agents/outbound-snapshots-store";
```

The `loadSnapshot` helper (lines 145-153) is replaced by a single service
call at each call site. Drop the helper entirely.

#### Read snapshot in `findCredentialForHost` — line 116

```ts
// Old:
const snapshot = await loadSnapshot(env, sessionId);

// New:
const snapshot = await createCfOutboundSnapshotService(env).get({ sessionId });
```

(Or build `services` once at the top of the file via `buildCfServices(env)`
and use `services.outboundSnapshots.get(...)` for symmetry with the rest of
the worker. Per-call construction is cheap.)

#### Read snapshot in `tryRefreshToken` — line 168

Same swap as above.

#### Write refreshed snapshot back — lines 208-210

```ts
// Old:
await env.CONFIG_KV.put(`outbound:${sessionId}`, JSON.stringify(snapshot), {
  expirationTtl: 24 * 60 * 60,
});

// New:
await createCfOutboundSnapshotService(env).publish({
  sessionId,
  snapshot,
});
```

The 24h TTL is applied by default — drop the inline constant. If the worker
ever needs a different window for refresh writes vs. init writes, pass
`ttlSeconds` explicitly.

### 4c. Other consumers — none

`grep -rn '"outbound:"' apps/ packages/` should return only the four sites
above. No other route, DO, or worker references the `outbound:` KV layout.

---

## 5. Decisions

- **Untenanted key**: the snapshot is keyed by `sessionId` alone — no tenant
  prefix. The outbound worker only knows `sessionId` from the container
  context. This is preserved verbatim by the adapter (`outbound:${sessionId}`).
- **TTL default**: 24h, exported as `DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS`.
  Bounds the leak window for plaintext OAuth material when SessionDO's
  explicit `/destroy` cleanup doesn't run (DO eviction, sandbox crash).
- **No FK / no D1**: the snapshot is a transient cache, not a record of
  truth. The canonical credentials live in the `credentials` D1 table; this
  package only ever stores the per-session view.
- **Service is intentionally thin**: no business logic beyond the TTL
  default. The value of the package is the port boundary + adapter swap, not
  domain rules. Future adapters (Redis, Postgres, in-memory) plug in without
  touching SessionDO or the outbound worker.
- **Malformed payloads return null**: the KV adapter swallows `JSON.parse`
  errors and returns null on `get`, matching the previous outbound.ts
  `loadSnapshot` behavior. A poisoned snapshot is treated as a cache miss —
  the request passes through without injection rather than 500ing.

---

## 6. Open questions

1. **Per-session TTL override**: I exposed `ttlSeconds` on `publish` for the
   eval-runner case where the harness may want a shorter leak window
   (e.g. 1h for ephemeral eval sessions). No current caller uses it.
2. **Cross-tenant verification**: there is none — the snapshot is by design
   keyed only by `sessionId`. A caller that knows a `sessionId` can read its
   snapshot. This matches the previous KV behavior; the snapshot is already
   internal to the agent worker (no public route exposes it).
3. **`buildCfServices(env)` per call vs. cached**: outbound.ts is hot path.
   If you measure a hotspot from per-call service construction, cache one
   instance at module scope. For now per-call is fine and matches the
   sessions-store integration's eval-runner pattern.
