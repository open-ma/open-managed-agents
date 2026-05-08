// Environments routes — post-GitHub-build replacement.
//
// The legacy `dockerfile` build path (GitHub Actions → per-env worker →
// /build-complete callback) was removed once setup-on-warmup landed
// (apps/agent/src/runtime/setup-on-warmup.ts). Now env create writes a
// D1 row and returns immediately — packages are installed at the FIRST
// session warmup by the SessionDO, not at env-create time.
//
// Removed:
//   - triggerBuild() + GitHub workflow_dispatch
//   - /build-complete callback
//   - image_strategy / pickStrategy
//   - per-env sandbox_worker_name + service-binding plumbing
//
// What stayed:
//   - Standard CRUD (GET / POST / PUT / archive)
//   - Networking + packages config in EnvironmentConfig
//   - Tenant scoping

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  toEnvironmentConfig,
  EnvironmentNotFoundError,
} from "@open-managed-agents/environments-store";
import { jsonPage, parsePageQuery } from "../lib/list-page";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    description?: string;
    config: EnvironmentConfig["config"];
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const row = await c.var.services.environments.create({
    tenantId: t,
    name: body.name,
    description: body.description,
    config: body.config || { type: "cloud" },
    // Setup-on-warmup means env is immediately usable — no async build.
    status: "ready",
    sandboxWorkerName: "sandbox-default",
    imageStrategy: null,
  });

  return c.json(toEnvironmentConfig(row), 201);
});

// GET /v1/environments — list environments (cursor-paginated)
app.get("/", async (c) => {
  const page = await c.var.services.environments.listPage({
    tenantId: c.get("tenant_id"),
    ...parsePageQuery(c),
  });
  return jsonPage(c, page, toEnvironmentConfig);
});

// GET /v1/environments/:id — get environment
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const row = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!row) return c.json({ error: "Environment not found" }, 404);
  return c.json(toEnvironmentConfig(row));
});

// PUT /v1/environments/:id — update environment
app.put("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    description?: string;
    config?: EnvironmentConfig["config"];
    metadata?: Record<string, unknown>;
  };

  const patch: Parameters<typeof c.var.services.environments.update>[0] = {
    tenantId: t,
    environmentId: id,
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.config !== undefined) patch.config = body.config;
  if (body.metadata !== undefined) patch.metadata = body.metadata;

  // No re-build trigger — packages take effect at the next session
  // warmup via setup-on-warmup's hash-mismatch detection (the marker
  // hash bakes in the new packages list, so ensureSetupApplied falls
  // through to the fresh path automatically).
  const row = await c.var.services.environments.update(patch);
  return c.json(toEnvironmentConfig(row));
});

// POST /v1/environments/:id/archive
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    const row = await c.var.services.environments.archive({
      tenantId: t,
      environmentId: id,
    });
    return c.json(toEnvironmentConfig(row));
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) {
      return c.json({ error: "Environment not found" }, 404);
    }
    throw err;
  }
});

export default app;
