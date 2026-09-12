/**
 * Local-runtime onboarding + management routes.
 *
 *   /v1/oma/runtimes/*               — browser, requires user auth (authMiddleware)
 *     POST /connect-runtime        → mint one-time `code` (5-min TTL, single-use)
 *     GET  /                       → list my registered runtimes
 *     DELETE /:id                  → revoke runtime + all its tokens
 *
 *   /agents/runtime/*            — daemon, no authMiddleware (token IS auth)
 *     POST /exchange               → { code, machine_id, ... } → { runtime_id, token, agent_api_key }
 *
 * Setup flow:
 *   1. CLI binds 127.0.0.1:<rand-port>, opens browser to
 *      `https://app.openma.dev/connect-runtime?cb=...&state=...`
 *   2. Browser (auth'd via Better Auth cookie) POSTs `/v1/oma/runtimes/connect-runtime`
 *      with the state echo → gets back a one-time `code`.
 *   3. Browser redirects to `http://127.0.0.1:<port>/cb?code=...&state=...`.
 *      Localhost server is the CLI; it grabs the code and closes.
 *   4. CLI POSTs `/agents/runtime/exchange` with `{ code, machine_id, hostname, os, version }`.
 *      Server validates code, inserts `runtimes` row + `runtime_tokens` row,
 *      returns the token plaintext (only time it's ever transmitted) plus a
 *      newly-minted user API key (`oma_*`) the daemon will hand to spawned ACP
 *      children as their MCP authorization_token.
 *   5. CLI writes ~/.oma/bridge/credentials.json + installs launchd plist.
 */

import { Hono } from "hono";
import type { Env, AgentConfig } from "@open-managed-agents/shared";
import { skillFileR2Key } from "@open-managed-agents/shared";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/known-agents";
import type { Services } from "@open-managed-agents/services";
import type { KvStore } from "@open-managed-agents/kv-store";

/** Browser-facing routes — mounted under /v1/oma/runtimes. */
export const runtimesRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>();

/** Daemon-facing routes — mounted under /agents/runtime. NO authMiddleware. */
export const runtimeDaemonRoutes = new Hono<{
  Bindings: Env;
  Variables: { services: Services };
}>();

const CODE_TTL_SECONDS = 5 * 60;

function generateCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateRuntimeToken(): string {
  // sk_machine_ + 60 hex (240 bits). Stripe-style prefix so it's grep-able
  // in user shell history if it ever leaks.
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk_machine_${hex}`;
}

function generateAgentApiKey(): string {
  // oma_* matches the existing API-key minting in routes/api-keys.ts so the
  // existing authMiddleware accepts it without changes.
  const bytes = new Uint8Array(36);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "oma_";
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Browser-facing ───────────────────────────────────────────────────────

// POST /v1/oma/runtimes/connect-runtime — browser asks for a one-time exchange code.
runtimesRoutes.post("/connect-runtime", async (c) => {
  const userId = c.get("user_id");
  const tenantId = c.get("tenant_id");
  if (!userId || !tenantId) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { state?: string };
  const state = body.state;
  if (!state || typeof state !== "string" || state.length < 8) {
    return c.json({ error: "state required (>= 8 chars)" }, 400);
  }

  const code = generateCode();
  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;

  await c.env.MAIN_DB
    .prepare(
      `INSERT INTO "connect_runtime_codes" (code, user_id, tenant_id, state, expires_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(code, userId, tenantId, state, expiresAt)
    .run();

  return c.json({ code, expires_at: expiresAt });
});

