# INTEGRATION_GUIDE.md — `@open-managed-agents/files-store`

OPE-6: KV → D1 migration of file metadata. The R2 blob lifecycle stays in
the route layer; only metadata moves. This guide lists every change the
integration step needs to wire the new service into the codebase. Execute
these mechanically.

---

## 0. Prereqs

- Run `pnpm install` (the package was already added to `apps/main/package.json`
  and `apps/agent/package.json` workspace deps in this branch).
- Migration file picked: **`0011_files_table.sql`**.

---

## 1. `packages/services/src/index.ts` — wire the service

Add the import at the top (alongside existing `MemoryStoreService` /
`CredentialService` / `SessionService`):

```ts
import {
  FileService,
  createCfFileService,
} from "@open-managed-agents/files-store";
```

Add to the `Services` interface:

```ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  sessions: SessionService;
  files: FileService;          // ← add
}
```

Add to `buildCfServices`:

```ts
export function buildCfServices(env: Env): Services {
  return {
    credentials: createCfCredentialService(env),
    memory: createCfMemoryStoreService(env),
    sessions: createCfSessionService(env),
    files: createCfFileService(env),       // ← add
  };
}
```

---

## 2. `vitest.config.ts` — add resolver aliases

Add two lines to `resolve.alias`, mirroring the credentials-store entries
(longer key first so the `/test-fakes` subpath wins over the bare package
match):

```ts
"@open-managed-agents/files-store/test-fakes": "./packages/files-store/src/test-fakes.ts",
"@open-managed-agents/files-store": "./packages/files-store/src/index.ts",
```

After this lands, the test file imports can be swapped from relative
(`../../packages/files-store/src/...`) to package-name imports for
consistency with the credentials-store test (optional cleanup — not blocking).

---

## 3. `test/test-worker.ts` — add migration to bootstrap

Insert the import after `sess0010` (or after `cred0009` if sessions-store
hasn't merged yet — adjust order accordingly):

```ts
// @ts-expect-error
import files0011 from "../apps/main/migrations/0011_files_table.sql?raw";
```

Append `files0011 as string,` to the `MIGRATIONS_RAW` array:

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
  sess0010 as string,
  files0011 as string,         // ← add
];
```

---

## 4. Route + DO switches — every site that touches `file:` or `filebyscope:` KV

Each row gives: file path + line number + the **before** pattern to match +
the **after** replacement. All HTTP routes use `c.var.services.files.<method>`.

The general rule: file metadata reads/writes go through the service; R2 PUT,
R2 GET, R2 DELETE stay in the route. The service exposes `r2_key` on every
returned row so the route knows which R2 object to operate on.

### 4a. `apps/main/src/routes/files.ts` — full rewrite

The whole file is a metadata CRUD wrapper that needs to switch to the service.
Below: each handler with the before/after.

#### Drop the imports + helper for KV

Remove these (no longer used in this file):

```ts
import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";
```

Replace with:

```ts
import { toFileRecord, FileNotFoundError } from "@open-managed-agents/files-store";
```

Add the standard services-aware Hono context shape (matches sessions.ts):

```ts
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();
```

#### POST / (upload) — lines 14-90

Old: generate id → R2 PUT → KV.put(file:id) → KV.put(filebyscope:scope:id) if scopeId.

After (R2 PUT + service.create — keep R2 PUT BEFORE metadata insert so the
failure semantics match KV-era):

```ts
const id = generateFileId();
const r2Key = fileR2Key(t, id);
await bucket.put(r2Key, body, { httpMetadata: { contentType: mediaType } });

const row = await c.var.services.files.create({
  id,
  tenantId: t,
  sessionId: scopeId,                // undefined → tenant scope
  filename,
  mediaType,
  sizeBytes: body.byteLength,
  r2Key,
  downloadable,
});

