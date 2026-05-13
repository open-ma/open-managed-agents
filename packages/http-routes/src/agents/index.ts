// Agents — full CRUD with AMA-shape envelope.
//
// Sourced from apps/main/src/routes/agents.ts pre-extract: same AMA shape,
// same `_oma:` envelope, same multiagent → callable_agents transform,
// same field acceptance (no silent body field drops).
//
// Differences vs CF:
//   - validateModel + validateAgentLimits have to be plumbed in by the
//     runtime (services.modelCards isn't on the runtime-agnostic
//     RouteServices because main-node doesn't ship a model_cards-store
//     yet); we accept any model id and skip the cap check.
//   - The DELETE-on-active-sessions check uses sql directly since
//     services.sessions.hasActiveByAgent isn't on the abstract service
//     in the Node port either.

import { Hono } from "hono";
import type {
  AgentConfig,
} from "@open-managed-agents/shared";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
} from "@open-managed-agents/agents-store";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function formatAgent(agent: AgentConfig) {
  const model =
    !agent.model || typeof agent.model === "string"
      ? { id: agent.model || "", speed: "standard" as const }
      : { id: agent.model.id, speed: agent.model.speed || ("standard" as const) };

  // OMA-only fields nest under `_oma:` so AMA SDK consumers ignore them
  // while OMA tooling can read the platform extensions.
  const oma: Record<string, unknown> = {};
  if (agent.aux_model) {
    oma.aux_model =
      typeof agent.aux_model === "string"
        ? { id: agent.aux_model, speed: "standard" as const }
        : { id: agent.aux_model.id, speed: agent.aux_model.speed || ("standard" as const) };
  }
  if (agent.harness) oma.harness = agent.harness;
  if (agent.runtime_binding) oma.runtime_binding = agent.runtime_binding;
  if (agent.appendable_prompts && agent.appendable_prompts.length > 0) {
    oma.appendable_prompts = agent.appendable_prompts;
  }

  const callable = agent.callable_agents ?? [];
  const multiagent =
    callable.length > 0
      ? {
          type: "coordinator" as const,
          agents: callable.map((c) => ({
            type: "agent" as const,
            id: c.id,
            version: c.version ?? 1,
          })),
        }
      : null;

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

function toApiAgent(row: AgentConfig & { tenant_id?: string }) {
  const { tenant_id: _t, ...rest } = row;
  return formatAgent(rest);
}

function multiagentToCallableAgents(
  multiagent: unknown,
): { list: AgentConfig["callable_agents"]; error?: string } {
  if (multiagent === null || multiagent === undefined) return { list: undefined };
  if (typeof multiagent !== "object")
    return { list: [], error: "multiagent must be an object" };
  const m = multiagent as { type?: string; agents?: unknown };
  if (m.type !== "coordinator")
    return { list: [], error: `multiagent.type must be "coordinator"` };
  if (!Array.isArray(m.agents))
    return { list: [], error: "multiagent.agents must be an array" };
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
        out.push({
          type: "agent",
          id: e.id,
          version: typeof e.version === "number" ? e.version : 1,
        });
        continue;
      }
    }
    return { list: [], error: `multiagent.agents: invalid roster entry ${JSON.stringify(entry)}` };
  }
  return { list: out };
}

export interface AgentRoutesDeps {
  services: RouteServicesArg;
  /** Optional model card validation. CF passes a function backed by
   *  services.modelCards; Node passes nothing → validation skipped. */
  validateModel?: (
    tenantId: string,
    model: string | { id: string; speed?: string },
  ) => Promise<{ valid: boolean; error?: string }>;
  /** Optional field-size cap check. CF passes apps/main/src/lib/limits;
   *  Node currently passes nothing. */
  validateAgentLimits?: (body: unknown) => { ok: boolean; error?: string };
  /** Active-sessions guard for DELETE — true means "refuse with 409". */
  hasActiveSessionsByAgent?: (
    tenantId: string,
    agentId: string,
  ) => Promise<boolean>;
  /** Active-evals guard for DELETE — CF blocks while runs target this
   *  agent. Node returns false (no eval runner yet). */
  hasActiveEvalsByAgent?: (
    tenantId: string,
    agentId: string,
  ) => Promise<boolean>;
}

