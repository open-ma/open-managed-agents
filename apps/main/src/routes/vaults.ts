import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { VaultConfig, CredentialConfig, CredentialAuth } from "@open-managed-agents/shared";
import { generateVaultId, generateCredentialId } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "../kv-helpers";

const SECRET_FIELDS: (keyof CredentialAuth)[] = [
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
];

function stripSecrets(cred: CredentialConfig): CredentialConfig {
  const auth = { ...cred.auth };
  for (const field of SECRET_FIELDS) {
    if (field in auth) {
      delete auth[field];
    }
  }
  return { ...cred, auth };
}

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

// ─── Vault endpoints ───

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

  const list = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "vault") });
  const vaults = (
    await Promise.all(
      list.keys
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

// POST /v1/vaults/:id/archive — archive vault
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "vault", id));
  if (!data) return c.json({ error: "Vault not found" }, 404);

  const vault: VaultConfig = JSON.parse(data);
  vault.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(kvKey(t, "vault", id), JSON.stringify(vault));

  // Cascading archive: archive all credentials in this vault
  const credList = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "cred", id) });
  await Promise.all(
    credList.keys.map(async (k) => {
      const credData = await c.env.CONFIG_KV.get(k.name);
      if (credData) {
        const cred: CredentialConfig = JSON.parse(credData);
        if (!cred.archived_at) {
          cred.archived_at = vault.archived_at;
          await c.env.CONFIG_KV.put(k.name, JSON.stringify(cred));
        }
      }
    })
  );

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

// ─── Credential endpoints (nested under vaults) ───

// POST /v1/vaults/:id/credentials — add credential
app.post("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId));
  if (!vaultData) return c.json({ error: "Vault not found" }, 404);

  const body = await c.req.json<{
    display_name: string;
    auth: CredentialAuth;
  }>();

  if (!body.display_name || !body.auth) {
    return c.json({ error: "display_name and auth are required" }, 400);
  }

  // Max 20 credentials per vault
  const credList = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "cred", vaultId) });
  if (credList.keys.length >= 20) {
    return c.json({ error: "Maximum 20 credentials per vault" }, 400);
  }

  // One credential per mcp_server_url (among non-archived creds)
  if (body.auth.mcp_server_url) {
    const existingCreds = await Promise.all(
      credList.keys.map(async (k) => {
        const d = await c.env.CONFIG_KV.get(k.name);
        return d ? (JSON.parse(d) as CredentialConfig) : null;
      })
    );
    const duplicate = existingCreds.find(
      (cr) => cr && !cr.archived_at && cr.auth.mcp_server_url === body.auth.mcp_server_url
    );
    if (duplicate) {
      return c.json({ error: "A credential with this mcp_server_url already exists" }, 409);
    }
  }

  const cred: CredentialConfig = {
    id: generateCredentialId(),
    vault_id: vaultId,
    display_name: body.display_name,
    auth: body.auth,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(kvKey(t, "cred", vaultId, cred.id), JSON.stringify(cred));
  return c.json(stripSecrets(cred), 201);
});

// GET /v1/vaults/:id/credentials — list credentials
app.get("/:id/credentials", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const vaultData = await c.env.CONFIG_KV.get(kvKey(t, "vault", vaultId));
  if (!vaultData) return c.json({ error: "Vault not found" }, 404);

  const list = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "cred", vaultId) });
  const creds = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? (JSON.parse(data) as CredentialConfig) : null;
      })
    )
  ).filter(Boolean) as CredentialConfig[];

  return c.json({ data: creds.map(stripSecrets) });
});

// POST /v1/vaults/:id/credentials/:cred_id — update credential
app.post("/:id/credentials/:cred_id", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");
  const key = kvKey(t, "cred", vaultId, credId);

  const data = await c.env.CONFIG_KV.get(key);
  if (!data) return c.json({ error: "Credential not found" }, 404);

  const cred: CredentialConfig = JSON.parse(data);
  const body = await c.req.json<{
    display_name?: string;
    auth?: Partial<CredentialAuth>;
  }>();

  if (body.auth?.mcp_server_url !== undefined && body.auth.mcp_server_url !== cred.auth.mcp_server_url) {
    return c.json({ error: "mcp_server_url is immutable" }, 400);
  }

  if (body.display_name !== undefined) cred.display_name = body.display_name;
  if (body.auth !== undefined) cred.auth = { ...cred.auth, ...body.auth };
  cred.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(key, JSON.stringify(cred));
  return c.json(stripSecrets(cred));
});

// POST /v1/vaults/:id/credentials/:cred_id/archive — archive credential
app.post("/:id/credentials/:cred_id/archive", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");
  const key = kvKey(t, "cred", vaultId, credId);

  const data = await c.env.CONFIG_KV.get(key);
  if (!data) return c.json({ error: "Credential not found" }, 404);

  const cred: CredentialConfig = JSON.parse(data);
  cred.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(key, JSON.stringify(cred));
  return c.json(stripSecrets(cred));
});

// DELETE /v1/vaults/:id/credentials/:cred_id — delete credential
app.delete("/:id/credentials/:cred_id", async (c) => {
  const t = c.get("tenant_id");
  const vaultId = c.req.param("id");
  const credId = c.req.param("cred_id");
  const key = kvKey(t, "cred", vaultId, credId);

  const data = await c.env.CONFIG_KV.get(key);
  if (!data) return c.json({ error: "Credential not found" }, 404);

  await c.env.CONFIG_KV.delete(key);
  return c.json({ type: "credential_deleted", id: credId });
});

export default app;