return c.json(toFileRecord(row), 201);
```

The `filebyscope:` KV write disappears — `session_id` column + indexed query
covers the audit-flagged scope-list path.

#### GET / (list) — lines 93-144

Old: kvListAll(file: prefix) OR kvListAll(filebyscope: prefix) + per-id KV
fetch + in-memory JSON.parse + sort + slice.

After (single indexed query, cursor pagination handled by the service):

```ts
const t = c.get("tenant_id");
const scopeId = c.req.query("scope_id");
const limitParam = c.req.query("limit");
const beforeId = c.req.query("before_id");
const afterId = c.req.query("after_id");
const order = c.req.query("order") === "asc" ? "asc" : "desc";

const limit = limitParam ? parseInt(limitParam, 10) : undefined;

// service.list clamps limit + applies cursors. order defaults to "desc".
// scopeId === undefined → list all tenant files. scopeId set → only that
// session's files (matches the original filebyscope: code path).
const rows = await c.var.services.files.list({
  tenantId: t,
  sessionId: scopeId,
  beforeId,
  afterId,
  order,
  limit,
});

// has_more semantics: ask for limit+1, slice. The service clamps via
// MAX_LIST_LIMIT — to keep the response shape identical we do this here:
const requested = limit ?? 100;
const slice = rows.slice(0, requested);
const data = slice.map(toFileRecord);
return c.json({
  data,
  has_more: rows.length > requested,
  first_id: data[0]?.id,
  last_id: data[data.length - 1]?.id,
});
```

NOTE: to preserve `has_more` semantics, either ask the service for `limit+1`
rows then slice (above), or add a `hasMore` return to `service.list`.
Recommended: pass `limit: requested + 1` and slice.

#### GET /:id — lines 147-153

Replace the KV.get + JSON.parse with:

```ts
const row = await c.var.services.files.get({
  tenantId: c.get("tenant_id"),
  fileId: c.req.param("id"),
});
if (!row) return c.json({ error: "File not found" }, 404);
return c.json(toFileRecord(row));
```

#### GET /:id/content — lines 158-178

Replace the metaData KV.get with `service.get`. Keep the bucket.get exactly
as-is, but use `row.r2_key` instead of recomputing via `fileR2Key(t, id)`:

```ts
const row = await c.var.services.files.get({
  tenantId: c.get("tenant_id"),
  fileId: c.req.param("id"),
});
if (!row) return c.json({ error: "File not found" }, 404);
if (!row.downloadable) {
  return c.json({ error: "This file is not downloadable" }, 403);
}

const obj = await bucket.get(row.r2_key);
if (!obj) return c.json({ error: "File content not found" }, 404);