// GET /v1/oma/runtimes — list user's runtimes.
runtimesRoutes.get("/", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { results } = await c.env.MAIN_DB
    .prepare(
      `SELECT id, machine_id, hostname, os, agents_json, local_skills_json, version, status, last_heartbeat, created_at
       FROM "runtimes" WHERE owner_user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{
      id: string;
      machine_id: string;
      hostname: string;
      os: string;
      agents_json: string;
      local_skills_json: string;
      version: string;
      status: string;
      last_heartbeat: number | null;
      created_at: number;
    }>();

  return c.json({
    runtimes: (results ?? []).map((r) => ({
      id: r.id,
      machine_id: r.machine_id,
      hostname: r.hostname,
      os: r.os,
      agents: safeJsonParse(r.agents_json) as Array<{ id: string; binary?: string }>,
      local_skills: safeJsonParse(r.local_skills_json ?? "{}") as Record<string, Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>>,
      version: r.version,
      status: r.status,
      last_heartbeat: r.last_heartbeat,
      created_at: r.created_at,
    })),
  });
});

// DELETE /v1/oma/runtimes/:id — revoke runtime + all its tokens.
runtimesRoutes.delete("/:id", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const id = c.req.param("id");
  const owned = await c.env.MAIN_DB
    .prepare(`SELECT id FROM "runtimes" WHERE id = ? AND owner_user_id = ?`)
    .bind(id, userId)
    .first<{ id: string }>();
  if (!owned) return c.json({ error: "not found" }, 404);

  const now = Math.floor(Date.now() / 1000);
  await c.env.MAIN_DB.batch([
    c.env.MAIN_DB
      .prepare(`UPDATE "runtime_tokens" SET revoked_at = ? WHERE runtime_id = ? AND revoked_at IS NULL`)
      .bind(now, id),
    c.env.MAIN_DB.prepare(`DELETE FROM "runtimes" WHERE id = ?`).bind(id),
  ]);

  return c.json({ ok: true });
});

// ─── Daemon-facing (no authMiddleware) ────────────────────────────────────

// POST /agents/runtime/exchange — daemon swaps code for runtime token + agent API key.
// Dual-shape response:
//   - v1 clients (no `multi_tenant` flag): `{ runtime_id, token, agent_api_key }`
//     where `agent_api_key` is the key bound to the user's active tenant
//     (the one captured by the original /connect-runtime call).
//   - v2 clients (`multi_tenant: true`): `{ runtime_id, token, tenants: [...] }`
//     with one row per user membership, each carrying its own freshly-minted
//     `oma_*` key. The daemon picks the right key per spawned ACP child.
//
// Either way the server-side authorization is identical — `runtime_tenants`
// gets one row per membership; only the response shape differs. Step 2 of
// the rollout will flip enforcement to require per-message `tenant_id` and
// retire the v1 branch. See plan: atomic-seeking-seal.md.
runtimeDaemonRoutes.post("/exchange", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    state?: string;
    machine_id?: string;
    hostname?: string;
    os?: string;
    version?: string;
    multi_tenant?: boolean;
  };

  const { code, state, machine_id, hostname, os, version, multi_tenant } = body;
  if (!code || !state || !machine_id || !hostname || !os || !version) {
    return c.json(
      { error: "code, state, machine_id, hostname, os, version all required" },
      400,
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.MAIN_DB
    .prepare(
      `SELECT user_id, tenant_id, state, expires_at, used_at FROM "connect_runtime_codes" WHERE code = ?`,
    )
    .bind(code)
    .first<{ user_id: string; tenant_id: string; state: string; expires_at: number; used_at: number | null }>();

  if (!row) return c.json({ error: "invalid code" }, 400);
  if (row.used_at) return c.json({ error: "code already used" }, 400);
  if (row.expires_at < now) return c.json({ error: "code expired" }, 400);
  if (row.state !== state) return c.json({ error: "state mismatch" }, 400);

  await c.env.MAIN_DB
    .prepare(`UPDATE "connect_runtime_codes" SET used_at = ? WHERE code = ?`)
    .bind(now, code)
    .run();

  // Idempotent runtime insert: re-running `oma bridge setup` from same UNIX
  // user / same machine reuses the existing row.
  const existing = await c.env.MAIN_DB
    .prepare(`SELECT id FROM "runtimes" WHERE owner_user_id = ? AND machine_id = ?`)
    .bind(row.user_id, machine_id)
    .first<{ id: string }>();

  let runtimeId: string;
  if (existing) {
    runtimeId = existing.id;
    await c.env.MAIN_DB
      .prepare(`UPDATE "runtimes" SET hostname = ?, os = ?, version = ? WHERE id = ?`)
      .bind(hostname, os, version, runtimeId)
      .run();
  } else {
    runtimeId = crypto.randomUUID();
    await c.env.MAIN_DB
      .prepare(
        `INSERT INTO "runtimes" (id, owner_user_id, owner_tenant_id, machine_id, hostname, os, agents_json, version, status, last_heartbeat, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'offline', NULL, ?)`,
      )
      .bind(runtimeId, row.user_id, row.tenant_id, machine_id, hostname, os, version, now)
      .run();
  }

  // Always issue a fresh runtime token. Old tokens stay valid until explicit
  // revoke — multiple `oma bridge setup` runs from different shells shouldn't
  // kick each other out.
  const tokenPlain = generateRuntimeToken();
  const tokenHash = await sha256(tokenPlain);
  const tokenId = crypto.randomUUID();
  await c.env.MAIN_DB
    .prepare(
      `INSERT INTO "runtime_tokens" (id, runtime_id, token_hash, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenId, runtimeId, tokenHash, row.user_id, now)
    .run();

  // Authorize this runtime for every tenant the user belongs to. Mint a
  // fresh `oma_*` per (runtime, tenant) so the daemon can hand the right
  // key to each spawned ACP child. /exchange always re-mints (it's the
  // first-touch path; legacy backfill rows get replaced; an unusual
  // re-registration with an existing real id also gets rotated).
  const memberships = await c.env.MAIN_DB
    .prepare(`SELECT tenant_id, role FROM "membership" WHERE user_id = ?`)
    .bind(row.user_id)
    .all<{ tenant_id: string; role: string }>();
  const membershipRows = memberships.results ?? [];
  // Fallback: if the user has no membership rows yet (older accounts pre-0005),
  // synthesize one from the connect-code's tenant so the response is non-empty
  // and the runtime still gets an authorized row.
  if (membershipRows.length === 0) {
    membershipRows.push({ tenant_id: row.tenant_id, role: "owner" });
  }

  const mintedKeys = new Map<string, string>(); // tenant_id → plaintext oma_*
  for (const m of membershipRows) {
    const { plain, id: apiKeyId } = await issueAgentApiKey(
      c.var.services.kv,
      row.user_id,
      m.tenant_id,
      hostname,
    );
    mintedKeys.set(m.tenant_id, plain);

    // Upsert into runtime_tenants. SQLite UPSERT keeps the original
    // created_at on conflict while always rotating to the freshly-minted
    // api_key id (replacing __legacy__ or any stale real id). Clearing
    // revoked_at re-activates rows that an earlier /refresh soft-deleted.
    await c.env.MAIN_DB
      .prepare(
        `INSERT INTO "runtime_tenants" (runtime_id, tenant_id, agent_api_key_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (runtime_id, tenant_id)
         DO UPDATE SET agent_api_key_id = excluded.agent_api_key_id, revoked_at = NULL`,
      )
      .bind(runtimeId, m.tenant_id, apiKeyId, now)
      .run();
  }

  // Batch-fetch tenant display names. Single IN(?,?,?...) query keeps
  // this O(1) round trips regardless of membership size.
  const tenantIds = membershipRows.map((m) => m.tenant_id);
  const tenantNames = new Map<string, string>();
  if (tenantIds.length > 0) {
    const placeholders = tenantIds.map(() => "?").join(",");
    const { results: tenantRows } = await c.env.MAIN_DB
      .prepare(`SELECT id, name FROM "tenant" WHERE id IN (${placeholders})`)
      .bind(...tenantIds)
      .all<{ id: string; name: string }>();
    for (const t of tenantRows ?? []) tenantNames.set(t.id, t.name);
  }

  if (multi_tenant === true) {
    const tenants = membershipRows.map((m) => ({
      id: m.tenant_id,
      name: tenantNames.get(m.tenant_id) ?? m.tenant_id,
      role: m.role,
      agent_api_key: mintedKeys.get(m.tenant_id)!,
    }));
    return c.json({ runtime_id: runtimeId, token: tokenPlain, tenants });
  }

  // v1 fall-through: return the key for the user's active tenant (the one
  // pinned by /connect-runtime). Always present because we just minted it
  // above. Falls back to whatever the first membership was if the active
  // tenant somehow isn't in the membership set — defensive, shouldn't fire.
  const v1Key = mintedKeys.get(row.tenant_id) ?? mintedKeys.values().next().value!;
  return c.json({
    runtime_id: runtimeId,
    token: tokenPlain,
    agent_api_key: v1Key,
  });
});

