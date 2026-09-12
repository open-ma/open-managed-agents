import type {
  AgentCreateBody,
  AgentListQuery,
  AgentUpdateBody,
  AgentVersionListQuery,
} from "../contracts/agents";
import type {
  AgentModelInput,
  AgentView,
  CreateAgentCommand,
  ListAgentsQuery,
  ListAgentVersionsQuery,
  UpdateAgentCommand,
} from "../ports";
import {
  fromAgentMcpServerInput,
  fromAgentMultiagentInput,
  fromAgentSkillInput,
  fromAgentToolInput,
  toAgentMcpServerInput,
  toAgentMultiagentInput,
  toAgentSkillInput,
  toAgentToolInput,
} from "./agent-definition";
import { fromOpenMaAgentExtension } from "./openma-agent-extension";

function toOpenMaInput(extension: NonNullable<AgentCreateBody["_oma"]>) {
  const acp = extension.acp;
  const acpAgent = acp?.agent;
  const acpAgentWithoutEnv = acpAgent === undefined
    ? undefined
    : {
        ...(acpAgent.id !== undefined && { id: acpAgent.id }),
        command: acpAgent.command,
        ...(acpAgent.args !== undefined && { args: acpAgent.args }),
        ...(acpAgent.cwd !== undefined && { cwd: acpAgent.cwd }),
      };
  return {
    ...(extension.aux_model !== undefined && {
      auxiliaryModel:
        extension.aux_model === null
          ? null
          : toAgentModelInput(extension.aux_model),
    }),
    ...(extension.appendable_prompts !== undefined && {
      appendablePrompts: extension.appendable_prompts,
    }),
    ...(extension.harness !== undefined && { harness: extension.harness }),
    ...(acp !== undefined && {
      acp:
        acp === null
          ? null
          : {
              agent: {
                ...acpAgentWithoutEnv!,
                ...(acp.agent.env !== undefined && {
                  env: Object.fromEntries(
                    Object.entries(acp.agent.env).filter(
                      (entry): entry is [string, string] => entry[1] !== null,
                    ),
                  ),
                }),
              },
              ...(acp.restart !== undefined && {
                restart: {
                  mode: acp.restart.mode,
                  ...(acp.restart.max_restarts !== undefined && {
                    maxRestarts: acp.restart.max_restarts,
                  }),
                  ...(acp.restart.window_ms !== undefined && {
                    windowMs: acp.restart.window_ms,
                  }),
                },
              }),
              ...(acp.idle_timeout_ms !== undefined && {
                idleTimeoutMs: acp.idle_timeout_ms,
              }),
              ...(acp.per_turn_timeout_ms !== undefined && {
                perTurnTimeoutMs: acp.per_turn_timeout_ms,
              }),
            },
    }),
    ...(extension.runtime_binding !== undefined && {
      runtimeBinding:
        extension.runtime_binding === null
          ? null
          : {
              runtimeId: extension.runtime_binding.runtime_id,
              acpAgentId: extension.runtime_binding.acp_agent_id,
              ...(extension.runtime_binding.local_skill_blocklist !== undefined && {
                localSkillBlocklist:
                  extension.runtime_binding.local_skill_blocklist,
              }),
            },
    }),
    ...(extension.enable_general_subagent !== undefined && {
      enableGeneralSubagent: extension.enable_general_subagent,
    }),
  };
}

export function toAgentModelInput(
  model: AgentCreateBody["model"],
): string | AgentModelInput {
  if (typeof model === "string") return model;

  return {
    id: model.id,
    ...(model.effort !== undefined && {
      effort:
        typeof model.effort === "string"
          ? model.effort
          : (model.effort?.type ?? null),
    }),
    ...(model.inference_geo !== undefined && {
      inferenceGeo: model.inference_geo,
    }),
    ...(model.speed !== undefined && { speed: model.speed }),
  };
}

export function toCreateAgentCommand(body: AgentCreateBody): CreateAgentCommand {
  return {
    name: body.name,
    model: toAgentModelInput(body.model),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.mcp_servers !== undefined && {
      mcpServers: body.mcp_servers.map(toAgentMcpServerInput),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.multiagent !== undefined && {
      multiagent:
        body.multiagent === null
          ? null
          : toAgentMultiagentInput(body.multiagent),
    }),
    ...(body._oma !== undefined && { openma: toOpenMaInput(body._oma) }),
    ...(body.skills !== undefined && {
      skills: body.skills.map(toAgentSkillInput),
    }),
    ...(body.system !== undefined && { system: body.system }),
    ...(body.tools !== undefined && {
      tools: body.tools.map(toAgentToolInput),
    }),
  };
}

export function toUpdateAgentCommand(
  agentId: string,
  body: AgentUpdateBody,
): UpdateAgentCommand {
  return {
    agentId,
    ...(body.description !== undefined && { description: body.description }),
    ...(body.mcp_servers !== undefined && {
      mcpServers:
        body.mcp_servers === null
          ? null
          : body.mcp_servers.map(toAgentMcpServerInput),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.model !== undefined && { model: toAgentModelInput(body.model) }),
    ...(body.multiagent !== undefined && {
      multiagent:
        body.multiagent === null
          ? null
          : toAgentMultiagentInput(body.multiagent),
    }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body._oma !== undefined && { openma: toOpenMaInput(body._oma) }),
    ...(body.skills !== undefined && {
      skills:
        body.skills === null ? null : body.skills.map(toAgentSkillInput),
    }),
    ...(body.system !== undefined && { system: body.system }),
    ...(body.tools !== undefined && {
      tools: body.tools === null ? null : body.tools.map(toAgentToolInput),
    }),
    ...(body.version !== undefined && { expectedVersion: body.version }),
  };
}

export function toListAgentsQuery(query: AgentListQuery): ListAgentsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toListAgentVersionsQuery(
  agentId: string,
  query: AgentVersionListQuery,
): ListAgentVersionsQuery {
  return {
    agentId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

export function toAgentResponse(agent: AgentView): object {
  return {
    id: agent.id,
    archived_at: agent.archivedAt,
    created_at: agent.createdAt,
    description: agent.description,
    mcp_servers: agent.mcpServers.map(fromAgentMcpServerInput),
    metadata: agent.metadata,
    model: {
      id: agent.model.id,
      ...(agent.model.effort !== undefined && {
        effort: { type: agent.model.effort },
      }),
      ...(agent.model.inferenceGeo !== undefined && {
        inference_geo: agent.model.inferenceGeo,
      }),
      ...(agent.model.speed !== undefined && { speed: agent.model.speed }),
    },
    multiagent:
      agent.multiagent === null
        ? null
        : fromAgentMultiagentInput(agent.multiagent),
    name: agent.name,
    ...(agent.openma !== undefined &&
      Object.keys(agent.openma).length > 0 && {
        _oma: fromOpenMaAgentExtension(agent.openma),
      }),
    skills: agent.skills.map(fromAgentSkillInput),
    system: agent.system,
    tools: agent.tools.map(fromAgentToolInput),
    type: "agent",
    updated_at: agent.updatedAt,
    version: agent.version,
  };
}
