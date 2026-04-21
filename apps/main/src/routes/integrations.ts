import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  CryptoIdGenerator,
  D1AppRepo,
  D1InstallationRepo,
  D1PublicationRepo,
  WebCryptoAesGcm,
} from "@open-managed-agents/integrations-adapters-cf";
import type { CapabilityKey, Persona, Publication, SessionGranularity } from "@open-managed-agents/integrations-core";

// User-facing read/manage endpoints for integrations data. Mounted at
// /v1/integrations/*. Auth comes from the public authMiddleware (tenant_id +
// inline session lookup for user_id).
//
// Write side of installs (OAuth, webhooks) lives in apps/integrations gateway;
// this file is just CRUD on top of the shared D1 tables for the Console UI.

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>();

// Per-route guard: Linear endpoints are user-scoped (publications belong to a
// specific user, not just a tenant). The global authMiddleware sets user_id
// for both session cookies AND API keys (when the key was created with a
// known user). Reject early with a clear remediation if it's missing — that
// means a legacy API key minted before user_id was tracked, or the static
// API_KEY env var, or some other tenant-only credential.
app.use("*", async (c, next) => {
  if (c.get("user_id")) return next();
  return c.json(
    {
      error:
        "user-scoped endpoint: regenerate your API key (legacy keys lack user_id) or sign in with a session cookie",
    },
    403,
  );
});

function buildRepos(env: Env, signingKey: string) {
  const crypto = new WebCryptoAesGcm(signingKey, "integrations.tokens");
  const ids = new CryptoIdGenerator();
  return {
    installations: new D1InstallationRepo(env.AUTH_DB, crypto, ids),
    publications: new D1PublicationRepo(env.AUTH_DB, ids),
    apps: new D1AppRepo(env.AUTH_DB, crypto, ids),
  };
}

function getSigningKey(env: Env): string | null {
  // Reuse the same MCP_SIGNING_KEY the gateway uses; main needs it to decrypt
  // tokens for display (we don't actually decrypt for read endpoints, but the
  // crypto instance is required by the repo constructor).
  const k = (env as unknown as Record<string, unknown>).MCP_SIGNING_KEY;
  return typeof k === "string" ? k : null;
}

// ─── GET /v1/integrations/linear/installations ───────────────────────────

app.get("/linear/installations", async (c) => {
  const userId = c.get("user_id")!;
  const signingKey = getSigningKey(c.env);
  if (!signingKey) return c.json({ error: "MCP_SIGNING_KEY not configured" }, 503);
  const repos = buildRepos(c.env, signingKey);
  const installations = await repos.installations.listByUser(userId, "linear");
  return c.json({
    data: installations.map((i) => ({
      id: i.id,
      workspace_id: i.workspaceId,
      workspace_name: i.workspaceName,
      install_kind: i.installKind,
      bot_user_id: i.botUserId,
      vault_id: i.vaultId,
      created_at: i.createdAt,
    })),
  });
});

// ─── GET /v1/integrations/linear/installations/:id/publications ──────────

app.get("/linear/installations/:id/publications", async (c) => {
  const userId = c.get("user_id")!;
  const installationId = c.req.param("id");
  const signingKey = getSigningKey(c.env);
  if (!signingKey) return c.json({ error: "MCP_SIGNING_KEY not configured" }, 503);
  const repos = buildRepos(c.env, signingKey);
  const installation = await repos.installations.get(installationId);
  if (!installation || installation.userId !== userId) {
    return c.json({ error: "not found" }, 404);
  }
  const publications = await repos.publications.listByInstallation(installationId);
  return c.json({
    data: publications.map(serializePublication),
  });
});

// ─── GET /v1/integrations/linear/publications/:id ────────────────────────

app.get("/linear/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const signingKey = getSigningKey(c.env);
  if (!signingKey) return c.json({ error: "MCP_SIGNING_KEY not configured" }, 503);
  const repos = buildRepos(c.env, signingKey);
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  return c.json(serializePublication(pub));
});

// ─── PATCH /v1/integrations/linear/publications/:id ──────────────────────

interface PatchBody {
  persona?: Partial<Persona>;
  capabilities?: CapabilityKey[];
  session_granularity?: SessionGranularity;
}

app.patch("/linear/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const body = await c.req.json<PatchBody>();
  const signingKey = getSigningKey(c.env);
  if (!signingKey) return c.json({ error: "MCP_SIGNING_KEY not configured" }, 503);
  const repos = buildRepos(c.env, signingKey);
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);

  if (body.persona) {
    const merged: Persona = {
      name: body.persona.name ?? pub.persona.name,
      avatarUrl:
        body.persona.avatarUrl !== undefined
          ? body.persona.avatarUrl
          : pub.persona.avatarUrl,
    };
    await repos.publications.updatePersona(id, merged);
  }
  if (body.capabilities) {
    await repos.publications.updateCapabilities(id, new Set(body.capabilities));
  }
  // session_granularity intentionally not exposed for update via PATCH yet —
  // changing it mid-flight has lifecycle implications. Add when we model the
  // transition properly (drain in-flight per_issue sessions, etc.).

  const updated = await repos.publications.get(id);
  return c.json(updated ? serializePublication(updated) : { id });
});

// ─── DELETE /v1/integrations/linear/publications/:id ─────────────────────

app.delete("/linear/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const signingKey = getSigningKey(c.env);
  if (!signingKey) return c.json({ error: "MCP_SIGNING_KEY not configured" }, 503);
  const repos = buildRepos(c.env, signingKey);
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  await repos.publications.markUnpublished(id, Date.now());
  return c.json({ id, status: "unpublished" });
});

// ─── Install proxy endpoints ─────────────────────────────────────────────
//
// The install/OAuth flow is implemented in apps/integrations (which holds
// secrets and signs state JWTs). The Console talks to /v1/integrations/* on
// main; main proxies these calls to the gateway via the INTEGRATIONS service
// binding so Console stays single-origin (no CORS).

app.post("/linear/start-a1", async (c) => {
  const userId = c.get("user_id")!;
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/linear/publications/start-a1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ ...body, userId }),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/linear/credentials", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  // /credentials is publicly reachable on the gateway (no internal secret) —
  // formToken JWT is the auth there. Just forward.
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/linear/publications/credentials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/linear/handoff-link", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/linear/publications/handoff-link`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function serializePublication(p: Publication) {
  return {
    id: p.id,
    user_id: p.userId,
    agent_id: p.agentId,
    installation_id: p.installationId,
    environment_id: p.environmentId,
    mode: p.mode,
    status: p.status,
    persona: p.persona,
    capabilities: [...p.capabilities],
    session_granularity: p.sessionGranularity,
    created_at: p.createdAt,
    unpublished_at: p.unpublishedAt,
  };
}

export default app;