// GET /agents/runtime/me — daemon fetches its own runtime row + authorized tenants.
//
// Auth: same Bearer sk_machine_* the daemon uses for /_attach. The runtime
// identity is implicit in the token; no path param needed.
//
// Used by step 3 of the rollout: when a v1 daemon (single `agentApiKey` on
// disk) boots and discovers its credentials.json has no `v: 2` marker, it
// hits this endpoint to enumerate authorized tenants for its runtime so it
// can synthesize a one-tenant CredentialsV2 stub locally. The actual
// per-tenant `oma_*` plaintext keys come from /refresh — this endpoint
// returns only `{id, name, role}` per tenant (no secret material).
//
// Lives at /agents/runtime/* (not /v1/oma/runtimes/:id) because the daemon
// auth is bearer sk_machine_*, not the user-auth-middleware that /v1/*
// enforces. The plan's reference to "GET /v1/oma/runtimes/${runtimeId}" was
// imprecise — daemon path is mandatory.
runtimeDaemonRoutes.get("/me", async (c) => {
  const ok = await authenticateRuntimeToken(c.env, c.req.header("authorization") ?? "");
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  const runtime = await c.env.MAIN_DB
    .prepare(
      `SELECT id, machine_id, hostname, os, version, status, last_heartbeat, created_at
       FROM "runtimes" WHERE id = ?`,
    )
    .bind(ok.runtime_id)
    .first<{
      id: string;
      machine_id: string;
      hostname: string;
      os: string;
      version: string;
      status: string;
      last_heartbeat: number | null;
      created_at: number;
    }>();
  if (!runtime) return c.json({ error: "runtime not found" }, 404);

  // tenants[] — left join membership for role (so a runtime authorized
  // for a tenant the user has since left still shows the row, with role
  // null. The daemon ignores those entries; the next /refresh will revoke).
  const { results: tenantRows } = await c.env.MAIN_DB
    .prepare(
      `SELECT rt.tenant_id AS id, t.name AS name, m.role AS role
       FROM "runtime_tenants" rt
       LEFT JOIN "tenant" t ON t.id = rt.tenant_id
       LEFT JOIN "membership" m ON m.tenant_id = rt.tenant_id AND m.user_id = ?
       WHERE rt.runtime_id = ? AND rt.revoked_at IS NULL`,
    )
    .bind(ok.user_id, ok.runtime_id)
    .all<{ id: string; name: string | null; role: string | null }>();

  return c.json({
    runtime,
    tenants: (tenantRows ?? []).map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      role: r.role ?? "member",
    })),
  });
});

