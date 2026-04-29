import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { AgentConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
  AgentVersionNotFoundError,
} from "@open-managed-agents/agents-store";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/**
 * Normalize agent response to match Anthropic API spec:
 * - Add type: "agent"
 * - Normalize model to object form { id, speed }
 * - Default null for nullable fields
 *
 * Accepts AgentConfig (the pure shape) — callers strip the server-internal
 * tenant_id off AgentRow before formatting.
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
    aux_model: agent.aux_model
      ? (typeof agent.aux_model === "string"
          ? { id: agent.aux_model, speed: "standard" as const }
          : { id: agent.aux_model.id, speed: agent.aux_model.speed || "standard" as const })
      : null,
    aux_model_card_id: agent.aux_model_card_id || null,
    metadata: agent.metadata || {},
    archived_at: agent.archived_at || null,
  };
}

/** AgentRow from the store carries server-internal tenant_id — strip it before
 *  shaping the API response. */
function toApiAgent(row: AgentConfig & { tenant_id?: string }) {
  const { tenant_id: _t, ...rest } = row;
  return formatAgent(rest);
}

/**
 * Validate that a model_card_id exists, or that the model string
 * matches at least one configured model card (by model_id).
 * If no model cards exist at all, skip validation (env-key fallback).
 */
async function validateModel(
  services: Services,
  tenantId: string,
  model: string | { id: string; speed?: string },
  modelCardId?: string,
): Promise<{ valid: boolean; error?: string }> {
  const cards = await services.modelCards.list({ tenantId });
  const active = cards.filter((c) => c.archived_at === null);

  // No model cards configured — skip validation (uses env fallback)
  if (active.length === 0) return { valid: true };

  // If explicit model_card_id, verify it exists
  if (modelCardId) {
    const found = active.find((c) => c.id === modelCardId);
    if (!found) return { valid: false, error: `Model card "${modelCardId}" not found` };
    return { valid: true };
  }

  // Otherwise, check if the model_id matches any card
  const modelId = typeof model === "string" ? model : model.id;
  const match = active.find((c) => c.model_id === modelId);
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
    aux_model?: string | { id: string; speed?: "standard" | "fast" };
    aux_model_card_id?: string;
    runtime_binding?: AgentConfig["runtime_binding"];
  }>();

  // `model` is required for cloud agents (it picks which model_card the
  // SessionDO loop talks to) but meaningless for local-runtime agents
  // (the ACP child has its own model selection, see the validateModel
  // skip below). Empty string accepted from the form when the UI hides
  // the Model section for local-runtime agents.
  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.runtime_binding && !body.model) {
    return c.json({ error: "model is required for cloud agents" }, 400);
  }

  // Validate model has a configured model card. Skipped for local-runtime
  // agents: their loop runs in the user's `oma bridge daemon` ACP child,
  // which brings its own LLM credentials and ignores OMA's model_card.
  // Forcing a card here would block users who have no cards configured
  // (i.e. anyone running purely on a local Claude Code / Codex install).
  const tenantId = c.get("tenant_id");
  const isLocalRuntime = !!body.runtime_binding;
  if (!isLocalRuntime) {
    const modelCheck = await validateModel(c.var.services, tenantId, body.model, body.model_card_id);
    if (!modelCheck.valid) {
      return c.json({ error: modelCheck.error }, 400);
    }

    // Validate aux_model when provided. Same skip rule applies — aux_model
    // is meaningless for ACP children that don't expose a sub-model knob.
    if (body.aux_model !== undefined || body.aux_model_card_id !== undefined) {
      const auxModel = body.aux_model ?? body.model;
      const auxCheck = await validateModel(c.var.services, tenantId, auxModel, body.aux_model_card_id);
      if (!auxCheck.valid) {
        return c.json({ error: `aux_model: ${auxCheck.error}` }, 400);
      }
    }
  }

  const row = await c.var.services.agents.create({
    tenantId,
    input: {
      name: body.name,
      model: body.model,
      system: body.system,
      tools: body.tools,
      harness: body.harness,
      description: body.description,
      mcp_servers: body.mcp_servers,
      skills: body.skills,
      callable_agents: body.callable_agents,
      metadata: body.metadata,
      model_card_id: body.model_card_id,
      aux_model: body.aux_model,
      aux_model_card_id: body.aux_model_card_id,
      runtime_binding: body.runtime_binding,
    },
  });
  return c.json(toApiAgent(row), 201);
});

// GET /v1/agents — list agents
app.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const rows = await c.var.services.agents.list({ tenantId: c.get("tenant_id") });
  const agents = rows.map(toApiAgent);
  agents.sort((a, b) => a.created_at.localeCompare(b.created_at) * (order === "asc" ? 1 : -1));
  return c.json({ data: agents.slice(0, limit) });
});

// GET /v1/agents/:id — get agent
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const row = await c.var.services.agents.get({ tenantId: t, agentId: id });
  if (!row) return c.json({ error: "Agent not found" }, 404);
  return c.json(toApiAgent(row));
});

