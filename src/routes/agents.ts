import { Hono } from "hono";
import type { Env } from "../env";
import type { AgentConfig } from "../types";
import { generateAgentId } from "../id";

const app = new Hono<{ Bindings: Env }>();

// POST /v1/agents — create agent
app.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    model: string | { id: string; speed?: "standard" | "fast" };
    system?: string;
    tools?: AgentConfig["tools"];
    harness?: string;
    description?: string;
    mcp_servers?: AgentConfig["mcp_servers"];
    skills?: AgentConfig["skills"];
    callable_agents?: AgentConfig["callable_agents"];
    metadata?: Record<string, unknown>;
  }>();

  if (!body.name || !body.model) {
    return c.json({ error: "name and model are required" }, 400);
  }

  const now = new Date().toISOString();
  const agent: AgentConfig = {
    id: generateAgentId(),
    name: body.name,
    model: body.model,
    system: body.system || "",
    tools: body.tools || [{ type: "agent_toolset_20260401" }],
    harness: body.harness,
    description: body.description,
    mcp_servers: body.mcp_servers,
    skills: body.skills,
    callable_agents: body.callable_agents,
    metadata: body.metadata,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  await c.env.CONFIG_KV.put(`agent:${agent.id}`, JSON.stringify(agent));
  return c.json(agent, 201);
});

// GET /v1/agents — list agents
app.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: "agent:" });
  const agents = (
    await Promise.all(
      list.keys
        .filter((k) => !k.name.includes(":v"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? JSON.parse(data) : null;
        })
    )
  ).filter(Boolean);

  agents.sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return order === "asc" ? cmp : -cmp;
  });

  return c.json({ data: agents.slice(0, limit) });
});

// GET /v1/agents/:id — get agent
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`agent:${id}`);
  if (!data) return c.json({ error: "Agent not found" }, 404);
  return c.json(JSON.parse(data));
});

// PUT /v1/agents/:id — update agent
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`agent:${id}`);
  if (!data) return c.json({ error: "Agent not found" }, 404);

  const agent: AgentConfig = JSON.parse(data);

  const body = await c.req.json<{
    name?: string;
    model?: string | { id: string; speed?: string };
    system?: string;
    tools?: AgentConfig["tools"];
    harness?: string;
    description?: string;
    mcp_servers?: AgentConfig["mcp_servers"];
    skills?: AgentConfig["skills"];
    callable_agents?: AgentConfig["callable_agents"];
    metadata?: Record<string, unknown>;
  }>();

  // Detect if anything actually changed
  let changed = false;
  const fields = ["name", "model", "system", "tools", "harness", "description", "mcp_servers", "skills", "callable_agents", "metadata"] as const;
  for (const key of fields) {
    if (body[key] !== undefined && JSON.stringify(body[key]) !== JSON.stringify(agent[key])) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    return c.json(agent);
  }

  // Save current version to version history before overwriting
  await c.env.CONFIG_KV.put(`agent:${id}:v${agent.version}`, data);

  for (const key of fields) {
    if (body[key] !== undefined) (agent as any)[key] = body[key];
  }
  agent.version += 1;
  agent.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(`agent:${id}`, JSON.stringify(agent));
  return c.json(agent);
});

// GET /v1/agents/:id/versions — list all versions
app.get("/:id/versions", async (c) => {
  const id = c.req.param("id");

  // Verify agent exists
  const agentData = await c.env.CONFIG_KV.get(`agent:${id}`);
  if (!agentData) return c.json({ error: "Agent not found" }, 404);

  const list = await c.env.CONFIG_KV.list({ prefix: `agent:${id}:v` });
  const versions = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? JSON.parse(data) : null;
      })
    )
  ).filter(Boolean);

  // Sort by version number ascending
  versions.sort((a, b) => a.version - b.version);
  return c.json({ data: versions });
});

// GET /v1/agents/:id/versions/:version — get specific version
app.get("/:id/versions/:version", async (c) => {
  const id = c.req.param("id");
  const version = c.req.param("version");

  const data = await c.env.CONFIG_KV.get(`agent:${id}:v${version}`);
  if (!data) return c.json({ error: "Version not found" }, 404);

  return c.json(JSON.parse(data));
});

// POST /v1/agents/:id/archive — archive agent
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`agent:${id}`);
  if (!data) return c.json({ error: "Agent not found" }, 404);

  const agent: AgentConfig = JSON.parse(data);
  agent.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`agent:${id}`, JSON.stringify(agent));
  return c.json(agent);
});

// DELETE /v1/agents/:id — delete agent
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`agent:${id}`);
  if (!data) return c.json({ error: "Agent not found" }, 404);

  await c.env.CONFIG_KV.delete(`agent:${id}`);
  return c.json({ type: "agent_deleted", id });
});

export default app;