// POST /agents/runtime/:id/refresh — daemon asks the server to reconcile
// its authorized tenants against the user's current memberships.
//
// Always rotates ALL live (runtime, tenant) keys on every call. Trade-off:
//   - Pro: simple, single response shape — `agent_api_key` is always
//     plaintext for every returned tenant. Daemon just replaces its
//     in-memory map. No "did we get plaintext this time?" branch.
//   - Pro: stale daemon credentials self-heal — if a daemon lost its on-disk
//     creds and re-ran `oma bridge refresh` from scratch, this rotates
//     every key and hands them back.
//   - Con: more KV churn (N puts + N+1 deletes per refresh). Refresh is rare
//     (manual user-triggered op), so this cost is fine.
// Soak alternative — "return existing rows without plaintext, rotate only on
// __legacy__ or KV miss" — is documented in the plan but rejected here for
// the simplicity reason above.
runtimeDaemonRoutes.post("/:id/refresh", async (c) => {
  const ok = await authenticateRuntimeToken(c.env, c.req.header("authorization") ?? "");
  if (!ok) return c.json({ error: "unauthorized" }, 401);
  // Match the path param to the token-bound runtime — refusing 404 (not 403)
  // for the same non-oracle reason as the bundle route.
  if (ok.runtime_id !== c.req.param("id")) {
    return c.json({ error: "not found" }, 404);
  }

  const runtime = await c.env.MAIN_DB
    .prepare(`SELECT hostname FROM "runtimes" WHERE id = ?`)
    .bind(ok.runtime_id)
    .first<{ hostname: string }>();
  if (!runtime) return c.json({ error: "runtime not found" }, 404);

  const memberships = await c.env.MAIN_DB
    .prepare(`SELECT tenant_id, role FROM "membership" WHERE user_id = ?`)
    .bind(ok.user_id)
    .all<{ tenant_id: string; role: string }>();
  const membershipRows = memberships.results ?? [];
  const membershipById = new Map<string, { tenant_id: string; role: string }>();
  for (const m of membershipRows) membershipById.set(m.tenant_id, m);

  const liveTenantRows = await c.env.MAIN_DB
    .prepare(
      `SELECT tenant_id, agent_api_key_id FROM "runtime_tenants"
       WHERE runtime_id = ? AND revoked_at IS NULL`,
    )
    .bind(ok.runtime_id)
    .all<{ tenant_id: string; agent_api_key_id: string }>();
  const liveById = new Map<string, string>(); // tenant_id → agent_api_key_id
  for (const r of liveTenantRows.results ?? []) {
    liveById.set(r.tenant_id, r.agent_api_key_id);
  }

  const toAdd = membershipRows.filter((m) => !liveById.has(m.tenant_id));
  const toRevoke: Array<{ tenant_id: string; agent_api_key_id: string }> = [];
  for (const [tid, akid] of liveById.entries()) {
    if (!membershipById.has(tid)) toRevoke.push({ tenant_id: tid, agent_api_key_id: akid });
  }

  const kv = c.var.services.kv;
  const now = Math.floor(Date.now() / 1000);
  const mintedKeys = new Map<string, string>(); // tenant_id → plaintext

  // Revoke first so a tenant that's both being removed and re-added (would
  // never happen via membership flips, but defensive against UPSERT races)
  // doesn't see its newly-minted key wiped.
  for (const r of toRevoke) {
    await revokeAgentApiKey(kv, r.agent_api_key_id);
    await c.env.MAIN_DB
      .prepare(
        `UPDATE "runtime_tenants" SET revoked_at = ? WHERE runtime_id = ? AND tenant_id = ?`,
      )
      .bind(now, ok.runtime_id, r.tenant_id)
      .run();
  }

  // Rotate existing live rows — revoke old key, mint new, replace api_key_id.
  // Skipped for entries already in toRevoke (those are gone now).
  const toRotate = membershipRows.filter((m) => liveById.has(m.tenant_id));
  for (const m of toRotate) {
    const oldAkid = liveById.get(m.tenant_id)!;
    await revokeAgentApiKey(kv, oldAkid);
    const { plain, id: newAkid } = await issueAgentApiKey(kv, ok.user_id, m.tenant_id, runtime.hostname);
    mintedKeys.set(m.tenant_id, plain);
    await c.env.MAIN_DB
      .prepare(
        `UPDATE "runtime_tenants" SET agent_api_key_id = ? WHERE runtime_id = ? AND tenant_id = ?`,
      )
      .bind(newAkid, ok.runtime_id, m.tenant_id)
      .run();
  }

  // Add fresh rows for new memberships.
  for (const m of toAdd) {
    const { plain, id: newAkid } = await issueAgentApiKey(kv, ok.user_id, m.tenant_id, runtime.hostname);
    mintedKeys.set(m.tenant_id, plain);
    await c.env.MAIN_DB
      .prepare(
        `INSERT INTO "runtime_tenants" (runtime_id, tenant_id, agent_api_key_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (runtime_id, tenant_id)
         DO UPDATE SET agent_api_key_id = excluded.agent_api_key_id, revoked_at = NULL`,
      )
      .bind(ok.runtime_id, m.tenant_id, newAkid, now)
      .run();
  }

  // Batch tenant names for the response.
  const tenantIds = membershipRows.map((m) => m.tenant_id);
  const tenantNames = new Map<string, string>();
  if (tenantIds.length > 0) {
    const placeholders = tenantIds.map(() => "?").join(",");
    const { results: nameRows } = await c.env.MAIN_DB
      .prepare(`SELECT id, name FROM "tenant" WHERE id IN (${placeholders})`)
      .bind(...tenantIds)
      .all<{ id: string; name: string }>();
    for (const t of nameRows ?? []) tenantNames.set(t.id, t.name);
  }

  // Best-effort cache invalidation: tell RuntimeRoom DO to re-read its
  // authorized-tenants cache. Tolerant of binding absence (test envs) and
  // network errors — the cache is a perf hint, not a correctness gate; the
  // DB rows are authoritative on the next access.
  const room = (c.env as unknown as { RUNTIME_ROOM?: DurableObjectNamespace }).RUNTIME_ROOM;
  if (room) {
    try {
      const stub = room.get(room.idFromName(ok.runtime_id));
      await (stub as unknown as { refreshAuthorizedTenants(): Promise<void> })
        .refreshAuthorizedTenants();
    } catch {
      // best-effort
    }
  }

  return c.json({
    tenants: membershipRows.map((m) => ({
      id: m.tenant_id,
      name: tenantNames.get(m.tenant_id) ?? m.tenant_id,
      role: m.role,
      agent_api_key: mintedKeys.get(m.tenant_id)!,
    })),
    added: toAdd.map((m) => m.tenant_id),
    revoked: toRevoke.map((r) => r.tenant_id),
  });
});

