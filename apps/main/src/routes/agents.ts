import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { AgentConfig, ModelCard } from "@open-managed-agents/shared";
import { generateAgentId } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

/**
 * Normalize agent response to match Anthropic API spec:
 * - Add type: "agent"
 * - Normalize model to object form { id, speed }
 * - Default null for nullable fields
 */
function formatAgent(agent: AgentConfig) {
  const model = typeof agent.model === "string"
    ? { id: agent.model, speed: "standard" as const }
    : { id: agent.model.id, speed: agent.model.speed || "standard" as const };

  return {
    type: "agent" as const,
    ...agent,
    model,
    system: agent.system || null,
    description: agent.description || null,
    skills: agent.skills || [],
    mcp_servers: agent.mcp_servers || [],
    callable_agents: agent.callable_agents || [],
    model_card_id: agent.model_card_id || null,
    metadata: agent.metadata || {},
    archived_at: agent.archived_at || null,
  };
}

/**
 * Validate that a model_card_id exists, or that the model string
 * matches at least one configured model card (by model_id).
 * If no model cards exist at all, skip validation (env-key fallback).
 */
async function validateModel(
  kv: KVNamespace,
  tenantId: string,
  model: string | { id: string; speed?: string },
  modelCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  // Load all model cards
  const list = await kv.list({ prefix: kvPrefix(tenantId, "modelcard") });
  const cardKeys = list.keys.filter((k) => !k.name.includes(":key"));

  // No model cards configured — skip validation (uses env fallback)
  if (cardKeys.length === 0) return { valid: true };

  const cards: ModelCard[] = (
    await Promise.all(
      cardKeys.map(async (k) => {
        const data = await kv.get(k.name);
        return data ? (JSON.parse(data) as ModelCard) : null;
      })
    )
  ).filter((c): c is ModelCard => c !== null && !c.archived_at);

  // If explicit model_card_id, verify it exists
  if (modelCardId) {
    const found = cards.find((c) => c.id === modelCardId);
    if (!found) return { valid: false, error: `Model card "${modelCardId}" not found` };
    return { valid: true };
  }

  // Otherwise, check if the model_id matches any card
  const modelId = typeof model === "string" ? model : model.id;
  const match = cards.find((c) => c.model_id === modelId);
  if (!match) {
    return {
      valid: false,
      error: `No model card configured for model "${modelId}". Create a model card first or use a configured model.`,
    };
  }
  return { valid: true };
}

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
    model_card_id?: string;
  }>();

  if (!body.name || !body.model) {
    return c.json({ error: "name and model are required" }, 400);
  }

  // Validate model has a configured model card
  const tenantId = c.get("tenant_id");
  const modelCheck = await validateModel(c.env.CONFIG_KV, tenantId, body.model, body.model_card_id);
  if (!modelCheck.valid) {
    return c.json({ error: modelCheck.error }, 400);
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
    model_card_id: body.model_card_id,
    metadata: body.metadata,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  await c.env.CONFIG_KV.put(kvKey(tenantId, "agent", agent.id), JSON.stringify(agent));
  return c.json(formatAgent(agent), 201);
});

// GET /v1/agents — list agents
app.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: kvPrefix(c.get("tenant_id"), "agent") });
  const agents = (
    await Promise.all(
      list.keys
        .filter((k) => !k.name.includes(":v"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? formatAgent(JSON.parse(data)) : null;
        })
    )
  ).filter((a): a is NonNullable<typeof a> => a !== null);

  agents.sort((a, b) => a.created_at.localeCompare(b.created_at) * (order === "asc" ? 1 : -1));

  return c.json({ data: agents.slice(0, limit) });
});

// GET /v1/agents/:id — get agent
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "agent", id));
  if (!data) return c.json({ error: "Agent not found" }, 404);
  return c.json(formatAgent(JSON.parse(data)));
});

