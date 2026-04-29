/**
 * Local-runtime onboarding + management routes.
 *
 *   /v1/runtimes/*               — browser, requires user auth (authMiddleware)
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
 *   2. Browser (auth'd via Better Auth cookie) POSTs `/v1/runtimes/connect-runtime`
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
import type { Services } from "@open-managed-agents/services";

/** Browser-facing routes — mounted under /v1/runtimes. */
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

// POST /v1/runtimes/connect-runtime — browser asks for a one-time exchange code.
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

  await c.env.AUTH_DB
    .prepare(
      `INSERT INTO "connect_runtime_codes" (code, user_id, tenant_id, state, expires_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(code, userId, tenantId, state, expiresAt)
    .run();

  return c.json({ code, expires_at: expiresAt });
});

// GET /v1/runtimes — list user's runtimes.
runtimesRoutes.get("/", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { results } = await c.env.AUTH_DB
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

// DELETE /v1/runtimes/:id — revoke runtime + all its tokens.
runtimesRoutes.delete("/:id", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const id = c.req.param("id");
  const owned = await c.env.AUTH_DB
    .prepare(`SELECT id FROM "runtimes" WHERE id = ? AND owner_user_id = ?`)
    .bind(id, userId)
    .first<{ id: string }>();
  if (!owned) return c.json({ error: "not found" }, 404);

  const now = Math.floor(Date.now() / 1000);
  await c.env.AUTH_DB.batch([
    c.env.AUTH_DB
      .prepare(`UPDATE "runtime_tokens" SET revoked_at = ? WHERE runtime_id = ? AND revoked_at IS NULL`)
      .bind(now, id),
    c.env.AUTH_DB.prepare(`DELETE FROM "runtimes" WHERE id = ?`).bind(id),
  ]);

  return c.json({ ok: true });
});

// ─── Daemon-facing (no authMiddleware) ────────────────────────────────────

// POST /agents/runtime/exchange — daemon swaps code for runtime token + agent API key.
runtimeDaemonRoutes.post("/exchange", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    state?: string;
    machine_id?: string;
    hostname?: string;
    os?: string;
    version?: string;
  };

  const { code, state, machine_id, hostname, os, version } = body;
  if (!code || !state || !machine_id || !hostname || !os || !version) {
    return c.json(
      { error: "code, state, machine_id, hostname, os, version all required" },
      400,
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.AUTH_DB
    .prepare(
      `SELECT user_id, tenant_id, state, expires_at, used_at FROM "connect_runtime_codes" WHERE code = ?`,
    )
    .bind(code)
    .first<{ user_id: string; tenant_id: string; state: string; expires_at: number; used_at: number | null }>();

  if (!row) return c.json({ error: "invalid code" }, 400);
  if (row.used_at) return c.json({ error: "code already used" }, 400);
  if (row.expires_at < now) return c.json({ error: "code expired" }, 400);
  if (row.state !== state) return c.json({ error: "state mismatch" }, 400);

  await c.env.AUTH_DB
    .prepare(`UPDATE "connect_runtime_codes" SET used_at = ? WHERE code = ?`)
    .bind(now, code)
    .run();

  // Idempotent runtime insert: re-running `oma bridge setup` from same UNIX
  // user / same machine reuses the existing row.
  const existing = await c.env.AUTH_DB
    .prepare(`SELECT id FROM "runtimes" WHERE owner_user_id = ? AND machine_id = ?`)
    .bind(row.user_id, machine_id)
    .first<{ id: string }>();

  let runtimeId: string;
  if (existing) {
    runtimeId = existing.id;
    await c.env.AUTH_DB
      .prepare(`UPDATE "runtimes" SET hostname = ?, os = ?, version = ? WHERE id = ?`)
      .bind(hostname, os, version, runtimeId)
      .run();
  } else {
    runtimeId = crypto.randomUUID();
    await c.env.AUTH_DB
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
  await c.env.AUTH_DB
    .prepare(
      `INSERT INTO "runtime_tokens" (id, runtime_id, token_hash, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenId, runtimeId, tokenHash, row.user_id, now)
    .run();

  // Mint an agent-side API key the daemon will hand to ACP children for MCP
  // proxy auth. Same shape as user-created keys (KV `apikey:<sha256>` row),
  // so existing authMiddleware accepts it. Plaintext returned once.
  const agentApiKey = await issueAgentApiKey(c.env, row.user_id, row.tenant_id, hostname);

  return c.json({
    runtime_id: runtimeId,
    token: tokenPlain,
    agent_api_key: agentApiKey,
  });
});

/**
 * Mint an `oma_*` API key for daemon-spawned ACP children. Stored same way as
 * user-created keys (KV `apikey:<hash>`) so the existing /v1/* auth middleware
 * accepts it. Plaintext returned to caller once and never re-issued.
 */