/**
 * Revoke an `oma_*` key previously minted by `issueAgentApiKey`. Looks up the
 * hash via the `akid:<id>` index, then mirror-reverses the writes:
 *   - delete `apikey:<hash>` (auth lookup row)
 *   - splice the matching entry out of `t:<tenant>:apikeys` (per-tenant index)
 *   - delete `akid:<id>` (the secondary index itself)
 * Tolerant of a missing `akid:<id>` row (already revoked, or row predates the
 * index write added in step 1) — we just skip the cleanup; the soft-delete on
 * `runtime_tenants` is still authoritative.
 */
async function revokeAgentApiKey(kv: KvStore, apiKeyId: string): Promise<void> {
  if (!apiKeyId || apiKeyId === "__legacy__") {
    // Legacy backfill sentinel — no real key was stored, nothing to revoke.
    return;
  }
  const raw = await kv.get(`akid:${apiKeyId}`);
  if (!raw) return;
  let parsed: { hash?: string; tenant_id?: string };
  try {
    parsed = JSON.parse(raw) as { hash?: string; tenant_id?: string };
  } catch {
    return;
  }
  const { hash, tenant_id } = parsed;
  if (hash) await kv.delete(`apikey:${hash}`);
  if (tenant_id) {
    const indexKey = `t:${tenant_id}:apikeys`;
    const existing = await kv.get(indexKey);
    if (existing) {
      try {
        const index = JSON.parse(existing) as Array<{ id?: string }>;
        const next = index.filter((e) => e.id !== apiKeyId);
        await kv.put(indexKey, JSON.stringify(next));
      } catch {
        // index row corrupt — leave alone; reading code already tolerates parse errors.
      }
    }
  }
  await kv.delete(`akid:${apiKeyId}`);
}

/**
 * Mint an `oma_*` API key for daemon-spawned ACP children. Stored same way as
 * user-created keys (KV `apikey:<hash>`) so the existing /v1/* auth middleware
 * accepts it. Plaintext returned to caller once and never re-issued.
 *
 * Also writes a secondary index `akid:<id>` → `{hash, tenant_id}` so the
 * upcoming `/refresh` endpoint can look up an existing live key's hash
 * (to delete it on revoke) without having to scan `t:<tenant>:apikeys`.
 * Returning both the plaintext AND the id lets callers persist the id in
 * `runtime_tenants` so future lookups have a stable handle.
 */