// POST/PUT /v1/agents/:id — update agent (Anthropic uses POST; PUT accepted for compat)
const updateAgent = async (c: any) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "agent", id));
  if (!data) return c.json({ error: "Agent not found" }, 404);

  const agent: AgentConfig = JSON.parse(data);

  const body = await c.req.json() as {
    name?: string;
    model?: string | { id: string; speed?: "standard" | "fast" };
    system?: string | null;
    tools?: AgentConfig["tools"];
    harness?: string;
    description?: string | null;
    mcp_servers?: AgentConfig["mcp_servers"] | null;
    skills?: AgentConfig["skills"] | null;
    callable_agents?: AgentConfig["callable_agents"] | null;
    model_card_id?: string | null;
    metadata?: Record<string, unknown>;
    version?: number;
  };

  // Validate model if model or model_card_id is being changed
  if (body.model !== undefined || body.model_card_id !== undefined) {
    const effectiveModel = body.model ?? agent.model;
    const effectiveCardId = body.model_card_id === null ? undefined : (body.model_card_id ?? agent.model_card_id);
    const modelCheck = await validateModel(c.env.CONFIG_KV, t, effectiveModel, effectiveCardId);
    if (!modelCheck.valid) {
      return c.json({ error: modelCheck.error }, 400);
    }
  }

  // Optimistic concurrency: if version provided, check it matches
  if (body.version !== undefined && body.version !== agent.version) {
    return c.json({ error: "Version mismatch. Agent has been updated since you last read it." }, 409);
  }

  // Detect if anything actually changed
  let changed = false;
  const fields = ["name", "model", "system", "tools", "harness", "description", "mcp_servers", "skills", "callable_agents", "model_card_id", "metadata"] as const;
  for (const key of fields) {
    if (body[key] !== undefined && JSON.stringify(body[key]) !== JSON.stringify(agent[key])) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    return c.json(formatAgent(agent));
  }

  // Save current version to version history before overwriting
  await c.env.CONFIG_KV.put(kvKey(t, "agent", `${id}:v${agent.version}`), data);

  for (const key of fields) {
    if (body[key] !== undefined) {
      if (body[key] === null) {
        (agent as any)[key] = key === "system" || key === "description" ? "" : undefined;
      } else if (key === "metadata" && typeof body[key] === "object") {
        // Merge metadata: set value to "" to delete a key
        const existing = agent.metadata || {};
        for (const [mk, mv] of Object.entries(body[key] as Record<string, unknown>)) {
          if (mv === "" || mv === null) {
            delete existing[mk];
          } else {
            existing[mk] = mv;
          }
        }
        agent.metadata = existing;
      } else {
        (agent as any)[key] = body[key];
      }
    }
  }
  agent.version += 1;
  agent.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(kvKey(t, "agent", id), JSON.stringify(agent));
  return c.json(formatAgent(agent));
};
app.post("/:id", updateAgent);
app.put("/:id", updateAgent);

// GET /v1/agents/:id/versions — list all versions
app.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const agentData = await c.env.CONFIG_KV.get(kvKey(t, "agent", id));
  if (!agentData) return c.json({ error: "Agent not found" }, 404);

  const list = await c.env.CONFIG_KV.list({ prefix: kvKey(t, "agent", `${id}:v`) });
  const versions = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? formatAgent(JSON.parse(data)) : null;
      })
    )
  ).filter((v): v is NonNullable<typeof v> => v !== null);

  versions.sort((a, b) => a.version - b.version);
  return c.json({ data: versions });
});

// GET /v1/agents/:id/versions/:version — get specific version
app.get("/:id/versions/:version", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const version = c.req.param("version");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "agent", `${id}:v${version}`));
  if (!data) return c.json({ error: "Version not found" }, 404);
  return c.json(formatAgent(JSON.parse(data)));
});

// POST /v1/agents/:id/archive — archive agent
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "agent", id));
  if (!data) return c.json({ error: "Agent not found" }, 404);

  const agent: AgentConfig = JSON.parse(data);
  agent.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(kvKey(t, "agent", id), JSON.stringify(agent));
  return c.json(formatAgent(agent));
});

// DELETE /v1/agents/:id — delete agent (extension, not in Anthropic spec)
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "agent", id));
  if (!data) return c.json({ error: "Agent not found" }, 404);

  // Check if any active sessions reference this agent
  const sessionList = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "session") });
  for (const k of sessionList.keys) {
    const sessData = await c.env.CONFIG_KV.get(k.name);
    if (!sessData) continue;
    const sess = JSON.parse(sessData);
    if (sess.agent_id === id && !sess.archived_at) {
      return c.json({ error: "Cannot delete agent with active sessions. Archive or delete sessions first." }, 409);
    }
  }

  await c.env.CONFIG_KV.delete(kvKey(t, "agent", id));
  return c.json({ type: "agent_deleted", id });
});

export default app;
