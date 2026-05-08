import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { AgentConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
  AgentVersionNotFoundError,
} from "@open-managed-agents/agents-store";
import { jsonPage, parsePageQuery } from "../lib/list-page";
import { validateAgentLimits } from "../lib/limits";

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
  const model = !agent.model || typeof agent.model === "string"
    ? { id: agent.model || "", speed: "standard" as const }
    : { id: agent.model.id, speed: agent.model.speed || "standard" as const };

  // Group OMA-only fields under `_oma:` so the AMA-shape envelope stays
  // strictly Anthropic-compatible. AMA SDK consumers ignore _oma; OMA
  // consumers (Console, oma CLI) read it for the platform extensions.
  const oma: Record<string, unknown> = {};
  if (agent.aux_model) {
    oma.aux_model = typeof agent.aux_model === "string"
      ? { id: agent.aux_model, speed: "standard" as const }
      : { id: agent.aux_model.id, speed: agent.aux_model.speed || "standard" as const };
  }
  if (agent.harness) oma.harness = agent.harness;
  if (agent.runtime_binding) oma.runtime_binding = agent.runtime_binding;
  if (agent.appendable_prompts && agent.appendable_prompts.length > 0) {
    oma.appendable_prompts = agent.appendable_prompts;
  }

  // AMA shape: `multiagent: {type:"coordinator", agents:[...]} | null`.
  // Resolved roster — entries always carry a concrete `version`. We default
  // to 1 when the stored entry lacks one (older rows pre-versioning).
  const callable = agent.callable_agents ?? [];
  const multiagent = callable.length > 0
    ? {
        type: "coordinator" as const,
        agents: callable.map((c) => ({
          type: "agent" as const,
          id: c.id,
          version: c.version ?? 1,
        })),
      }
    : null;

  // Strip OMA-only + internal-shape keys from the spread so they only
  // surface under their wire-canonical names (_oma / multiagent).
  const {
    aux_model: _aux,
    harness: _harness,
    runtime_binding: _rb,
    appendable_prompts: _ap,
    callable_agents: _ca,
    ...rest
  } = agent;

  return {
    type: "agent" as const,
    ...rest,
    model,
    system: agent.system || null,
    description: agent.description || null,
    skills: agent.skills || [],
    mcp_servers: agent.mcp_servers || [],
    multiagent,
    metadata: agent.metadata || {},
    archived_at: agent.archived_at || null,
    ...(Object.keys(oma).length > 0 ? { _oma: oma } : {}),
  };
}

/** AgentRow from the store carries server-internal tenant_id — strip it before
 *  shaping the API response. */
function toApiAgent(row: AgentConfig & { tenant_id?: string }) {
  const { tenant_id: _t, ...rest } = row;
  return formatAgent(rest);
}

/**
 * Validate the agent's model reference. `agent.model` must equal some
 * card's `model_id` (the tenant-unique handle); the DB enforces
 * UNIQUE(tenant_id, model_id) so the lookup returns at most one row.
 *
 * Skips validation entirely when no cards exist (env-var fallback path).
 */
async function validateModel(
  services: Services,
  tenantId: string,
  model: string | { id: string; speed?: string },
): Promise<{ valid: boolean; error?: string }> {
  const cards = await services.modelCards.list({ tenantId });
  const active = cards.filter((c) => c.archived_at === null);

  // No model cards configured — skip validation (uses env fallback)
  if (active.length === 0) return { valid: true };

  const modelId = typeof model === "string" ? model : model.id;
  const match = active.find((c) => c.model_id === modelId);
  if (!match) {
    return {
      valid: false,
      error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
    };
  }
  return { valid: true };
}

/** AMA-shape multiagent input → internal `callable_agents` array.
 *
 *  Roster entries accept three forms (per AMA `MultiagentRosterEntryParams`):
 *    - bare string: agent id, version defaults to 1
 *    - `{type:"agent", id, version?}`: explicit ref
 *    - `{type:"self"}`: 501 for now — needs the parent agent's id which we
 *      don't have at create time without an extra round-trip
 *
 *  Returns `{ list, error }`. `error` non-null means the request should be
 *  rejected with 422; `list` is the normalized internal shape. */
