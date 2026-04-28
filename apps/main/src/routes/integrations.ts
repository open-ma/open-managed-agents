import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  buildCfRepos,
  CryptoIdGenerator,
  D1SlackAppRepo,
  D1SlackInstallationRepo,
  D1SlackPublicationRepo,
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

/**
 * Build the integrations repo bag for this request. Returns null with a 503
 * Response when MCP_SIGNING_KEY is missing — caller should `return` it.
 *
 * apps/main consumes only the repo half of the integrations Container; the
 * SessionCreator/VaultManager half lives in apps/integrations because it
 * needs the MAIN service binding (which apps/main does not have on itself).
 */
function reposOr503(c: { env: Env; json: (b: unknown, s?: number) => Response }) {
  const k = (c.env as unknown as Record<string, unknown>).MCP_SIGNING_KEY;
  if (typeof k !== "string" || !k) {
    return { repos: null, err: c.json({ error: "MCP_SIGNING_KEY not configured" }, 503) as Response };
  }
  return { repos: buildCfRepos({ db: c.env.AUTH_DB, controlPlaneDb: c.env.AUTH_DB, MCP_SIGNING_KEY: k }), err: null };
}

/**
 * Slack uses parallel slack_* tables (dual-token model doesn't fit the shared
 * installations schema). Build slack-specific repos for the same auth/tenant
 * setup the linear/github routes use.
 */
function slackReposOr503(c: { env: Env; json: (b: unknown, s?: number) => Response }) {
  const k = (c.env as unknown as Record<string, unknown>).MCP_SIGNING_KEY;
  if (typeof k !== "string" || !k) {
    return { repos: null, err: c.json({ error: "MCP_SIGNING_KEY not configured" }, 503) as Response };
  }
  const crypto = new WebCryptoAesGcm(k, "integrations.tokens");
  const ids = new CryptoIdGenerator();
  return {
    repos: {
      installations: new D1SlackInstallationRepo(c.env.AUTH_DB, crypto, ids),
      publications: new D1SlackPublicationRepo(c.env.AUTH_DB, ids),
      apps: new D1SlackAppRepo(c.env.AUTH_DB, crypto, ids),
    },
    err: null,
  };
}

// ─── GET /v1/integrations/linear/installations ───────────────────────────

app.get("/linear/installations", async (c) => {
  const userId = c.get("user_id")!;
  const { repos, err } = reposOr503(c);
  if (err) return err;
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
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const installation = await repos.installations.get(installationId);
  if (!installation || installation.userId !== userId) {
    return c.json({ error: "not found" }, 404);
  }
  const publications = await repos.publications.listByInstallation(installationId);
  return c.json({
    data: publications.map(serializePublication),
  });
});

// ─── GET /v1/integrations/linear/agents/:id/publications ─────────────────
// Reverse lookup: list every Linear publication that references this agent.
// Console's AgentDetail page calls this to render "Published to Linear"
// chips. Without it the request 404s and the chip silently disappears.
// (Slack already has the parallel route at /slack/agents/:id/publications.)
app.get("/linear/agents/:id/publications", async (c) => {
  const userId = c.get("user_id")!;
  const agentId = c.req.param("id");
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const publications = await repos.publications.listByUserAndAgent(userId, agentId);
  return c.json({ data: publications.map(serializePublication) });
});

// ─── GET /v1/integrations/linear/publications/:id ────────────────────────

app.get("/linear/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const { repos, err } = reposOr503(c);
  if (err) return err;
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
  const { repos, err } = reposOr503(c);
  if (err) return err;
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
  const { repos, err } = reposOr503(c);
  if (err) return err;
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

// ─── GitHub: list + manage ───────────────────────────────────────────────
//
// GitHub publications share `linear_installations` / `linear_publications`
// (those tables already carry a provider_id column for multi-provider use).
// The github_apps table holds the GitHub-specific App credentials separately
// from linear_apps because GitHub Apps have extra fields (private key, slug,
// bot login). See packages/github for the provider implementation.

app.get("/github/installations", async (c) => {
  const userId = c.get("user_id")!;
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const installations = await repos.installations.listByUser(userId, "github");
  return c.json({
    data: installations.map((i) => ({
      id: i.id,
      // For GitHub the workspace_id IS the numeric installation_id; the
      // workspace_name is the org or user login.
      workspace_id: i.workspaceId,
      workspace_name: i.workspaceName,
      install_kind: i.installKind,
      bot_login: i.botUserId,
      vault_id: i.vaultId,
      created_at: i.createdAt,
    })),
  });
});

app.get("/github/installations/:id/publications", async (c) => {
  const userId = c.get("user_id")!;
  const installationId = c.req.param("id");
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const installation = await repos.installations.get(installationId);
  if (!installation || installation.userId !== userId) {
    return c.json({ error: "not found" }, 404);
  }
  const publications = await repos.publications.listByInstallation(installationId);
  return c.json({
    data: publications.map(serializePublication),
  });
});

app.get("/github/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  return c.json(serializePublication(pub));
});