return new Response(obj.body, {
  headers: { "Content-Type": row.media_type },
});
```

#### DELETE /:id — lines 181-197

Old: KV.get → JSON.parse → KV.delete(file:id) → KV.delete(filebyscope:scope:id)
if scope_id → bucket.delete(fileR2Key(t, id)).

After:

```ts
try {
  const deleted = await c.var.services.files.delete({
    tenantId: c.get("tenant_id"),
    fileId: c.req.param("id"),
  });
  if (bucket) await bucket.delete(deleted.r2_key);
  return c.json({ type: "file_deleted", id: deleted.id });
} catch (err) {
  if (err instanceof FileNotFoundError) {
    return c.json({ error: "File not found" }, 404);
  }
  throw err;
}
```

The `filebyscope:` cleanup line (192) goes away — single-row DELETE replaces
the dual-KV-key delete.

### 4b. `apps/main/src/routes/sessions.ts` — every other site

#### Line 133 — `resolveFileIds` (file_id message-block resolution)

```ts
// Old:
//   const [metaJson, obj] = await Promise.all([
//     env.CONFIG_KV.get(kvKey(tenantId, "file", fileId)),
//     bucket.get(fileR2Key(tenantId, fileId)),
//   ]);
//   if (!metaJson || !obj) throw ...
//   const meta = JSON.parse(metaJson) as FileRecord;
//
// New:
const meta = await services.files.get({ tenantId, fileId });
const obj = meta ? await bucket.get(meta.r2_key) : null;
if (!meta || !obj) throw new Error(`file_id ${fileId} not found`);
```

`resolveFileIds` currently takes `env` only — needs to also accept `services`
(or build them via `buildCfServices(env)` once at the top). Recommend:
add a `services: Services` parameter and pipe through from each call site
(line 530-something — search for `resolveFileIds(`).

#### Lines 287-329 — initial file resource scoped-copy

Old: KV.get source file metadata → KV.put scoped copy → R2 copy → KV.put resource.

After (preserves R2 copy semantics, just swaps metadata ops):

```ts
if (res.type === "file" && res.file_id) {
  const sourceFile = await c.var.services.files.get({
    tenantId: t,
    fileId: res.file_id,
  });
  if (!sourceFile) continue;

  const scopedFileId = generateFileId();
  const scopedR2Key = fileR2Key(t, scopedFileId);

  // R2 copy first, same as KV-era ordering: best-effort body copy, then
  // metadata insert. If R2 source missing, still create metadata (matches
  // existing behavior for legacy files with no bytes).
  if (c.env.FILES_BUCKET) {
    const obj = await c.env.FILES_BUCKET.get(sourceFile.r2_key);
    if (obj) {
      await c.env.FILES_BUCKET.put(scopedR2Key, obj.body, {
        httpMetadata: { contentType: sourceFile.media_type },
      });
    }
  }

  await c.var.services.files.create({
    id: scopedFileId,
    tenantId: t,
    sessionId,                    // scoped to this session
    filename: sourceFile.filename,
    mediaType: sourceFile.media_type,
    sizeBytes: sourceFile.size_bytes,
    r2Key: scopedR2Key,
    downloadable: sourceFile.downloadable,
  });

  // … then keep the existing resource creation (KV-based today, will move
  //   to sessions-store once OPE-8 lands).
}
```

#### Lines 647-661 — POST /v1/sessions/:id/files (sandbox → file dump)

Old: bucket.put → KV.put(file:newFileId) → KV.put(filebyscope:id:newFileId).

After (drops the filebyscope: write entirely):

```ts
const newFileId = generateFileId();
const r2Key = fileR2Key(t, newFileId);
await bucket.put(r2Key, buf, { httpMetadata: { contentType: mediaType } });

const row = await c.var.services.files.create({
  id: newFileId,
  tenantId: t,
  sessionId: id,                // session-scoped (id from c.req.param("id"))
  filename,
  mediaType,
  sizeBytes: buf.byteLength,
  r2Key,
  downloadable,
});

return c.json(toFileRecord(row), 201);
```

#### Line 877 — POST /v1/sessions/:id/resources (file existence check)

```ts
// Old:
//   const fileData = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "file", body.file_id));
//   if (!fileData) return c.json({ error: "File not found" }, 404);
//
// New:
const file = await c.var.services.files.get({
  tenantId: c.get("tenant_id"),
  fileId: body.file_id,
});
if (!file) return c.json({ error: "File not found" }, 404);
```

This is the only file usage in this handler; the rest of the resource
creation continues to write to `sesrsc:` KV (or sessions-store after OPE-8).

### 4c. Other consumers — none

`grep -rn 'kvKey.*"file"\|"filebyscope"' apps/ packages/` returns ONLY the
files.ts + sessions.ts hits above. No other route, DO, or worker references
the `t:{tenant}:file:` or `filebyscope:` KV layouts.

---

## 5. Schema decisions

- **Indexes** (defined in `0011_files_table.sql`):
  - `(tenant_id, created_at DESC)` — list-all-tenant path (GET /v1/files
    with no scope_id). Index-only ordering for the default DESC sort.
  - `(tenant_id, session_id, created_at DESC)` — list-by-session path
    (GET /v1/files?scope_id=…). The audit-fixed query.
  - `(session_id)` — cascade-by-session (deleteBySession). Plain index
    so the WHERE doesn't need tenant_id when called from a DO that only
    knows session_id.
- **No UNIQUE constraints**: file `id` is the PRIMARY KEY (globally unique
  via `generateFileId` — `file-{nanoid(16)}`). Filenames intentionally allow
  duplicates.
- **No FK**: `session_id` is plain TEXT, soft FK to `sessions`. Cascade
  lives in `deleteBySession`. Same convention as 0009 + 0010.
- **`scope` column**: redundant with `session_id NULL/non-NULL` but kept
  for query clarity and future extension (e.g. an "agent" scope without
  having to grow more nullable FKs).
- **`r2_key` stored explicitly**: instead of recomputing from
  `fileR2Key(tenant_id, id)` on every read. Lets `delete` and
  `deleteBySession` return r2_keys without a tenant-aware helper, and
  future-proofs against R2 key scheme changes (e.g. random suffixes).
- **`downloadable` as INTEGER**: SQLite has no BOOL. Adapter converts 0/1
  ↔ false/true. Default `0` (safer — opt-in to download).
- **`media_type` (not `mime_type`)**: matches the existing
  `FileRecord.media_type` API field for symmetry. The spec mentioned
  "mime_type" — I picked the API-aligned name for consistency, but flag if
  you want it renamed.
- **No `downloadable IS NULL` distinction**: column is `NOT NULL DEFAULT 0`.
  Routes pass `downloadable: true|false` explicitly; absence means false.

---

## 6. Open questions

1. **`media_type` vs `mime_type`** — the spec instruction said "mime_type"
   but I named the column `media_type` to match the existing FileRecord API
   surface (which has `media_type`). Easy rename if you want the SQL-side
   name to differ from the API.

2. **`has_more` pagination semantics**: the existing route returns
   `has_more` based on whether the in-memory list exceeded `limit`. The
   service exposes `list({ limit })` that returns at most `limit` rows. To
   preserve `has_more` correctly the route should ask for `limit + 1` then
   slice. Recommended above. Alternative: add a `listWithCursor` service
   method that returns `{ rows, hasMore }` — cleaner but more API surface.

3. **`deleteBySession` is unused at integration time**: I exposed it because
   the spec asked for it, but no current route calls it. The session-delete
   path (`apps/main/src/routes/sessions.ts:506-529`) does NOT cascade
   scoped files — that's a pre-existing leak. If you want to fix that as
   part of this integration, add `await c.var.services.files.deleteBySession(...)`
   right after `forwardToSandbox(... /destroy)` and `Promise.all` the
   `bucket.delete(row.r2_key)` calls for each returned row. Otherwise it
   stays as a future cleanup hook.

4. **Tenant verification on `delete`**: the service checks `tenant_id` via
   `WHERE id = ? AND tenant_id = ?` and returns null on miss → throws
   `FileNotFoundError`. This means cross-tenant delete attempts return 404
   (current behavior). If you want a 403 distinction, the service would
   need to grow a `getById` (cross-tenant) method, mirroring sessions-store.
   Not currently needed by any route.

5. **`resolveFileIds` signature change**: the existing function takes only
   `(env, tenantId, content)` — the migration needs to pipe `services`
   through. Easiest: add `services: Services` as the first param (after
   env). Will touch ~1 call site. Alternative: build `buildCfServices(env)`
   inside the function — fine for non-hot-path use, slight extra allocation
   per call.

6. **Type field on FileRecord output**: `toFileRecord` always sets
   `type: "file"`. The original code did `type: "file" as const` at the
   creation site but the route's GET /:id response didn't add it (it just
   returned the JSON.parsed blob, which may or may not have had `type`
   depending on when it was created). The new helper makes this consistent
   — every response includes `type: "file"`. Should be transparent to
   clients.