async function issueAgentApiKey(
  env: Env,
  userId: string,
  tenantId: string,
  displayLabel: string,
): Promise<string> {
  const plain = generateAgentApiKey();
  const hash = await sha256(plain);
  const id = `ak_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  // Mirror the schema in routes/api-keys.ts:
  //   apikey:<hash> → { id, tenant_id, user_id, name, created_at }
  //   t:<tenant>:apikeys → [ { id, name, prefix, hash, created_at } ]
  await env.CONFIG_KV.put(
    `apikey:${hash}`,
    JSON.stringify({ id, tenant_id: tenantId, user_id: userId, name: `Local runtime (${displayLabel})`, created_at: now }),
  );
  const indexKey = `t:${tenantId}:apikeys`;
  const existing = await env.CONFIG_KV.get(indexKey);
  const index = existing ? (JSON.parse(existing) as Array<unknown>) : [];
  index.push({ id, name: `Local runtime (${displayLabel})`, prefix: plain.slice(0, 8), hash, created_at: now });
  await env.CONFIG_KV.put(indexKey, JSON.stringify(index));
  return plain;
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (!s) return [];
  try { return JSON.parse(s); } catch { return []; }
}

// ─── Daemon bundle endpoint ───────────────────────────────────────────────

// GET /agents/runtime/sessions/:sid/bundle?agent_id=<acp-agent-id>
// Returns AGENTS.md + skill files for the daemon to materialize in spawn cwd.
// Auth: Authorization: Bearer sk_machine_* — same auth the daemon uses to
// open the WS attach. Validating that the daemon owns the requested session
// would require resolving (token → user) → (sid → user) parity; we keep it
// simpler by just verifying the bearer is a valid runtime token. The bundle
// content doesn't include credentials, so the worst leak is a session's
// AGENTS.md text. If a future agent has very sensitive system prompts,
// tighten this to enforce session ownership via runtime_id ↔ session linkage.
runtimeDaemonRoutes.get("/sessions/:sid/bundle", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  const sid = c.req.param("sid");
  const acpAgentId = c.req.query("agent_id");
  if (!acpAgentId) return c.json({ error: "agent_id query required" }, 400);

  const services = c.get("services");
  const session = await services.sessions.getById({ sessionId: sid }).catch(() => null);
  if (!session) return c.json({ error: "session not found" }, 404);
  const agent = (session as { agent_snapshot?: AgentConfig }).agent_snapshot;
  if (!agent) return c.json({ error: "session has no agent snapshot" }, 500);

  const files = renderSessionBundle(agent, acpAgentId);
  // Per-agent blocklist of LOCAL skills the user has on their machine
  // — daemon enforces by NOT symlinking these into the spawn-cwd's
  // CLAUDE_CONFIG_DIR. Always send an array (possibly empty) so the
  // daemon doesn't have to handle three states (undefined / empty / set).
  const local_skill_blocklist = agent.runtime_binding?.local_skill_blocklist ?? [];
  return c.json({ files, local_skill_blocklist });
});

/**
 * Render the spawn-cwd file bundle for a given (OMA agent config, ACP agent).
 *
 * The split between AGENTS.md and `.claude/skills/...` is agent-aware:
 *   - claude-code-acp: skills get their own discoverable directory tree;
 *     AGENTS.md only carries the system prompt + appendable_prompts.
 *   - everyone else: no native skill mechanism we can rely on, so skills
 *     get inlined into AGENTS.md as a `## Available Skills` section.
 */
function renderSessionBundle(
  agent: AgentConfig,
  acpAgentId: string,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const skills = (agent.skills ?? []) as Array<{ skill_id: string; type: string; version?: string }>;
  const supportsClaudeSkillsDir = acpAgentId === "claude-code-acp";

  let agentsMd = `# ${agent.name ?? "OMA Agent"}\n\n`;
  if (agent.description) agentsMd += `${agent.description}\n\n`;
  if (agent.system) agentsMd += `## System Instructions\n\n${agent.system}\n\n`;
  for (const p of agent.appendable_prompts ?? []) {
    agentsMd += `## ${p}\n\n(appendable prompt: ${p})\n\n`;
  }

  if (skills.length > 0) {
    if (supportsClaudeSkillsDir) {
      agentsMd += `## Skills available\n\nClaude Code skills are mounted under \`.claude/skills/\`. Available:\n`;
      for (const s of skills) agentsMd += `- ${s.skill_id} (v${s.version ?? "latest"})\n`;
      agentsMd += "\n";
      for (const s of skills) {
        // v1: stub SKILL.md from agent metadata. Full skill content fetch
        // (memory_store + skill_files) lands in a follow-up — see backlog.
        files.push({
          path: `.claude/skills/${s.skill_id}/SKILL.md`,
          content: `# ${s.skill_id}\n\nSkill ${s.skill_id} (type=${s.type}, version=${s.version ?? "latest"}). Full skill content not yet bundled — see backlog.\n`,
        });
      }
    } else {
      agentsMd += `## Available Skills\n\n`;
      for (const s of skills) {
        agentsMd += `### ${s.skill_id}\n\nType: ${s.type}, version: ${s.version ?? "latest"}\n\n`;
      }
    }
  }

  files.unshift({ path: "AGENTS.md", content: agentsMd });
  return files;
}

/**
 * Helper for the WS /agents/runtime/_attach upgrade route in index.ts.
 * Validates a Bearer sk_machine_* against runtime_tokens, returns the
 * runtime row on success.
 */
export async function authenticateRuntimeToken(
  env: Env,
  bearer: string,
): Promise<{ runtime_id: string; user_id: string } | null> {
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (!token.startsWith("sk_machine_")) return null;
  const hash = await sha256(token);
  const row = await env.AUTH_DB
    .prepare(
      `SELECT t.runtime_id AS runtime_id, r.owner_user_id AS user_id
       FROM "runtime_tokens" t JOIN "runtimes" r ON r.id = t.runtime_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .bind(hash)
    .first<{ runtime_id: string; user_id: string }>();
  if (!row) return null;
  // Best-effort last_used_at refresh; don't block on it.
  env.AUTH_DB
    .prepare(`UPDATE "runtime_tokens" SET last_used_at = unixepoch() WHERE token_hash = ?`)
    .bind(hash)
    .run()
    .catch(() => {});
  return row;
}
