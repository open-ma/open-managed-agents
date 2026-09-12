import type {
  SessionCreateBody,
  SessionListQuery,
  SessionUpdateBody,
} from "../contracts/sessions";
import type {
  CreateSessionCommand,
  InitialSessionEvent,
  MonetaryAmount,
  ListSessionsQuery,
  SessionAgentSelector,
  SessionAgentView,
  SessionResourceInput,
  SessionView,
  UpdateSessionCommand,
} from "../ports/sessions";
import { toAgentModelInput } from "./agents";
import {
  fromAgentMcpServerInput,
  fromAgentModel,
  fromAgentSkillInput,
  fromAgentToolInput,
  fromSessionThreadAgent,
  toAgentMcpServerInput,
  toAgentSkillInput,
  toAgentToolInput,
} from "./agent-definition";
import { toSessionResourceResponse } from "./session-resources";
import { toSendableSessionEvent } from "./session-events";
import { fromOpenMaAgentExtension } from "./openma-agent-extension";

function toAgentSelector(agent: SessionCreateBody["agent"]): SessionAgentSelector {
  if (typeof agent === "string") {
    return { type: "latest", agentId: agent };
  }

  if (agent.type === "agent") {
    return agent.version === undefined
      ? { type: "latest", agentId: agent.id }
      : { type: "versioned", agentId: agent.id, version: agent.version };
  }

  return {
    type: "overrides",
    agentId: agent.id,
    ...(agent.version !== undefined && { version: agent.version }),
    ...(agent.mcp_servers !== undefined && {
      mcpServers: agent.mcp_servers.map(toAgentMcpServerInput),
    }),
    ...(agent.model !== undefined && { model: toAgentModelInput(agent.model) }),
    ...(agent.skills !== undefined && {
      skills: agent.skills.map(toAgentSkillInput),
    }),
    ...(agent.system !== undefined && { system: agent.system }),
    ...(agent.tools !== undefined && {
      tools: agent.tools.map(toAgentToolInput),
    }),
  };
}

function toMonetaryAmount(amount: { amount: string; currency: "USD" }): MonetaryAmount {
  return { amountMinor: amount.amount, currency: amount.currency };
}

function toSessionResourceInputs(
  resources: NonNullable<SessionCreateBody["resources"]>,
): SessionResourceInput[] {
  return resources.map((resource) => {
    switch (resource.type) {
      case "file":
        return {
          type: resource.type,
          fileId: resource.file_id,
          ...(resource.mount_path !== undefined && {
            mountPath: resource.mount_path,
          }),
        };
      case "github_repository":
        return {
          type: resource.type,
          authorizationToken: resource.authorization_token,
          url: resource.url,
          ...(resource.checkout !== undefined && {
            checkout: resource.checkout,
          }),
          ...(resource.mount_path !== undefined && {
            mountPath: resource.mount_path,
          }),
        };
      case "memory_store":
        return {
          type: resource.type,
          memoryStoreId: resource.memory_store_id,
          ...(resource.access !== undefined && { access: resource.access }),
          ...(resource.instructions !== undefined && {
            instructions: resource.instructions,
          }),
        };
    }
  });
}

function toInitialSessionEvent(
  event: NonNullable<SessionCreateBody["initial_events"]>[number],
): InitialSessionEvent {
  return toSendableSessionEvent(event) as InitialSessionEvent;
}

function fromMonetaryAmount(amount: MonetaryAmount): object {
  return { amount: amount.amountMinor, currency: amount.currency };
}

export function toCreateSessionCommand(body: SessionCreateBody): CreateSessionCommand {
  return {
    agent: toAgentSelector(body.agent),
    environmentId: body.environment_id,
    ...(body.budget !== undefined && {
      budget: toMonetaryAmount(body.budget.max_list_cost),
    }),
    ...(body.initial_events !== undefined && {
      initialEvents: body.initial_events.map(toInitialSessionEvent),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.resources !== undefined && {
      resources: toSessionResourceInputs(body.resources),
    }),
    ...(body.title !== undefined && { title: body.title }),
    ...(body.vault_ids !== undefined && { vaultIds: body.vault_ids }),
  };
}

export function toUpdateSessionCommand(
  sessionId: string,
  body: SessionUpdateBody,
): UpdateSessionCommand {
  return {
    sessionId,
    ...(body.agent !== undefined && {
      agent: {
        ...(body.agent.mcp_servers !== undefined && {
          mcpServers: body.agent.mcp_servers.map(toAgentMcpServerInput),
        }),
        ...(body.agent.tools !== undefined && {
          tools: body.agent.tools.map(toAgentToolInput),
        }),
      },
    }),
    ...(body.budget !== undefined && {
      budget:
        body.budget === null
          ? null
          : toMonetaryAmount(body.budget.max_list_cost),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.title !== undefined && { title: body.title }),
    ...(body.vault_ids !== undefined && { vaultIds: body.vault_ids }),
  };
}

export function toListSessionsQuery(query: SessionListQuery): ListSessionsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.agent_id !== undefined && { agentId: query.agent_id }),
    ...(query.agent_version !== undefined && {
      agentVersion: query.agent_version,
    }),
    ...(query["created_at[gt]"] !== undefined && {
      createdAfter: query["created_at[gt]"],
    }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lt]"] !== undefined && {
      createdBefore: query["created_at[lt]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.deployment_id !== undefined && {
      deploymentId: query.deployment_id,
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
    ...(query.memory_store_id !== undefined && {
      memoryStoreId: query.memory_store_id,
    }),
    ...(query.order !== undefined && { order: query.order }),
    ...(query.statuses !== undefined && { statuses: query.statuses }),
  };
}

