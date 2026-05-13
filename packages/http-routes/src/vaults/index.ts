// Vaults + credentials routes — full CRUD with stripSecrets on every read,
// mcp_oauth_validate, and the cross-store cascade-archive of credentials
// when a vault is archived.

import { Hono } from "hono";
import {
  CredentialDuplicateMcpUrlError,
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
  stripSecrets,
} from "@open-managed-agents/credentials-store";
import { VaultNotFoundError } from "@open-managed-agents/vaults-store";
import {
  buildAuthHeader,
  refreshMetadataOf,
  refreshMcpOAuth,
} from "@open-managed-agents/vault-forward";
import type {
  CredentialAuth,
  CredentialConfig,
} from "@open-managed-agents/shared";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

function handleError(err: unknown): Response {
  if (err instanceof VaultNotFoundError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialNotFoundError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialMaxExceededError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialDuplicateMcpUrlError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialImmutableFieldError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  throw err;
}

interface VaultRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
function toApiVault(v: VaultRow) {
  return {
    type: "vault" as const,
    id: v.id,
    name: v.name,
    created_at: v.created_at,
    updated_at: v.updated_at,
    archived_at: v.archived_at,
  };
}

interface CredRowSliced {
  id: string;
  vault_id: string;
  display_name: string;
  auth: unknown;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
function toApiCred<T extends CredRowSliced>(c: T) {
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

export interface VaultRoutesDeps {
  services: RouteServicesArg;
}

export function buildVaultRoutes(deps: VaultRoutesDeps) {
  const app = new Hono<Vars>();

  // ── Vaults ────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const body = await c.req.json<{ name: string }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const v = await services.vaults.create({ tenantId: t, name: body.name });
    return c.json(toApiVault(v as unknown as VaultRow), 201);
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") || undefined;
    const includeArchived = c.req.query("include_archived") === "true";
    const page = await services.vaults.listPage({
      tenantId: t,
      limit,
      cursor,
      includeArchived,
    });
    return c.json({
      data: page.items.map((v) => toApiVault(v as unknown as VaultRow)),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const v = await services.vaults.get({
      tenantId: c.var.tenant_id,
      vaultId: c.req.param("id"),
    });
    if (!v) return c.json({ error: "Vault not found" }, 404);
    return c.json(toApiVault(v as unknown as VaultRow));
  });

  // POST/PUT — Anthropic SDK uses POST; PUT accepted for compat.
  const updateVault = async (c: import("hono").Context<Vars, "/:id">) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      display_name?: string;
      name?: string;
    }>();
    try {
      const v = await services.vaults.update({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        name: body.display_name ?? body.name,
      });
      return c.json(toApiVault(v as unknown as VaultRow));
    } catch (err) {
      return handleError(err);
    }
  };
  app.put("/:id", updateVault);
  app.post("/:id", updateVault);

  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    try {
      const v = await services.vaults.archive({ tenantId: t, vaultId: id });
      // Cross-store cascade: archive every active credential in this vault.
      await services.credentials.archiveByVault({ tenantId: t, vaultId: id });
      return c.json(toApiVault(v as unknown as VaultRow));
    } catch (err) {
      return handleError(err);
    }
  });

  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.vaults.delete({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
      });
      return c.json({ type: "vault_deleted", id: c.req.param("id") });
    } catch (err) {
      return handleError(err);
    }
  });

  // ── Credentials (nested under vaults) ─────────────────────────────────
  app.post("/:id/credentials", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId: t, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    const body = await c.req.json<{
      display_name: string;
      auth: CredentialAuth;
    }>();
    if (!body.display_name || !body.auth) {
      return c.json({ error: "display_name and auth are required" }, 400);
    }
    try {
      const cred = await services.credentials.create({
        tenantId: t,
        vaultId,
        displayName: body.display_name,
        auth: body.auth,
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced), 201);
    } catch (err) {
      return handleError(err);
    }
  });

  app.get("/:id/credentials", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId: t, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    try {
      const creds = await services.credentials.list({ tenantId: t, vaultId });
      return c.json({
        data: creds.map((c) => toApiCred(stripSecrets(c) as unknown as CredRowSliced)),
      });
    } catch (err) {
      return handleError(err);
    }
  });

  app.get("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const cred = await services.credentials.get({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      if (!cred) return c.json({ error: "Credential not found" }, 404);
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  app.post("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      display_name?: string;
      auth?: Partial<CredentialAuth>;
    }>();
    try {
      const cred = await services.credentials.update({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
        displayName: body.display_name,
        auth: body.auth,
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  // POST /v1/vaults/:id/credentials/:cred_id/mcp_oauth_validate — verify the
  // stored OAuth credential by attempting a refresh against its
  // token_endpoint. Returns 200 with the refreshed access_token on success,
  // 502 when the endpoint is unreachable, or 400 when the credential isn't
  // an mcp_oauth type.
  app.post("/:id/credentials/:cred_id/mcp_oauth_validate", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const cred = await services.credentials
      .get({
        tenantId: t,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      })
      .catch(() => null);
    if (!cred) return c.json({ error: "Credential not found" }, 404);
    const auth = (cred as unknown as CredentialConfig).auth;
    const meta = refreshMetadataOf(auth);
    if (!meta) {
      return c.json(
        { error: "Credential is not mcp_oauth or has no refresh_token / token_endpoint" },
        400,
      );
    }
    const refreshed = await refreshMcpOAuth(meta);
    if (!refreshed) {
      return c.json({ error: "token_endpoint unreachable or refresh refused" }, 502);
    }
    try {
      await services.credentials.refreshAuth({
        tenantId: t,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
        auth: {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
            : undefined,
        },
      });
    } catch {
      // Best-effort persist; the validation call itself was a success.
    }
    return c.json({
      type: "mcp_oauth_validation",
      validated: true,
      expires_in: refreshed.expires_in ?? null,
    });
  });

  app.post("/:id/credentials/:cred_id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const cred = await services.credentials.archive({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  app.delete("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.credentials.delete({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      return c.json({ type: "credential_deleted", id: c.req.param("cred_id") });
    } catch (err) {
      return handleError(err);
    }
  });

  // Suppress unused-import lint when route paths skip a code path.
  void buildAuthHeader;

  return app;
}
