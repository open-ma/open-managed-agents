import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { VaultConfig } from "@open-managed-agents/shared";
import { generateVaultId } from "@open-managed-agents/shared";
import {
  CredentialDuplicateMcpUrlError,
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
  stripSecrets,
} from "@open-managed-agents/credentials-store";
import type { Services } from "@open-managed-agents/services";
import { kvKey, kvListAll, kvPrefix } from "../kv-helpers";

// Credentials live in D1 (packages/credentials-store, OPE-7 migration). Vaults
// themselves are still in KV — out of scope for OPE-7. The two only interact
// at HTTP boundary (vault existence check + cascade archive call).
//
// Service surface comes from c.var.services (see packages/services). Wiring
// (CF / Postgres / etc.) lives in one factory; this file only sees abstract
// service interfaces.

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

function handleCredError(err: unknown): Response {
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

// ─── Vault endpoints (still KV — OPE-7 only migrates credentials) ───

// POST /v1/vaults — create vault
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const vault: VaultConfig = {
    id: generateVaultId(),
    name: body.name,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(kvKey(t, "vault", vault.id), JSON.stringify(vault));
  return c.json(vault, 201);
});

// GET /v1/vaults — list vaults
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const includeArchived = c.req.query("include_archived") === "true";

  const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "vault"));
  const vaults = (
    await Promise.all(
      list
        .filter((k) => !k.name.includes(":cred"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? (JSON.parse(data) as VaultConfig) : null;
        })
    )
  ).filter(Boolean) as VaultConfig[];

  const filtered = includeArchived
    ? vaults
    : vaults.filter((v) => !v.archived_at);

  return c.json({ data: filtered });
});

// GET /v1/vaults/:id — get vault
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "vault", id));
  if (!data) return c.json({ error: "Vault not found" }, 404);
  return c.json(JSON.parse(data));
});

// POST /v1/vaults/:id/archive — archive vault (cascades to credentials)
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "vault", id));
  if (!data) return c.json({ error: "Vault not found" }, 404);

  const vault: VaultConfig = JSON.parse(data);
  vault.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(kvKey(t, "vault", id), JSON.stringify(vault));

  // Cascade archive — single SQL UPDATE replaces the previous KV list+loop
  // (which was non-atomic). Soft FK in app layer per project convention.
  try {
    await c.var.services.credentials.archiveByVault({ tenantId: t, vaultId: id });
  } catch (err) {
    return handleCredError(err);
  }

  return c.json(vault);
});

// DELETE /v1/vaults/:id — delete vault
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "vault", id));
  if (!data) return c.json({ error: "Vault not found" }, 404);

  await c.env.CONFIG_KV.delete(kvKey(t, "vault", id));
  return c.json({ type: "vault_deleted", id });
});

// ─── Credential endpoints (now backed by D1 via credentials-store) ───

// POST /v1/vaults/:id/credentials — add credential
app.post("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId));
  if (!vaultData) return c.json({ error: "Vault not found" }, 404);

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
    return c.json(stripSecrets(cred), 201);
  } catch (err) {
    return handleCredError(err);
  }
});

// GET /v1/vaults/:id/credentials — list credentials
app.get("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId));
  if (!vaultData) return c.json({ error: "Vault not found" }, 404);

  try {
    // includeArchived defaults to true to match the historical KV behavior
    // (GET /credentials returned all rows, including archived).
    const creds = await c.var.services.credentials.list({ tenantId: t, vaultId });
    return c.json({ data: creds.map(stripSecrets) });
  } catch (err) {
    return handleCredError(err);
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
    return c.json(stripSecrets(cred));
  } catch (err) {
    return handleCredError(err);
  }
});

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
    return c.json(stripSecrets(cred));
  } catch (err) {
    return handleCredError(err);
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
    return handleCredError(err);
  }
});

export default app;