export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/agents — create
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
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

    const body = {
      ...raw,
      callable_agents: ma.list,
      aux_model: raw._oma?.aux_model,
      harness: raw._oma?.harness,
      runtime_binding: raw._oma?.runtime_binding,
      appendable_prompts: raw._oma?.appendable_prompts,
    };

    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.runtime_binding && !body.model) {
      return c.json({ error: "model is required for cloud agents" }, 400);
    }

    if (deps.validateAgentLimits) {
      const limitCheck = deps.validateAgentLimits(body);
      if (!limitCheck.ok) return c.json({ error: limitCheck.error }, 400);
    }

    const tenantId = c.var.tenant_id;
    const isLocalRuntime = !!body.runtime_binding;
    if (!isLocalRuntime && deps.validateModel) {
      const r = await deps.validateModel(tenantId, body.model);
      if (!r.valid) return c.json({ error: r.error }, 400);
      if (body.aux_model !== undefined) {
        const aux = body.aux_model ?? body.model;
        const ar = await deps.validateModel(tenantId, aux);
        if (!ar.valid) return c.json({ error: `aux_model: ${ar.error}` }, 400);
      }
    }

    const row = await services.agents.create({
      tenantId,
      input: {
        name: body.name,
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
        enable_general_subagent: (body as { enable_general_subagent?: boolean })
          .enable_general_subagent,
      },
    });
    return c.json(toApiAgent(row), 201);
  });

  // GET /v1/agents — cursor-paginated list
  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") ?? undefined;
    const includeArchived = c.req.query("include_archived") === "true";
    const q = c.req.query("q") ?? undefined;

    const page = await services.agents.listPage({
      tenantId: c.var.tenant_id,
      limit,
      ...(cursor ? { cursor } : {}),
      includeArchived,
      ...(q ? { q } : {}),
    });
    return c.json({
      data: page.items.map(toApiAgent),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  // GET /v1/agents/:id — get
  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const row = await services.agents.get({
      tenantId: c.var.tenant_id,
      agentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Agent not found" }, 404);
    return c.json(toApiAgent(row));
  });

  // POST/PUT /v1/agents/:id — update
  const updateAgent = async (
    c: import("hono").Context<Vars, "/:id">,
  ): Promise<Response> => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const existing = await services.agents.get({ tenantId, agentId: id });
    if (!existing) return c.json({ error: "Agent not found" }, 404);

    const raw = (await c.req.json()) as {
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

    let callableAgents: AgentConfig["callable_agents"] | null | undefined;
    if (raw.multiagent === null) {
      callableAgents = null;
    } else if (raw.multiagent !== undefined) {
      const ma = multiagentToCallableAgents(raw.multiagent);
      if (ma.error) return c.json({ error: ma.error }, 422);
      callableAgents = ma.list;
    }

    const body = {
      ...raw,
      callable_agents: callableAgents,
      aux_model: raw._oma?.aux_model,
      harness: raw._oma?.harness,
      runtime_binding: raw._oma?.runtime_binding,
      appendable_prompts: raw._oma?.appendable_prompts,
    };

    if (deps.validateAgentLimits) {
      const limitCheck = deps.validateAgentLimits(body);
      if (!limitCheck.ok) return c.json({ error: limitCheck.error }, 400);
    }

    const effectiveBinding =
      body.runtime_binding === null
        ? null
        : (body.runtime_binding ?? existing.runtime_binding);
    const isLocalRuntime = !!effectiveBinding;

    if (!isLocalRuntime && deps.validateModel && body.model !== undefined) {
      const eff = body.model ?? existing.model;
      const r = await deps.validateModel(tenantId, eff);
      if (!r.valid) return c.json({ error: r.error }, 400);
    }
    if (!isLocalRuntime && deps.validateModel && body.aux_model !== undefined) {
      const aux =
        body.aux_model === null ? undefined : (body.aux_model ?? existing.aux_model);
      if (aux !== undefined) {
        const ar = await deps.validateModel(tenantId, aux);
        if (!ar.valid) return c.json({ error: `aux_model: ${ar.error}` }, 400);
      }
    }

    try {
      const row = await services.agents.update({
        tenantId,
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
          enable_general_subagent: (body as { enable_general_subagent?: boolean })
            .enable_general_subagent,
        },
      });
      return c.json(toApiAgent(row));
    } catch (err) {
      if (err instanceof AgentVersionMismatchError) {
        return c.json(
          { error: "Version mismatch. Agent has been updated since you last read it." },
          409,
        );
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
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const exists = await services.agents.get({ tenantId, agentId: id });
    if (!exists) return c.json({ error: "Agent not found" }, 404);
    const versions = await services.agents.listVersions({ tenantId, agentId: id });
    const data = versions
      .map((v) => formatAgent(v.snapshot))
      .sort((a, b) => a.version - b.version);
    return c.json({ data });
  });

  // GET /v1/agents/:id/versions/:version
  app.get("/:id/versions/:version", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const v = parseInt(c.req.param("version"), 10);
    if (Number.isNaN(v)) return c.json({ error: "Version not found" }, 404);
    const row = await services.agents.getVersion({
      tenantId: c.var.tenant_id,
      agentId: id,
      version: v,
    });
    if (!row) return c.json({ error: "Version not found" }, 404);
    return c.json(formatAgent(row.snapshot));
  });

  // POST /v1/agents/:id/archive
  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const row = await services.agents.archive({
        tenantId: c.var.tenant_id,
        agentId: c.req.param("id"),
      });
      return c.json(toApiAgent(row));
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return c.json({ error: "Agent not found" }, 404);
      }
      throw err;
    }
  });

  // DELETE /v1/agents/:id
  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const id = c.req.param("id");
    const tenantId = c.var.tenant_id;
    const existing = await services.agents.get({ tenantId, agentId: id });
    if (!existing) return c.json({ error: "Agent not found" }, 404);

    if (deps.hasActiveSessionsByAgent) {
      const has = await deps.hasActiveSessionsByAgent(tenantId, id);
      if (has) {
        return c.json(
          {
            error:
              "Cannot delete agent with active sessions. Archive or delete sessions first.",
          },
          409,
        );
      }
    }

    if (deps.hasActiveEvalsByAgent) {
      const has = await deps.hasActiveEvalsByAgent(tenantId, id);
      if (has) {
        return c.json(
          {
            error:
              "Cannot delete agent with active eval runs. Wait for them to finish first.",
          },
          409,
        );
      }
    }

    await services.agents.delete({ tenantId, agentId: id });
    return c.json({ type: "agent_deleted", id });
  });

  return app;
}
