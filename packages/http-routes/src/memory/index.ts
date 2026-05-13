// Memory store routes — REST CRUD on memory_stores + memories. Wraps
// services.memory directly; identical behaviour on CF (R2 + D1) and
// Node (LocalFs/S3 + SqlClient).

import { Hono } from "hono";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

export interface MemoryRoutesDeps {
  services: RouteServicesArg;
}

export function buildMemoryRoutes(deps: MemoryRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{ name: string; description?: string }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const row = await services.memory.createStore({
      tenantId: c.var.tenant_id,
      name: body.name,
      description: body.description,
    });
    return c.json(row, 201);
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const rows = await services.memory.listStores({
      tenantId: c.var.tenant_id,
      includeArchived: c.req.query("include_archived") === "true",
    });
    return c.json({ data: rows });
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.memory.getStore({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Memory store not found" }, 404);
    return c.json(row);
  });

  app.post("/:id/memories", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      path: string;
      content: string;
      precondition?:
        | { type: "content_sha256"; content_sha256: string }
        | { type: "not_exists" };
    }>();
    if (!body.path || body.content === undefined) {
      return c.json({ error: "path and content are required" }, 400);
    }
    try {
      const row = await services.memory.writeByPath({
        tenantId: c.var.tenant_id,
        storeId: c.req.param("id"),
        path: body.path,
        content: body.content,
        precondition: body.precondition,
        actor: { type: "user", id: c.var.user_id ?? c.var.tenant_id },
      });
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/:id/memories", async (c) => {
    const services = resolveServices(deps.services, c);
    const rows = await services.memory.listMemories({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
      pathPrefix: c.req.query("path_prefix") ?? undefined,
    });
    return c.json({ data: rows });
  });

  app.get("/:id/memories/:mid", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.memory.readById({
      tenantId: c.var.tenant_id,
      storeId: c.req.param("id"),
      memoryId: c.req.param("mid"),
    });
    if (!row) return c.json({ error: "Memory not found" }, 404);
    return c.json(row);
  });

  return app;
}
