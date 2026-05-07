import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  CredentialDuplicateMcpUrlError,
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
  stripSecrets,
} from "@open-managed-agents/credentials-store";
import { VaultNotFoundError } from "@open-managed-agents/vaults-store";
import type { Services } from "@open-managed-agents/services";
import { jsonPage, parsePageQuery } from "../lib/list-page";

// Both vaults and credentials live in D1 (vaults-store + credentials-store).
// Service surface comes from c.var.services (see packages/services). Wiring
// (CF / Postgres / etc.) lives in one factory; this file only sees abstract
// service interfaces.
//
// Cascade-archive of credentials when a vault is archived is orchestrated
// here at the route boundary — vaults-store doesn't know credentials exist
// (and vice versa), so the cross-store cascade lives in the route handler.

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

function handleError(err: unknown): Response {
  if (err instanceof VaultNotFoundError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof CredentialNotFoundError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof CredentialMaxExceededError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof CredentialDuplicateMcpUrlError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof CredentialImmutableFieldError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  throw err;
}

/** Strip server-internal fields from a vault row before returning to API. */
function toApiVault(v: { id: string; name: string; created_at: string; updated_at: string | null; archived_at: string | null }) {
  return {
    type: "vault" as const,
    id: v.id,
    name: v.name,
    created_at: v.created_at,
    updated_at: v.updated_at,
    archived_at: v.archived_at,
  };
}

/** Strip server-internal fields from a credential row before returning to API.
 *  Caller MUST run stripSecrets() first if the response leaves the trust boundary. */
function toApiCred<T extends { id: string; vault_id: string; display_name: string; auth: unknown; created_at: string; updated_at: string | null; archived_at: string | null }>(c: T) {
  return {
    id: c.id,
    vault_id: c.vault_id,
    display_name: c.display_name,
    auth: c.auth,
    created_at: c.created_at,
    updated_at: c.updated_at,
    archived_at: c.archived_at,
  };
}

// ─── Vault endpoints ───

// POST /v1/vaults — create vault
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const vault = await c.var.services.vaults.create({
    tenantId: t,
    name: body.name,
  });
  return c.json(toApiVault(vault), 201);
});

// GET /v1/vaults — list vaults (cursor-paginated)
app.get("/", async (c) => {
  const page = await c.var.services.vaults.listPage({
    tenantId: c.get("tenant_id"),
    ...parsePageQuery(c),
  });
  return jsonPage(c, page, toApiVault);
});

// GET /v1/vaults/:id — get vault
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const vault = await c.var.services.vaults.get({ tenantId: t, vaultId: id });
  if (!vault) return c.json({ error: "Vault not found" }, 404);
  return c.json(toApiVault(vault));
});

// POST/PUT /v1/vaults/:id — update vault. Anthropic SDK uses POST; PUT accepted
// for compat. Body: { display_name?, metadata? } — `display_name` maps to our
// `name`; metadata not yet plumbed through the store, currently ignored.
app.on(["PUT", "POST"], "/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const body = await c.req.json<{
    display_name?: string;
    name?: string;
    metadata?: Record<string, string | null>;
  }>();
  try {
    const vault = await c.var.services.vaults.update({
      tenantId: t,
      vaultId: id,
      name: body.display_name ?? body.name,
    });
    return c.json(toApiVault(vault));
  } catch (err) {
    return handleError(err);
  }
});

// POST /v1/vaults/:id/archive — archive vault (cascades to credentials)
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    const vault = await c.var.services.vaults.archive({ tenantId: t, vaultId: id });
    // Cross-store cascade: archive every active credential in this vault.
    // Single SQL UPDATE in D1 — replaces the previous KV list+loop.
    await c.var.services.credentials.archiveByVault({ tenantId: t, vaultId: id });
    return c.json(toApiVault(vault));
  } catch (err) {
    return handleError(err);
  }
});

// DELETE /v1/vaults/:id — delete vault
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    await c.var.services.vaults.delete({ tenantId: t, vaultId: id });
    return c.json({ type: "vault_deleted", id });
  } catch (err) {
    return handleError(err);
  }
});

// ─── Credential endpoints (nested under vaults) ───