async function issueAgentApiKey(
  kv: KvStore,
  userId: string,
  tenantId: string,
  displayLabel: string,
): Promise<{ plain: string; id: string }> {
  const plain = generateAgentApiKey();
  const hash = await sha256(plain);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  // Mirror the schema in routes/api-keys.ts:
  //   apikey:<hash> → { id, tenant_id, user_id, name, created_at }
  //   t:<tenant>:apikeys → [ { id, name, prefix, hash, created_at } ]
  await kv.put(
    `apikey:${hash}`,
    JSON.stringify({ id, tenant_id: tenantId, user_id: userId, name: `Local runtime (${displayLabel})`, created_at: now }),
  );
  // Secondary index keyed by the ak_* id so /refresh can look up an
  // existing live key's hash without rotating. Without this, /refresh
  // would have to rotate every key on every call to obtain the
  // plaintext-coupled hash for the cleanup path.
  await kv.put(`akid:${id}`, JSON.stringify({ hash, tenant_id: tenantId }));
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await kv.get(indexKey);
  const index = existing ? (JSON.parse(existing) as Array<unknown>) : [];
  index.push({ id, name: `Local runtime (${displayLabel})`, prefix: plain.slice(0, 8), hash, created_at: now });
  await kv.put(indexKey, JSON.stringify(index));
  return { plain, id };
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (!s) return [];
  try { return JSON.parse(s); } catch { return []; }
}

// ─── Daemon bundle endpoint ───────────────────────────────────────────────

// GET /agents/runtime/sessions/:sid/bundle?agent_id=<acp-agent-id>
// Returns AGENTS.md + skill files for the daemon to materialize in spawn cwd.
// Auth: Authorization: Bearer sk_machine_* — same auth the daemon uses to
// open the WS attach. We additionally verify the requested session belongs
// to the same tenant as the runtime token, so a leaked sk_machine_* from
// tenant A can't enumerate tenant B's session ids and exfiltrate their
// agent system prompts via the bundle.
runtimeDaemonRoutes.get("/sessions/:sid/bundle", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  const sid = c.req.param("sid");
  const acpAgentId = c.req.query("agent_id");
  if (!acpAgentId) return c.json({ error: "agent_id query required" }, 400);

  const services = c.get("services");
  const session = await services.sessions.getById({ sessionId: sid }).catch(() => null);
  // Return 404 (not 403) for cross-tenant misses too — same response a
  // legitimately-missing sid would produce, so the endpoint doesn't double
  // as an existence oracle for sids in other tenants.
  if (!session || session.tenant_id !== ok.tenant_id) {
    return c.json({ error: "session not found" }, 404);
  }
  const agent = (session as { agent_snapshot?: AgentConfig }).agent_snapshot;
  if (!agent) return c.json({ error: "session has no agent snapshot" }, 500);

  // Runtime ownership check: a daemon can only fetch bundles for sessions
  // whose agent is bound to the same runtime that owns this token. Without
  // this gate, two daemons in the same tenant could read each other's
  // session bundles by guessing sids — an info-leak that becomes a
  // material security hole the moment the bundle starts carrying env
  // values + mcp_servers config (next commit). Same 404 shape so the
  // endpoint stays a non-oracle for cross-runtime sids.
  const sessionRuntimeId = agent.runtime_binding?.runtime_id;
  if (!sessionRuntimeId || sessionRuntimeId !== ok.runtime_id) {
    return c.json({ error: "session not found" }, 404);
  }

  const files = await renderSessionBundle(agent, acpAgentId, c.var.services, ok.tenant_id);
  // Per-agent blocklist of LOCAL skills the user has on their machine
  // — daemon enforces by NOT symlinking these into the spawn-cwd's
  // CLAUDE_CONFIG_DIR. Always send an array (possibly empty) so the
  // daemon doesn't have to handle three states (undefined / empty / set).
  const local_skill_blocklist = agent.runtime_binding?.local_skill_blocklist ?? [];

  // Rewrite agent.mcp_servers (HTTP/SSE only) so they point at OMA's
  // mcp-proxy. The daemon doesn't get the user's upstream tokens — those
  // live in vaults and only mcp-proxy on the cloud side resolves them.
  // The proxy URL pattern is documented in mcp-proxy.ts:10. stdio MCP
  // servers are intentionally skipped: they require sandbox spawn
  // semantics that don't exist on the daemon side. The Authorization
  // header is left for the daemon to add (it has the agentApiKey via
  // setSpawnEnv) so we don't echo the PAT back to it through this call.
  const serverBase = new URL(c.req.url).origin;
  const mcp_servers = (agent.mcp_servers ?? [])
    .filter((s) => s.type !== "stdio")
    .map((s) => ({
      type: "http" as const,
      name: s.name,
      url: `${serverBase}/v1/oma/mcp-proxy/${encodeURIComponent(sid)}/${encodeURIComponent(s.name)}`,
    }));

  // Env vars — read session resources of type "env" (legacy "env_secret"
  // accepted in case a session predates the rename) and look up each
  // resource's value in the per-session secret store. Returned to the
  // daemon as plain { name, value } pairs; the daemon merges them into
  // the spawned ACP child's process.env. Empty-value resources are
  // skipped so the child doesn't see odd "X=" entries.
  const services2 = c.get("services");
  const sessionResources = await services2.sessions.listResourcesBySession({ sessionId: sid });
  const env: Array<{ name: string; value: string }> = [];
  for (const row of sessionResources) {
    const r = row.resource as { type?: string; name?: string };
    if ((r.type === "env" || r.type === "env_secret") && r.name) {
      const value = await services2.sessionSecrets.get({
        tenantId: ok.tenant_id,
        sessionId: sid,
        resourceId: row.id,
      });
      if (value) env.push({ name: r.name, value });
    }
  }

  return c.json({ files, local_skill_blocklist, mcp_servers, env });
});

