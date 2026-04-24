# vaults-store Integration Guide

This package replaces the KV-based vault CRUD in `apps/main/src/routes/vaults.ts` and `apps/main/src/routes/internal.ts` with a D1-backed `VaultService` reachable through the `Services` container.

Vaults are intentionally minimal — credentials live in `packages/credentials-store` and are cascaded by the route handler (vaults-store doesn't know about credentials). The CASCADE NOTE in `src/types.ts` documents this contract.

## 1. Services interface addition

In `packages/services/src/index.ts`:

```ts
// Add to imports:
import {
  VaultService,
  createCfVaultService,
} from "@open-managed-agents/vaults-store";

// Add to the Services interface:
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  vaults: VaultService;     // ← new
}

// Add to buildCfServices:
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    vaults: createCfVaultService(env),     // ← new
  };
}
```

## 2. vitest alias

Already added in this commit (the test had to run somehow):

```ts
// vitest.config.ts resolve.alias
"@open-managed-agents/vaults-store/test-fakes": "./packages/vaults-store/src/test-fakes.ts",
"@open-managed-agents/vaults-store": "./packages/vaults-store/src/index.ts",
```

## 3. test-worker.ts migration import

Add at the top with the other imports:
```ts
// @ts-expect-error
import vaults0014 from "../apps/main/migrations/0014_vaults_table.sql?raw";
```

And push into MIGRATIONS_RAW:
```ts
const MIGRATIONS_RAW: string[] = [
  // ... existing
  vaults0014 as string,
];
```

## 4. Workspace deps

Already added in this commit to `apps/main/package.json` and `apps/agent/package.json` (the latter for symmetry — the agent worker doesn't read vaults today, but the `Services` container is whole-cloth so apps that import `buildCfServices` get every dep).

```json
"@open-managed-agents/vaults-store": "workspace:*",
```

## 5. Route switch instructions

### apps/main/src/routes/vaults.ts

The vault CRUD section (lines 60-140 in the current file). Switch every KV access to `c.var.services.vaults.<method>`. The credential routes below stay unchanged (they already use `c.var.services.credentials`).

**Lines to change (current code → new code)**:

```ts
// Line 67-73 (POST / — create vault)
// BEFORE:
  const vault: VaultConfig = {
    id: generateVaultId(),
    name: body.name,
    created_at: new Date().toISOString(),
  };
  await c.env.CONFIG_KV.put(kvKey(t, "vault", vault.id), JSON.stringify(vault));
  return c.json(vault, 201);
// AFTER:
  const vault = await c.var.services.vaults.create({
    tenantId: t,
    name: body.name,
  });
  return c.json(vault, 201);

// Line 80-95 (GET / — list vaults)
// BEFORE: kvListAll + filter on `:cred` substring + JSON.parse loop
// AFTER:
  const includeArchived = c.req.query("include_archived") === "true";
  const data = await c.var.services.vaults.list({ tenantId: t, includeArchived });
  return c.json({ data });

// Line 102-107 (GET /:id)
// BEFORE: CONFIG_KV.get + JSON.parse
// AFTER:
  const vault = await c.var.services.vaults.get({ tenantId: t, vaultId: id });
  if (!vault) return c.json({ error: "Vault not found" }, 404);
  return c.json(vault);

// Line 111-126 (POST /:id/archive)
// BEFORE: CONFIG_KV.get + JSON.parse + mutate + put
// AFTER:
  try {
    const vault = await c.var.services.vaults.archive({ tenantId: t, vaultId: id });
    // Cascade — single SQL UPDATE on credentials (already wired)
    await c.var.services.credentials.archiveByVault({ tenantId: t, vaultId: id });
    return c.json(vault);
  } catch (err) {
    return handleVaultError(err);  // see below
  }

// Line 134-140 (DELETE /:id)
// BEFORE: CONFIG_KV.get + CONFIG_KV.delete
// AFTER:
  try {
    await c.var.services.vaults.delete({ tenantId: t, vaultId: id });
    return c.json({ type: "vault_deleted", id });
  } catch (err) {
    return handleVaultError(err);
  }

// Lines 149 + 178 (vault existence check before credential ops)
// BEFORE:
//   const vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId));
//   if (!vaultData) return c.json({ error: "Vault not found" }, 404);
// AFTER:
  if (!(await c.var.services.vaults.exists({ tenantId: t, vaultId }))) {
    return c.json({ error: "Vault not found" }, 404);
  }
```

Add a `handleVaultError` helper next to `handleCredError`:

```ts
import { VaultNotFoundError } from "@open-managed-agents/vaults-store";

function handleVaultError(err: unknown): Response {
  if (err instanceof VaultNotFoundError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  throw err;
}
```

### apps/main/src/routes/internal.ts

Two `add_static_bearer` / `add_command_secret` paths create vaults inline (lines 425-444 + 459-475). Switch each:

```ts
// BEFORE:
  let vaultId = body.vaultId;
  if (!vaultId) {
    const vault: VaultConfig = {
      id: generateVaultId(),
      name: body.vaultName,
      created_at: new Date().toISOString(),
    };
    await c.env.CONFIG_KV.put(kvKey(tenantId, "vault", vault.id), JSON.stringify(vault));
    vaultId = vault.id;
  } else {
    const existing = await c.env.CONFIG_KV.get(kvKey(tenantId, "vault", vaultId));
    if (!existing) return c.json({ error: "vault not found in tenant" }, 404);
  }

// AFTER:
  let vaultId = body.vaultId;
  if (!vaultId) {
    const vault = await c.var.services.vaults.create({ tenantId, name: body.vaultName });
    vaultId = vault.id;
  } else {
    if (!(await c.var.services.vaults.exists({ tenantId, vaultId }))) {
      return c.json({ error: "vault not found in tenant" }, 404);
    }
  }
```

After the swap, drop these unused imports from `internal.ts`:
- `VaultConfig` from `@open-managed-agents/shared`
- `generateVaultId` from `@open-managed-agents/shared`

## 6. Schema decisions

- **Single index** `(tenant_id, archived_at)` — covers both list paths (active-only and includeArchived). The default list is the hot one and excludes archived.
- **No FK** anywhere — `tenant_id` is plain TEXT. Cross-tenant isolation enforced in service via `WHERE tenant_id = ?`.
- **No UNIQUE on name** — multiple vaults with the same name in one tenant are allowed (matches current KV behavior).
- **No max-vaults-per-tenant cap** at this layer (consistent with current KV — there's no count check today).

## 7. Open questions

- **Vault listing currently filters out keys containing `:cred`** (vaults.ts:84). After D1 migration, vault and credential rows are in different tables — this filter becomes unnecessary. Drop it.
- **The credentials route still does its own `vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId))` existence check at lines 149 and 178**. Switching these to `c.var.services.vaults.exists(...)` is cosmetic but cleaner.
- **Cleanup of stale KV `t:*:vault:*` keys** — out of scope for this PR per "data don't matter, no users" decision. If we later care about KV cost, write a one-shot script.