// POST /v1/vaults/:id/credentials — add credential
app.post("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  if (!(await c.var.services.vaults.exists({ tenantId: t, vaultId }))) {
    return c.json({ error: "Vault not found" }, 404);
  }

  const body = await c.req.json<{
    display_name: string;
    auth: import("@open-managed-agents/shared").CredentialAuth;
  }>();

  if (!body.display_name || !body.auth) {
    return c.json({ error: "display_name and auth are required" }, 400);
  }

  try {
    const cred = await c.var.services.credentials.create({
      tenantId: t,
      vaultId,
      displayName: body.display_name,
      auth: body.auth,
    });
    return c.json(toApiCred(stripSecrets(cred)), 201);
  } catch (err) {
    return handleError(err);
  }
});

// GET /v1/vaults/:id/credentials — list credentials
app.get("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  if (!(await c.var.services.vaults.exists({ tenantId: t, vaultId }))) {
    return c.json({ error: "Vault not found" }, 404);
  }

  try {
    // includeArchived defaults to true to match the historical KV behavior
    // (GET /credentials returned all rows, including archived).
    const creds = await c.var.services.credentials.list({ tenantId: t, vaultId });
    return c.json({ data: creds.map((c) => toApiCred(stripSecrets(c))) });
  } catch (err) {
    return handleError(err);
  }
});

// POST /v1/vaults/:id/credentials/:cred_id — update credential
app.post("/:id/credentials/:cred_id", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");

  const body = await c.req.json<{
    display_name?: string;
    auth?: Partial<import("@open-managed-agents/shared").CredentialAuth>;
  }>();

  try {
    const cred = await c.var.services.credentials.update({
      tenantId: t,
      vaultId,
      credentialId: credId,
      displayName: body.display_name,
      auth: body.auth,
    });
    return c.json(toApiCred(stripSecrets(cred)));
  } catch (err) {
    return handleError(err);
  }
});

// GET /v1/vaults/:id/credentials/:cred_id — single credential read.
// Anthropic SDK calls this via `client.beta.vaults.credentials.retrieve(...)`.
// Returns the credential WITHOUT secret material (stripSecrets), same contract
// as the other credential endpoints in this file.
app.get("/:id/credentials/:cred_id", async (c) => {
  const t = c.get("tenant_id");
  try {
    const cred = await c.var.services.credentials.get({
      tenantId: t,
      vaultId: c.req.param("id"),
      credentialId: c.req.param("cred_id"),
    });
    if (!cred) return c.json({ error: "Credential not found" }, 404);
    return c.json(toApiCred(stripSecrets(cred)));
  } catch (err) {
    return handleError(err);
  }
});

// POST /v1/vaults/:id/credentials/:cred_id/mcp_oauth_validate — verify the
// stored OAuth credential against the MCP server it points at. Anthropic's
// flow runs a probe handshake to check token freshness + scope. We don't
// implement live OAuth refresh on the server side yet (cred refresh happens
// inside the integrations worker on-demand at session init), so return 501.
// Follow-up: wire integrations worker's MCP probe RPC + return its result.
app.post("/:id/credentials/:cred_id/mcp_oauth_validate", (c) =>
  c.json(
    {
      error: {
        type: "not_implemented",
        message: "MCP OAuth credential validation not yet implemented on this server",
      },
      type: "error",
    },
    501,
  ),
);

// POST /v1/vaults/:id/credentials/:cred_id/archive — archive credential
app.post("/:id/credentials/:cred_id/archive", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");

  try {
    const cred = await c.var.services.credentials.archive({
      tenantId: t,
      vaultId,
      credentialId: credId,
    });
    return c.json(toApiCred(stripSecrets(cred)));
  } catch (err) {
    return handleError(err);
  }
});

// DELETE /v1/vaults/:id/credentials/:cred_id — delete credential
app.delete("/:id/credentials/:cred_id", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");

  try {
    await c.var.services.credentials.delete({ tenantId: t, vaultId, credentialId: credId });
    return c.json({ type: "credential_deleted", id: credId });
  } catch (err) {
    return handleError(err);
  }
});

export default app;
