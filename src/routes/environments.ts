import { Hono } from "hono";
import type { Env } from "../env";
import type { EnvironmentConfig } from "../types";
import { generateEnvId } from "../id";

const app = new Hono<{ Bindings: Env }>();

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    config: EnvironmentConfig["config"];
  }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const env: EnvironmentConfig = {
    id: generateEnvId(),
    name: body.name,
    config: body.config || { type: "cloud" },
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));
  return c.json(env, 201);
});

// GET /v1/environments — list environments
app.get("/", async (c) => {
  const list = await c.env.CONFIG_KV.list({ prefix: "env:" });
  const envs = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.CONFIG_KV.get(k.name);
      return data ? JSON.parse(data) : null;
    })
  );
  return c.json({ data: envs.filter(Boolean) });
});

// GET /v1/environments/:id — get environment
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);
  return c.json(JSON.parse(data));
});

// PUT /v1/environments/:id — update environment
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  const body = await c.req.json<{
    name?: string;
    config?: EnvironmentConfig["config"];
  }>();

  if (body.name !== undefined) env.name = body.name;
  if (body.config !== undefined) env.config = body.config;

  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  return c.json(env);
});

// POST /v1/environments/:id/archive — archive environment
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  env.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  return c.json(env);
});

// DELETE /v1/environments/:id — delete environment
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  // Check if any non-archived session references this environment
  const sessionList = await c.env.CONFIG_KV.list({ prefix: "session:" });
  for (const k of sessionList.keys) {
    const sessionData = await c.env.CONFIG_KV.get(k.name);
    if (sessionData) {
      const session = JSON.parse(sessionData) as { environment_id: string; archived_at?: string };
      if (session.environment_id === id && !session.archived_at) {
        return c.json({ error: "Cannot delete environment referenced by active sessions" }, 409);
      }
    }
  }

  await c.env.CONFIG_KV.delete(`env:${id}`);
  return c.json({ type: "environment_deleted", id });
});

export default app;