/**
 * Render the spawn-cwd file bundle for a given (OMA agent config, ACP agent).
 *
 * The split between AGENTS.md and per-agent skill dirs is agent-aware:
 *   - claude-agent-acp: skills get their own discoverable directory tree
 *     (`.claude/skills/<id>/SKILL.md`); AGENTS.md only carries the system
 *     prompt + appendable_prompts. Daemon also redirects CLAUDE_CONFIG_DIR
 *     to filter the user's local skills (see local-skills.ts).
 *   - opencode: skills materialize as `.opencode/agents/<id>.md` so the
 *     spawned `opencode acp` child auto-discovers them as subagents per
 *     OpenCode's per-project agent convention.
 *   - codex-cli (via acpx), hermes: no per-skill native
 *     convention we can rely on, so skills get inlined into AGENTS.md as
 *     a `## Available Skills` section. Codex reads project-root AGENTS.md
 *     natively, so this works out of the box for it. Hermes sees the
 *     section as part of its system context.
 *   - gemini-cli: extensions live as `.gemini/extensions/<id>/GEMINI.md`
 *     with a `gemini-extension.json` manifest. Generating those manifests
 *     correctly is out of scope for v1; we fall back to inlining for now.
 *
 * Skill content is fetched from KV (manifest) + R2 (file bytes), keyed
 * off the same `t:{tenant}:skillver:{id}:{ver}` / `skillFileR2Key()`
 * schema apps/agent uses (see skills.ts:91). Falls back to a stub when
 * content can't be fetched (skill metadata missing, R2 unset on this
 * lane, etc.) — better to write SOMETHING than to fail the whole session
 * because one skill's manifest is gone.
 */
async function renderSessionBundle(
  agent: AgentConfig,
  acpAgentId: string,
  services: Services,
  tenantId: string,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const skills = (agent.skills ?? []) as Array<{ skill_id: string; type: string; version?: string }>;
  // Canonicalize: a stored AgentConfig may carry a pre-A2 alias (e.g.
  // "claude-agent-acp" or even older "claude-code-acp"; the official
  // ACP registry's id is now "claude-acp"). Resolve via overlay so the
  // layout selector matches by current canonical id; unknown ids fall
  // through to the safe "inline" default.
  const resolved = resolveKnownAgent(acpAgentId);
  const canonicalAgentId = resolved?.id ?? acpAgentId;
  const layout: "claude-skills" | "opencode-agents" | "inline" =
    canonicalAgentId === "claude-acp" ? "claude-skills"
    : canonicalAgentId === "opencode" ? "opencode-agents"
    : "inline";

  let agentsMd = `# ${agent.name ?? "OMA Agent"}\n\n`;
  if (agent.description) agentsMd += `${agent.description}\n\n`;
  if (agent.system) agentsMd += `## System Instructions\n\n${agent.system}\n\n`;
  for (const p of agent.appendable_prompts ?? []) {
    agentsMd += `## ${p}\n\n(appendable prompt: ${p})\n\n`;
  }

  if (skills.length > 0) {
    if (layout === "claude-skills") {
      agentsMd += `## Skills available\n\nClaude Code skills are mounted under \`.claude/skills/\`. Available:\n`;
      for (const s of skills) agentsMd += `- ${s.skill_id} (v${s.version ?? "latest"})\n`;
      agentsMd += "\n";
      for (const s of skills) {
        const content = await loadSkillSkillMd(services, tenantId, s.skill_id, s.version);
        files.push({
          path: `.claude/skills/${s.skill_id}/SKILL.md`,
          content: content ?? `# ${s.skill_id}\n\nSkill ${s.skill_id} (type=${s.type}, version=${s.version ?? "latest"}). Content not bundled — manifest or R2 fetch failed.\n`,
        });
      }
    } else if (layout === "opencode-agents") {
      agentsMd += `## Skills available\n\nOpenCode subagents are materialized under \`.opencode/agents/\`. Available:\n`;
      for (const s of skills) agentsMd += `- ${s.skill_id} (v${s.version ?? "latest"})\n`;
      agentsMd += "\n";
      for (const s of skills) {
        const content = await loadSkillSkillMd(services, tenantId, s.skill_id, s.version);
        files.push({
          path: `.opencode/agents/${s.skill_id}.md`,
          content: content ?? `---\ndescription: ${s.skill_id} (content unavailable)\nmode: subagent\n---\n\nSkill ${s.skill_id} (type=${s.type}, version=${s.version ?? "latest"}). Content not bundled — manifest or R2 fetch failed.\n`,
        });
      }
    } else {
      // Inline path: drop full skill content into AGENTS.md so codex /
      // Hermes reads it as part of its system prompt. We
      // still try to load the real SKILL.md (was missing pre-v2 — only
      // the type/version line was emitted).
      agentsMd += `## Available Skills\n\n`;
      for (const s of skills) {
        const content = await loadSkillSkillMd(services, tenantId, s.skill_id, s.version);
        agentsMd += `### ${s.skill_id} (v${s.version ?? "latest"})\n\n`;
        if (content) {
          // Strip leading frontmatter so the inline section reads as one
          // coherent doc (frontmatter inside another doc just clutters
          // the model's context).
          const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
          agentsMd += stripped.trim() + "\n\n";
        } else {
          agentsMd += `(Skill content unavailable; type=${s.type})\n\n`;
        }
      }
    }
  }

  files.unshift({ path: "AGENTS.md", content: agentsMd });
  return files;
}