app.patch("/github/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const body = await c.req.json<PatchBody>();
  const { repos, err } = reposOr503(c);
  if (err) return err;
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

  const updated = await repos.publications.get(id);
  return c.json(updated ? serializePublication(updated) : { id });
});

app.delete("/github/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const { repos, err } = reposOr503(c);
  if (err) return err;
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  await repos.publications.markUnpublished(id, Date.now());
  return c.json({ id, status: "unpublished" });
});

// ─── GitHub install proxy endpoints ──────────────────────────────────────

app.post("/github/start-a1", async (c) => {
  const userId = c.get("user_id")!;
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/github/publications/start-a1`,
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

app.post("/github/credentials", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/github/publications/credentials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/github/handoff-link", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/github/publications/handoff-link`,
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

// ─── Slack: list + manage ────────────────────────────────────────────────
//
// Slack runs against parallel slack_* tables (dual-token: xoxb- bot + xoxp-
// user; refresh-token shape doesn't fit the shared linear_installations
// schema). Same CRUD shape as Linear, just hitting a different repo bag.

app.get("/slack/installations", async (c) => {
  const userId = c.get("user_id")!;
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
  const installations = await repos.installations.listByUser(userId, "slack");
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

app.get("/slack/installations/:id/publications", async (c) => {
  const userId = c.get("user_id")!;
  const installationId = c.req.param("id");
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
  const installation = await repos.installations.get(installationId);
  if (!installation || installation.userId !== userId) {
    return c.json({ error: "not found" }, 404);
  }
  const publications = await repos.publications.listByInstallation(installationId);
  return c.json({ data: publications.map(serializePublication) });
});

// ─── GET /v1/integrations/slack/agents/:id/publications ──────────────────
// Reverse lookup: list every Slack publication that references this agent.
// Console's AgentDetail page calls this to render "Published to Slack" chips.
// Without it the request 404s and the chip silently disappears.
app.get("/slack/agents/:id/publications", async (c) => {
  const userId = c.get("user_id")!;
  const agentId = c.req.param("id");
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
  const publications = await repos.publications.listByUserAndAgent(userId, agentId);
  return c.json({ data: publications.map(serializePublication) });
});

app.get("/slack/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  return c.json(serializePublication(pub));
});

app.patch("/slack/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const body = await c.req.json<PatchBody>();
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
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
  const updated = await repos.publications.get(id);
  return c.json(updated ? serializePublication(updated) : { id });
});

app.delete("/slack/publications/:id", async (c) => {
  const userId = c.get("user_id")!;
  const id = c.req.param("id");
  const { repos, err } = slackReposOr503(c);
  if (err) return err;
  const pub = await repos.publications.get(id);
  if (!pub || pub.userId !== userId) return c.json({ error: "not found" }, 404);
  await repos.publications.markUnpublished(id, Date.now());
  return c.json({ id, status: "unpublished" });
});

// ─── Slack: install proxies (forward to gateway) ─────────────────────────

app.post("/slack/start-a1", async (c) => {
  const userId = c.get("user_id")!;
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/slack/publications/start-a1`,
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

app.post("/slack/credentials", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/slack/publications/credentials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/slack/handoff-link", async (c) => {
  const body = await c.req.json();
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  const internalSecret = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!internalSecret) return c.json({ error: "INTEGRATIONS_INTERNAL_SECRET not configured" }, 503);
  const res = await c.env.INTEGRATIONS.fetch(
    `http://gateway/slack/publications/handoff-link`,
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