function multiagentToCallableAgents(
  multiagent: unknown,
): { list: AgentConfig["callable_agents"]; error?: string } {
  if (multiagent === null || multiagent === undefined) return { list: undefined };
  if (typeof multiagent !== "object") return { list: [], error: "multiagent must be an object" };
  const m = multiagent as { type?: string; agents?: unknown };
  if (m.type !== "coordinator") {
    return { list: [], error: `multiagent.type must be "coordinator"` };
  }
  if (!Array.isArray(m.agents)) {
    return { list: [], error: "multiagent.agents must be an array" };
  }
  const out: NonNullable<AgentConfig["callable_agents"]> = [];
  for (const entry of m.agents) {
    if (typeof entry === "string") {
      out.push({ type: "agent", id: entry, version: 1 });
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as { type?: string; id?: string; version?: number };
      if (e.type === "self") {
        return { list: [], error: `multiagent.agents: {"type":"self"} is not yet supported` };
      }
      if (e.type === "agent" && typeof e.id === "string") {
        out.push({ type: "agent", id: e.id, version: typeof e.version === "number" ? e.version : 1 });
        continue;
      }
    }
    return { list: [], error: `multiagent.agents: invalid roster entry ${JSON.stringify(entry)}` };
  }
  return { list: out };
}

// POST /v1/agents — create agent
app.post("/", async (c) => {
  const raw = await c.req.json<{
    name: string;
    model: string | { id: string; speed?: "standard" | "fast" };
    system?: string;
    tools?: AgentConfig["tools"];
    description?: string;
    mcp_servers?: AgentConfig["mcp_servers"];
    skills?: AgentConfig["skills"];
    multiagent?: { type: "coordinator"; agents: unknown[] } | null;
    metadata?: Record<string, unknown>;
    _oma?: {
      aux_model?: string | { id: string; speed?: "standard" | "fast" };
      harness?: string;
      runtime_binding?: AgentConfig["runtime_binding"];
      appendable_prompts?: string[];
    };
  }>();

  const ma = multiagentToCallableAgents(raw.multiagent);
  if (ma.error) return c.json({ error: ma.error }, 422);

  // Lift `_oma:` extensions and normalized multiagent onto a flat `body`
  // for the rest of this handler — keeps validate / store paths uniform.
  const body = {
    ...raw,
    callable_agents: ma.list,
    aux_model: raw._oma?.aux_model,
    harness: raw._oma?.harness,
    runtime_binding: raw._oma?.runtime_binding,
    appendable_prompts: raw._oma?.appendable_prompts,
  };

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

  // Field-size caps (Anthropic-aligned). See lib/limits.ts.
  const limitCheck = validateAgentLimits(body);
  if (!limitCheck.ok) {
    return c.json({ error: limitCheck.error }, 400);
  }

  // Validate model has a configured model card. Skipped for local-runtime
  // agents: their loop runs in the user's `oma bridge daemon` ACP child,
  // which brings its own LLM credentials and ignores OMA's model_card.
  // Forcing a card here would block users who have no cards configured
  // (i.e. anyone running purely on a local Claude Code / Codex install).
  const tenantId = c.get("tenant_id");
  const isLocalRuntime = !!body.runtime_binding;
  if (!isLocalRuntime) {
    const modelCheck = await validateModel(c.var.services, tenantId, body.model);
    if (!modelCheck.valid) {
      return c.json({ error: modelCheck.error }, 400);
    }

    // Validate aux_model when provided. Same skip rule applies — aux_model
    // is meaningless for ACP children that don't expose a sub-model knob.
    if (body.aux_model !== undefined) {
      const auxModel = body.aux_model ?? body.model;
      const auxCheck = await validateModel(c.var.services, tenantId, auxModel);
      if (!auxCheck.valid) {
        return c.json({ error: `aux_model: ${auxCheck.error}` }, 400);
      }
    }
  }

  const row = await c.var.services.agents.create({
    tenantId,
    input: {
      name: body.name,
      // Normalize model: null/undefined → "" so we never write a literal
      // null into the JSON config (formatAgent assumes string|object and
      // would crash on null at read time). Local-runtime agents legitimately
      // pass no model — "" is the canonical empty value other rows use.
      model: body.model ?? "",
      system: body.system,
      tools: body.tools,
      harness: body.harness,
      description: body.description,
      mcp_servers: body.mcp_servers,
      skills: body.skills,
      callable_agents: body.callable_agents,
      metadata: body.metadata,
      aux_model: body.aux_model,
      appendable_prompts: body.appendable_prompts,
      runtime_binding: body.runtime_binding,
    },
  });
  return c.json(toApiAgent(row), 201);
});