/**
 * Pull a skill's SKILL.md from KV-recorded manifest + R2 storage. Returns
 * null when anything in the chain is missing — caller falls back to a
 * stub so a single bad skill doesn't break the whole spawn-cwd bundle.
 *
 * Mirrors the lookup chain in apps/agent/src/harness/skills.ts:91 so a
 * skill that mounts in cloud sandbox also mounts identically in a daemon
 * spawn-cwd. Binary skill files (icons, fonts, etc.) are deliberately
 * not bundled: BundleFile.content is utf-8 string only — base64-encoding
 * binary into JSON is a follow-up. SKILL.md is the load-bearing file
 * (Claude Code reads it as the entry point); attachments are nice-to-have.
 */
async function loadSkillSkillMd(
  services: Services,
  tenantId: string,
  skillId: string,
  version?: string,
): Promise<string | null> {
  if (!services.filesBlob) return null;
  try {
    const metaRaw = await services.kv.get(`t:${tenantId}:skill:${skillId}`);
    if (!metaRaw) return null;
    const meta = JSON.parse(metaRaw) as { latest_version?: string };
    const ver = (version && version !== "latest") ? version : meta.latest_version;
    if (!ver) return null;
    const obj = await services.filesBlob.get(skillFileR2Key(tenantId, skillId, ver, "SKILL.md"));
    if (!obj) return null;
    return await obj.text();
  } catch {
    return null;
  }
}

/**
 * Helper for the WS /agents/runtime/_attach upgrade route in index.ts.
 * Validates a Bearer sk_machine_* against runtime_tokens, returns the
 * runtime row on success — plus the full set of tenants the runtime is
 * authorized for via the `runtime_tenants` join table.
 *
 * `tenant_id` is kept for back-compat: today's callers (bundle route,
 * _attach upgrade) still resolve through `runtimes.owner_tenant_id` (the
 * "primary" / first tenant the runtime was registered with). The new
 * `authorized_tenants` set is what step 2 of the rollout will check
 * against per-message `tenant_id` on WS frames.
 */
export async function authenticateRuntimeToken(
  env: Env,
  bearer: string,
): Promise<{
  runtime_id: string;
  user_id: string;
  tenant_id: string;
  authorized_tenants: Set<string>;
} | null> {
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (!token.startsWith("sk_machine_")) return null;
  const hash = await sha256(token);
  const row = await env.MAIN_DB
    .prepare(
      `SELECT t.runtime_id AS runtime_id, r.owner_user_id AS user_id, r.owner_tenant_id AS tenant_id
       FROM "runtime_tokens" t JOIN "runtimes" r ON r.id = t.runtime_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .bind(hash)
    .first<{ runtime_id: string; user_id: string; tenant_id: string }>();
  if (!row) return null;
  const tenantRows = await env.MAIN_DB
    .prepare(`SELECT tenant_id FROM "runtime_tenants" WHERE runtime_id = ? AND revoked_at IS NULL`)
    .bind(row.runtime_id)
    .all<{ tenant_id: string }>();
  const authorized_tenants = new Set((tenantRows.results ?? []).map((r) => r.tenant_id));
  // Defensive: backfill rows always include owner_tenant_id, but if a
  // runtime predates the join-table backfill for any reason, fall back
  // to its primary tenant so step-1 callers never see an empty set.
  if (authorized_tenants.size === 0) authorized_tenants.add(row.tenant_id);
  // Best-effort last_used_at refresh; don't block on it.
  env.MAIN_DB
    .prepare(`UPDATE "runtime_tokens" SET last_used_at = unixepoch() WHERE token_hash = ?`)
    .bind(hash)
    .run()
    .catch(() => {});
  return { ...row, authorized_tenants };
}
