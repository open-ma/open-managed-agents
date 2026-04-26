// /v1/tenants — tenant CRUD for the multi-tenant Console.
//
// Pattern A multi-tenant: a user can create additional workspaces beyond
// their default one, becoming the owner of each. Membership is the source
// of truth — both the new tenant and the creator's owner row are inserted
// in the same write.
//
// Invites (POST /v1/tenants/:id/memberships) and member removal land
// later — they need an email/accept flow that's bigger than this file.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>();

interface CreateBody {
  /** Display name for the workspace. Trimmed; required; max 80 chars. */
  name: string;
}

// POST /v1/tenants — create a new workspace owned by the calling user.
app.post("/", async (c) => {
  const userId = c.get("user_id");
  if (!userId) {
    return c.json({ error: "Cookie session required to create workspaces" }, 403);
  }
  const body = await c.req.json<CreateBody>().catch((err) => {
    logWarn({ op: "tenants.create.body_parse", user_id: userId, err }, "body parse failed");
    return {} as CreateBody;
  });
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const tenantId = `tn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Math.floor(Date.now() / 1000);

  // Insert tenant + membership in one batch so we don't end up with an
  // orphan tenant if the membership write fails.
  const insertTenant = c.env.AUTH_DB
    .prepare("INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
    .bind(tenantId, name, now, now);
  const insertMembership = c.env.AUTH_DB
    .prepare(
      "INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    )
    .bind(userId, tenantId, now);

  await c.env.AUTH_DB.batch([insertTenant, insertMembership]);

  return c.json(
    {
      id: tenantId,
      name,
      role: "owner",
      created_at: now,
    },
    201,
  );
});

export default app;
