// Tenants + me routes — workspace creation, current user, memberships,
// CLI token mint. Uses sql directly for tenant + membership reads since
// neither runtime exposes a "tenants service" abstraction yet.
//
// Differences vs CF:
//   - CF runs `shardPool.pickShardForNewTenant` after the tenant insert
//     so the new workspace's reads land on the right shard. Node has no
//     shard router; the create-tenant skip on Node is signalled by
//     `assignShard` being undefined.
//   - The /me/cli-tokens route reuses the api_keys table (kv on CF;
//     SQL row on Node) — both paths look identical from the route's POV.

import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

interface MembershipRow {
  id: string;
  name: string;
  role: string;
  created_at: number;
}

export interface TenantRoutesDeps {
  services: RouteServicesArg;
  /** Optional CF shard assignment. Returning binding name records the new
   *  tenant's shard in the control-plane DB. Node leaves this undefined. */
  assignShard?: (tenantId: string) => Promise<void>;
  /** Build the membership rows shape the runtime returns. CF returns
   *  unix-second timestamps; Node returns ms — let the runtime decide. */
  listMemberships?: (userId: string) => Promise<MembershipRow[]>;
  /** Where to write the tenant + membership rows on create. CF wraps
   *  D1.batch over the legacy `tenant`/`membership` tables (camelCase
   *  columns); Node uses the snake_case tenant tables. Returning the
   *  tenant_id confirms the insert. */
  createTenantAndMembership?: (input: {
    tenantId: string;
    name: string;
    userId: string;
  }) => Promise<void>;
}

export function buildTenantRoutes(deps: TenantRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/", async (c) => {
    const userId = c.var.user_id;
    if (!userId) {
      return c.json({ error: "Cookie session required to create workspaces" }, 403);
    }
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const name = (body.name ?? "").trim().slice(0, 80);
    if (!name) return c.json({ error: "name is required" }, 400);

    const tenantId = `tn_${nanoid(16)}`;

    if (deps.createTenantAndMembership) {
      await deps.createTenantAndMembership({ tenantId, name, userId });
    } else {
      const services = resolveServices(deps.services, c);
      const now = Date.now();
      await services.sql
        .prepare(
          `INSERT INTO "tenant" (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(tenantId, name, now, now)
        .run();
      await services.sql
        .prepare(
          `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
           VALUES (?, ?, 'owner', ?)
           ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        )
        .bind(userId, tenantId, now)
        .run();
    }

    if (deps.assignShard) {
      await deps.assignShard(tenantId);
    }

    return c.json(
      {
        id: tenantId,
        name,
        role: "owner",
        created_at: Date.now(),
      },
      201,
    );
  });

  return app;
}

export interface MeRoutesDeps {
  services: RouteServicesArg;
  authDisabled: boolean;
  /** Look up the user row by id. CF queries env.AUTH_DB.user; Node
   *  returns a stub since the user lives in the better-auth db (separate
   *  connection). */
  loadUser?: (userId: string) => Promise<{
    id: string;
    email?: string;
    name?: string | null;
    role?: string;
  } | null>;
  loadTenant?: (tenantId: string) => Promise<{ id: string; name: string } | null>;
  listMemberships?: (userId: string) => Promise<MembershipRow[]>;
  /** Mint a long-lived API key. Used by POST /v1/me/cli-tokens; reuses
   *  the api-keys storage. */
  mintApiKey?: (input: {
    tenantId: string;
    userId: string;
    name: string;
    source?: string;
  }) => Promise<{ id: string; key: string; prefix: string; createdAt: string }>;
  /** Validate (user, tenant) membership for x-active-tenant-style requests
   *  on the /me/cli-tokens path. */
  hasMembership?: (userId: string, tenantId: string) => Promise<boolean>;
}

export function buildMeRoutes(deps: MeRoutesDeps) {
  const app = new Hono<Vars>();

  app.get("/", async (c) => {
    const tenantId = c.var.tenant_id;
    if (deps.authDisabled) {
      return c.json({
        user: { id: "default", email: "default@local", name: "Default User", role: "owner" },
        tenant: { id: "default", name: "Default" },
        tenants: [{ id: "default", name: "Default", role: "owner" }],
      });
    }
    const userId = c.var.user_id;
    if (!userId) {
      return c.json({
        user: null,
        tenant: { id: tenantId, name: "" },
        tenants: [{ id: tenantId, name: "", role: "member" }],
      });
    }
    const [user, tenant, memberships] = await Promise.all([
      deps.loadUser ? deps.loadUser(userId) : Promise.resolve(null),
      deps.loadTenant ? deps.loadTenant(tenantId) : Promise.resolve(null),
      deps.listMemberships ? deps.listMemberships(userId) : Promise.resolve([]),
    ]);
    return c.json({
      user: user
        ? { id: user.id, email: user.email, name: user.name }
        : { id: userId, email: "", name: "" },
      tenant: tenant ?? { id: tenantId, name: "" },
      tenants: memberships,
    });
  });

  app.get("/tenants", async (c) => {
    const userId = c.var.user_id;
    if (deps.authDisabled || !userId) {
      return c.json({ data: [{ id: c.var.tenant_id, name: "", role: "member" }] });
    }
    const ms = deps.listMemberships ? await deps.listMemberships(userId) : [];
    return c.json({ data: ms });
  });

  app.post("/cli-tokens", async (c) => {
    const userId = c.var.user_id;
    const sessionTenant = c.var.tenant_id;
    if (!userId) {
      return c.json({ error: "Cookie session required to mint CLI tokens" }, 403);
    }
    const body = await c.req
      .json<{ tenant_id?: string; name?: string }>()
      .catch(() => ({}) as { tenant_id?: string; name?: string });

    const requested = body.tenant_id ?? sessionTenant;
    if (deps.hasMembership) {
      const ok = await deps.hasMembership(userId, requested);
      if (!ok) return c.json({ error: "Not a member of the requested tenant" }, 403);
    }
    if (!deps.mintApiKey) {
      return c.json({ error: "CLI tokens not implemented on this server" }, 501);
    }
    const minted = await deps.mintApiKey({
      tenantId: requested,
      userId,
      name: body.name?.slice(0, 80) || "CLI",
      source: "cli",
    });
    return c.json(
      {
        key_id: minted.id,
        token: minted.key,
        tenant_id: requested,
        user_id: userId,
        created_at: minted.createdAt,
      },
      201,
    );
  });

  return app;
}