// POST/PUT /v1/agents/:id — update agent (Anthropic uses POST; PUT accepted for compat)
const updateAgent = async (c: any) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const existing = await c.var.services.agents.get({ tenantId: t, agentId: id });
  if (!existing) return c.json({ error: "Agent not found" }, 404);

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
    aux_model?: string | { id: string; speed?: "standard" | "fast" } | null;
    aux_model_card_id?: string | null;
    metadata?: Record<string, unknown>;
    version?: number;
    runtime_binding?: AgentConfig["runtime_binding"] | null;
  };

  // Effective runtime_binding after the patch — explicit null means the
  // caller is detaching the binding (= becoming a cloud agent), so model
  // checks come back into scope. `undefined` means "don't touch", so we
  // fall back to the existing binding.
  const effectiveBinding = body.runtime_binding === null
    ? null
    : (body.runtime_binding ?? existing.runtime_binding);
  const isLocalRuntime = !!effectiveBinding;

  // Validate model if model or model_card_id is being changed. Skipped
  // for local-runtime agents — see POST handler for the rationale.
  if (!isLocalRuntime && (body.model !== undefined || body.model_card_id !== undefined)) {
    const effectiveModel = body.model ?? existing.model;
    const effectiveCardId = body.model_card_id === null ? undefined : (body.model_card_id ?? existing.model_card_id);
    const modelCheck = await validateModel(c.var.services, t, effectiveModel, effectiveCardId);
    if (!modelCheck.valid) {
      return c.json({ error: modelCheck.error }, 400);
    }
  }

  // Validate aux_model if changing. Same skip rule.
  if (!isLocalRuntime && (body.aux_model !== undefined || body.aux_model_card_id !== undefined)) {
    const effectiveAux = body.aux_model === null
      ? undefined
      : (body.aux_model ?? existing.aux_model);
    const effectiveAuxCard = body.aux_model_card_id === null
      ? undefined
      : (body.aux_model_card_id ?? existing.aux_model_card_id);
    if (effectiveAux !== undefined) {
      const auxCheck = await validateModel(c.var.services, t, effectiveAux, effectiveAuxCard);
      if (!auxCheck.valid) {
        return c.json({ error: `aux_model: ${auxCheck.error}` }, 400);
      }
    }
  }

  try {
    const row = await c.var.services.agents.update({
      tenantId: t,
      agentId: id,
      expectedVersion: body.version,
      input: {
        name: body.name,
        model: body.model,
        system: body.system,
        tools: body.tools,
        harness: body.harness,
        description: body.description,
        mcp_servers: body.mcp_servers,
        skills: body.skills,
        callable_agents: body.callable_agents,
        metadata: body.metadata,
        model_card_id: body.model_card_id,
        aux_model: body.aux_model,
        aux_model_card_id: body.aux_model_card_id,
        runtime_binding: body.runtime_binding,
      },
    });
    return c.json(toApiAgent(row));
  } catch (err) {
    if (err instanceof AgentVersionMismatchError) {
      return c.json({ error: "Version mismatch. Agent has been updated since you last read it." }, 409);
    }
    if (err instanceof AgentNotFoundError) {
      return c.json({ error: "Agent not found" }, 404);
    }
    throw err;
  }
};
app.post("/:id", updateAgent);
app.put("/:id", updateAgent);

// GET /v1/agents/:id/versions — list all versions
app.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const exists = await c.var.services.agents.get({ tenantId: t, agentId: id });
  if (!exists) return c.json({ error: "Agent not found" }, 404);

  const versions = await c.var.services.agents.listVersions({ tenantId: t, agentId: id });
  const data = versions
    .map((v) => formatAgent(v.snapshot))
    .sort((a, b) => a.version - b.version);
  return c.json({ data });
});

// GET /v1/agents/:id/versions/:version — get specific version
app.get("/:id/versions/:version", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const versionParam = parseInt(c.req.param("version"), 10);
  if (isNaN(versionParam)) return c.json({ error: "Version not found" }, 404);
  const row = await c.var.services.agents.getVersion({
    tenantId: t,
    agentId: id,
    version: versionParam,
  });
  if (!row) return c.json({ error: "Version not found" }, 404);
  return c.json(formatAgent(row.snapshot));
});

// POST /v1/agents/:id/archive — archive agent
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  try {
    const row = await c.var.services.agents.archive({ tenantId: t, agentId: id });
    return c.json(toApiAgent(row));
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      return c.json({ error: "Agent not found" }, 404);
    }
    throw err;
  }
});

// DELETE /v1/agents/:id — delete agent (extension, not in Anthropic spec)
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const existing = await c.var.services.agents.get({ tenantId: t, agentId: id });
  if (!existing) return c.json({ error: "Agent not found" }, 404);

  // Refuse if any active session in the tenant references this agent.
  const hasActiveSessions = await c.var.services.sessions.hasActiveByAgent({
    tenantId: t,
    agentId: id,
  });
  if (hasActiveSessions) {
    return c.json({
      error: "Cannot delete agent with active sessions. Archive or delete sessions first.",
    }, 409);
  }

  // Refuse if any pending/running eval run still targets this agent.
  const hasActiveEvals = await c.var.services.evals.hasActiveByAgent({
    tenantId: t,
    agentId: id,
  });
  if (hasActiveEvals) {
    return c.json({
      error: "Cannot delete agent with active eval runs. Wait for them to finish first.",
    }, 409);
  }

  await c.var.services.agents.delete({ tenantId: t, agentId: id });
  return c.json({ type: "agent_deleted", id });
});

// Suppress unused-import lint when this branch is rarely exercised
void AgentVersionNotFoundError;

export default app;