export function toSessionAgentResponse(agent: SessionAgentView): object {
  return {
    id: agent.id,
    description: agent.description,
    mcp_servers: agent.mcpServers.map(fromAgentMcpServerInput),
    model: fromAgentModel(agent.model),
    multiagent:
      agent.multiagent === null
        ? null
        : {
            type: agent.multiagent.type,
            agents: agent.multiagent.agents.map(fromSessionThreadAgent),
          },
    name: agent.name,
    ...(agent.openma !== undefined &&
      Object.keys(agent.openma).length > 0 && {
        _oma: fromOpenMaAgentExtension(agent.openma),
      }),
    skills: agent.skills.map(fromAgentSkillInput),
    system: agent.system,
    tools: agent.tools.map(fromAgentToolInput),
    type: "agent",
    version: agent.version,
  };
}

export function toSessionResponse(session: SessionView): object {
  return {
    id: session.id,
    agent: toSessionAgentResponse(session.agent),
    archived_at: session.archivedAt,
    budget:
      session.budget === null
        ? null
        : {
            max_list_cost: fromMonetaryAmount(session.budget),
            type: "limit",
          },
    created_at: session.createdAt,
    environment_id: session.environmentId,
    metadata: session.metadata,
    outcome_evaluations: session.outcomeEvaluations.map((evaluation) => ({
      type: evaluation.type,
      completed_at: evaluation.completedAt,
      description: evaluation.description,
      explanation: evaluation.explanation,
      iteration: evaluation.iteration,
      outcome_id: evaluation.outcomeId,
      result: evaluation.result,
    })),
    resources: session.resources.map(toSessionResourceResponse),
    stats: {
      ...(session.stats.activeSeconds !== undefined && {
        active_seconds: session.stats.activeSeconds,
      }),
      ...(session.stats.durationSeconds !== undefined && {
        duration_seconds: session.stats.durationSeconds,
      }),
    },
    status: session.status,
    title: session.title,
    type: "session",
    updated_at: session.updatedAt,
    usage: {
      ...(session.usage.activeSeconds !== undefined && {
        active_seconds: session.usage.activeSeconds,
      }),
      ...(session.usage.cacheCreation !== undefined && {
        cache_creation: {
          ...(session.usage.cacheCreation.ephemeralOneHourInputTokens !== undefined && {
            ephemeral_1h_input_tokens:
              session.usage.cacheCreation.ephemeralOneHourInputTokens,
          }),
          ...(session.usage.cacheCreation.ephemeralFiveMinuteInputTokens !== undefined && {
            ephemeral_5m_input_tokens:
              session.usage.cacheCreation.ephemeralFiveMinuteInputTokens,
          }),
        },
      }),
      ...(session.usage.cacheReadInputTokens !== undefined && {
        cache_read_input_tokens: session.usage.cacheReadInputTokens,
      }),
      ...(session.usage.inputTokens !== undefined && {
        input_tokens: session.usage.inputTokens,
      }),
      ...(session.usage.listCost !== undefined && {
        list_cost:
          session.usage.listCost === null
            ? null
            : fromMonetaryAmount(session.usage.listCost),
      }),
      ...(session.usage.outputTokens !== undefined && {
        output_tokens: session.usage.outputTokens,
      }),
      ...(session.usage.serverToolUse !== undefined && {
        server_tool_use:
          session.usage.serverToolUse === null
            ? null
            : {
                ...(session.usage.serverToolUse.webFetchRequests !== undefined && {
                  web_fetch_requests: session.usage.serverToolUse.webFetchRequests,
                }),
                ...(session.usage.serverToolUse.webSearchRequests !== undefined && {
                  web_search_requests: session.usage.serverToolUse.webSearchRequests,
                }),
              },
      }),
    },
    vault_ids: session.vaultIds,
    ...(session.deploymentId !== undefined && {
      deployment_id: session.deploymentId,
    }),
  };
}
