import type { EventCreateBody, SessionCreateBody } from "./contracts";
import type { CreateSessionCommand, InputContent, MessageItemView, SessionEvent, SessionInput, SessionView, TokenUsage, TurnView } from "./ports";

const provided = <T, R>(value: T | undefined, key: string, map: (value: T) => R): Record<string, R> => value === undefined ? {} : { [key]: map(value) };
const same = <T>(value: T) => value;
const nullable = <T, R>(map: (value: T) => R) => (value: T | null): R | null => value === null ? null : map(value);
const mapInputContent = (part: { type: "input_text"; text: string } | { type: "input_image"; image_url: string }): InputContent => part.type === "input_text" ? { type: "text", text: part.text } : { type: "image", imageUrl: part.image_url };
const mapInputMessage = (message: { role: "user"; content: Parameters<typeof mapInputContent>[0][] }) => ({ role: message.role, content: message.content.map(mapInputContent) });

export function toCreateSessionCommand(body: SessionCreateBody): CreateSessionCommand {
  const env = body.environment;
  const environment: CreateSessionCommand["environment"] = env.type === "none" ? { type: "none" } : env.type === "self_hosted" ? { type: "selfHosted", workspaceDirectory: env.workspace_directory, ...provided(env.capability_directories, "capabilityDirectories", same) } : { type: "hosted", ...provided(env.environment_template_id, "templateId", same), ...provided(env.env, "env", same), ...provided(env.capability_directories, "capabilityDirectories", same), ...provided(env.packages, "packages", same), ...provided(env.network, "network", nullable((network) => ({ access: network.access, ...provided(network.allowed_domains, "allowedDomains", same) }))) };
  return {
    environment,
    ...provided(body.agent_id, "agentId", same),
    ...provided(body.agent, "agent", (agent) => ({
      ...provided(agent.model, "model", same), ...provided(agent.instructions, "instructions", same),
      ...provided(agent.reasoning, "reasoning", same), ...provided(agent.service_tier, "serviceTier", same),
      ...provided(agent.multi_agent, "multiAgent", nullable((value) => ({ enabled: value.enabled, ...provided(value.max_concurrent_subagents, "maxConcurrentSubagents", same) }))),
      ...provided(agent.text, "text", same),
      ...provided(agent.tools, "tools", nullable((tools) => tools.map((tool) => ({ type: tool.type, name: tool.name, description: tool.description, parameters: tool.parameters, ...provided(tool.defer_loading, "deferLoading", same) })))),
    })),
    ...provided(body.input, "input", nullable((input) => typeof input === "string" ? input : input.map(mapInputMessage))),
    ...provided(body.metadata, "metadata", same), ...provided(body.vault_ids, "vaultIds", same),
  };
}

export function toSessionInput(event: EventCreateBody["events"][number]): SessionInput {
  if (event.type === "agent.session.input.cancel") return { type: "cancel" };
  if (event.type === "agent.session.input.message") return { type: "message", input: event.input.map(mapInputMessage) };
  return { type: "toolResult", callId: event.call_id, turnId: event.turn_id, success: event.success, ...provided(event.error, "error", same), ...provided(event.output, "output", nullable((output) => typeof output === "string" ? output : output.map(mapInputContent))) };
}

export function toTokenUsage(usage: TokenUsage | null) {
  return usage === null ? null : { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.inputTokensDetails.cachedTokens }, output_tokens_details: { reasoning_tokens: usage.outputTokensDetails.reasoningTokens } };
}
const status = (value: string) => ({ inProgress: "in_progress", requiresAction: "requires_action" })[value] ?? value;

export function toSessionResponse(session: SessionView) {
  const agent = session.agent;
  const environment = session.environment;
  if (environment.type !== "none" && environment.type !== "selfHosted") throw new Error("Unsupported application environment variant");
  return {
    id: session.id, object: "agent.session", created_at: session.createdAt, last_active_at: session.lastActiveAt,
    agent: { id: agent.id, name: agent.name, model: agent.model, instructions: agent.instructions, reasoning: agent.reasoning, service_tier: agent.serviceTier, multi_agent: { enabled: agent.multiAgent.enabled, max_concurrent_subagents: agent.multiAgent.maxConcurrentSubagents }, text: agent.text, tools: agent.tools.map((tool) => ({ type: tool.type, name: tool.name, description: tool.description, parameters: tool.parameters, defer_loading: tool.deferLoading })) },
    environment: environment.type === "none" ? { type: "none" } : { type: "self_hosted", id: environment.id, workspace_directory: environment.workspaceDirectory, capability_directories: environment.capabilityDirectories, remote_url: environment.remoteUrl },
    metadata: session.metadata, error: session.error, status: status(session.status), usage: toTokenUsage(session.usage), vault_ids: session.vaultIds,
    required_actions: session.requiredActions.map((action) => {
      if (action.type === "functionCall") return { type: "function_call", call_id: action.callId, turn_id: action.turnId, name: action.name, arguments: action.arguments };
      if (action.type === "environmentConnection") return { type: "environment_connection", environment_id: action.environmentId };
      throw new Error("Unsupported application required action variant");
    }),
  };
}

export function toTurnResponse(turn: TurnView) {
  return { id: turn.id, object: "agent.session.turn", agent_id: turn.agentId, session_id: turn.sessionId, subagent_id: turn.subagentId, created_at: turn.createdAt, started_at: turn.startedAt, completed_at: turn.completedAt, status: status(turn.status), error: turn.error, usage: toTokenUsage(turn.usage) };
}

export function toMessageItemResponse(item: MessageItemView) {
  return { type: item.type, id: item.id, turn_id: item.turnId, role: item.role, phase: item.phase === "finalAnswer" ? "final_answer" : item.phase, status: status(item.status), content: item.content.map((part) => {
    if (part.type === "image") return { type: "input_image", image_url: part.imageUrl };
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "outputText") return { type: "output_text", text: part.text };
    throw new Error("Unsupported application message content variant");
  }) };
}

export function toSessionEvent(event: SessionEvent): unknown {
  if ("session" in event) return { type: `agent.session.${status(event.type)}`, event_id: event.eventId, session: toSessionResponse(event.session) };
  if (event.type === "outputTextDelta" || event.type === "outputTextDone") return { type: `agent.session.turn.output_text.${event.type === "outputTextDelta" ? "delta" : "done"}`, event_id: event.eventId, session_id: event.sessionId, turn_id: event.turnId, item_id: event.itemId, content_index: event.contentIndex, output_index: event.outputIndex, ...(event.type === "outputTextDelta" ? { delta: event.delta } : { text: event.text }) };
  const types = { turnCreated: "created", turnInProgress: "in_progress", turnCompleted: "completed", turnFailed: "failed", turnCancelled: "cancelled" };
  return { type: `agent.session.turn.${types[event.type]}`, event_id: event.eventId, session_id: event.sessionId, turn_id: event.turnId, turn: toTurnResponse(event.turn), ...("usage" in event ? { usage: toTokenUsage(event.usage) } : {}) };
}