// GET /v1/agents — list agents (cursor-paginated)
//
// `?limit=N&cursor=<opaque>&include_archived=true` — Anthropic-style.
// Without a cursor, returns the newest `limit` rows; chase `next_cursor`
// for subsequent pages. Older clients that ignore `next_cursor` keep
// working — they just see the first page.
app.get("/", async (c) => {
  const params = parsePageQuery(c);
  const page = await c.var.services.agents.listPage({
    tenantId: c.get("tenant_id"),
    ...params,
  });
  return jsonPage(c, page, toApiAgent);
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

  const raw = await c.req.json() as {
    name?: string;
    model?: string | { id: string; speed?: "standard" | "fast" };
    system?: string | null;
    tools?: AgentConfig["tools"];
    description?: string | null;
    mcp_servers?: AgentConfig["mcp_servers"] | null;
    skills?: AgentConfig["skills"] | null;
    multiagent?: { type: "coordinator"; agents: unknown[] } | null;
    metadata?: Record<string, unknown>;
    version?: number;
    _oma?: {
      aux_model?: string | { id: string; speed?: "standard" | "fast" } | null;
      harness?: string;
      runtime_binding?: AgentConfig["runtime_binding"] | null;
      appendable_prompts?: string[] | null;
    };
  };

  // null on update = clear (drops the roster). undefined = leave alone.
  let callableAgents: AgentConfig["callable_agents"] | null | undefined;
  if (raw.multiagent === null) {
    callableAgents = null;
  } else if (raw.multiagent !== undefined) {
    const ma = multiagentToCallableAgents(raw.multiagent);
    if (ma.error) return c.json({ error: ma.error }, 422);
    callableAgents = ma.list;
  }

  // Lift `_oma:` extensions and normalized multiagent onto a flat `body`
  // for the rest of this handler — keeps validate / store paths uniform
  // with the POST handler.
  const body = {
    ...raw,
    callable_agents: callableAgents,
    aux_model: raw._oma?.aux_model,
    harness: raw._oma?.harness,
    runtime_binding: raw._oma?.runtime_binding,
    appendable_prompts: raw._oma?.appendable_prompts,
  };

  // Field-size caps (Anthropic-aligned). See lib/limits.ts. Only the
  // fields supplied in this PATCH are checked — `undefined` means
  // "preserve existing", which already passed limits at create time.
  const limitCheck = validateAgentLimits(body);
  if (!limitCheck.ok) {
    return c.json({ error: limitCheck.error }, 400);
  }

  // Effective runtime_binding after the patch — explicit null means the
  // caller is detaching the binding (= becoming a cloud agent), so model
  // checks come back into scope. `undefined` means "don't touch", so we
  // fall back to the existing binding.
  const effectiveBinding = body.runtime_binding === null
    ? null
    : (body.runtime_binding ?? existing.runtime_binding);
  const isLocalRuntime = !!effectiveBinding;

  // Validate model if it is being changed. Skipped for local-runtime
  // agents — see POST handler for the rationale.
  if (!isLocalRuntime && body.model !== undefined) {
    const effectiveModel = body.model ?? existing.model;
    const modelCheck = await validateModel(c.var.services, t, effectiveModel);
    if (!modelCheck.valid) {
      return c.json({ error: modelCheck.error }, 400);
    }
  }

  // Validate aux_model if changing. Same skip rule.
  if (!isLocalRuntime && body.aux_model !== undefined) {
    const effectiveAux = body.aux_model === null
      ? undefined
      : (body.aux_model ?? existing.aux_model);
    if (effectiveAux !== undefined) {
      const auxCheck = await validateModel(c.var.services, t, effectiveAux);
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
        aux_model: body.aux_model,
        appendable_prompts: body.appendable_prompts,
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
