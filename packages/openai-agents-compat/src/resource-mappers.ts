import type { AgentView, CreateAgentCommand, AgentToolInput } from "@open-managed-agents/managed-agents-application/ports/agents";
import type { CredentialAuthInput, CredentialAuthUpdate, CredentialView } from "@open-managed-agents/managed-agents-application/ports/credentials";
import type { EnvironmentConfigInput, EnvironmentView } from "@open-managed-agents/managed-agents-application/ports/environments";
import type { ResourceObject } from "./resource-types";
import { decodeResourceMetadata, encodeResourceMetadata, hintedName, nameHint } from "./resource-metadata";

export const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
export const coreName = (name: unknown, fallback: string) => typeof name === "string" && name.trim().length > 0 && name.length <= 255 && !/\p{Cc}/u.test(name) ? name : fallback;

export function resolvedTool(tool: ResourceObject): ResourceObject {
  switch (tool.type) {
    case "function": return { ...tool, defer_loading: tool.defer_loading ?? false };
    case "programmatic_tool_calling": return { ...tool, enabled: tool.enabled ?? true };
    case "mcp": return {
      ...tool, allowed_tools: tool.allowed_tools ?? null, connection_origin: tool.connection_origin ?? "service",
      credential_id: tool.credential_id ?? null, request_metadata: tool.request_metadata ?? {}, required: tool.required ?? false,
      transport: tool.transport.type === "http" ? { ...tool.transport, headers: tool.transport.headers ?? {} } : { ...tool.transport, args: tool.transport.args ?? [], env_vars: tool.transport.env_vars ?? [] },
    };
    case "web_search": return {
      ...tool, allowed_domains: tool.allowed_domains ?? null, context_size: tool.context_size ?? "medium", mode: tool.mode ?? "live",
      location: tool.location == null ? null : { city: tool.location.city ?? null, country: tool.location.country ?? null, region: tool.location.region ?? null, timezone: tool.location.timezone ?? null },
    };
    default: return { ...tool };
  }
}

export function resolvedAgent(input: ResourceObject): ResourceObject {
  const enabled = input.multi_agent?.enabled ?? false;
  return {
    name: input.name ?? null, instructions: input.instructions ?? null, metadata: input.metadata ?? {}, model: input.model,
    multi_agent: { enabled, max_concurrent_subagents: enabled ? input.multi_agent?.max_concurrent_subagents ?? 6 : null },
    reasoning: { effort: input.reasoning?.effort ?? null, summary: input.reasoning?.summary ?? null }, service_tier: input.service_tier ?? "auto",
    text: { format: input.text?.format ?? { type: "text" }, verbosity: input.text?.verbosity ?? "medium" },
    tools: (input.tools ?? []).map(resolvedTool),
  };
}

/** Only translates concepts already present in the application. Runtime-specific
 * remaining options are surfaced by auditAgentRuntimeMapping below. */
export function toCoreAgentConfig(input: ResourceObject): CreateAgentCommand {
  const tools: AgentToolInput[] = [];
  const mcpServers: CreateAgentCommand["mcpServers"] = [];
  for (const tool of input.tools ?? []) {
    if (tool.type === "function") tools.push({ type: "custom", name: tool.name, description: tool.description, inputSchema: tool.parameters });
    if (tool.type === "web_search") tools.push({
      type: "agent_toolset_20260401", defaultConfig: { enabled: false }, configs: [{
        name: "web_search", enabled: tool.mode !== "disabled", ...(tool.allowed_domains != null && { allowedDomains: tool.allowed_domains }),
        ...(tool.location != null && { userLocation: { type: "approximate", ...tool.location } }),
      }],
    });
    if (tool.type === "mcp" && tool.transport.type === "http") {
      mcpServers.push({ name: tool.server_label, type: "url", url: tool.transport.server_url });
      tools.push({ type: "mcp_toolset", mcpServerName: tool.server_label, defaultConfig: { enabled: tool.allowed_tools == null }, configs: (tool.allowed_tools ?? []).map((name: string) => ({ name, enabled: true })) });
    }
  }
  const effort = input.reasoning?.effort;
  return {
    name: coreName(input.name, "OpenAI agent"), system: input.instructions ?? null, metadata: input.metadata ?? {}, tools, mcpServers,
    model: { id: input.model, ...(["low", "medium", "high", "xhigh", "max"].includes(effort) && { effort }), ...(input.service_tier === "fast" && { speed: "fast" }) },
  };
}

export function agentMetadata(input: ResourceObject, core: CreateAgentCommand): Record<string, string> {
  const fields: ResourceObject = { ...nameHint(input.name ?? null, core.name), tool_order: [], tool_extras: {} };
  if (input.reasoning?.summary != null) fields.reasoning_summary = input.reasoning.summary;
  if (["none", "minimal"].includes(input.reasoning?.effort)) fields.reasoning_effort = { model: input.model, effort: input.reasoning.effort };
  if (input.service_tier && input.service_tier !== "auto" && input.service_tier !== "fast") fields.service_tier = input.service_tier;
  if (input.multi_agent?.enabled) fields.multi_agent = input.multi_agent;
  if (input.text?.format?.type !== "text" || input.text?.verbosity !== "medium") fields.text = input.text;
  for (const tool of input.tools ?? []) {
    const key = tool.type === "function" ? `function:${tool.name}` : tool.type === "mcp" && tool.transport.type === "http" ? `mcp:${tool.server_label}` : tool.type === "web_search" ? "web_search" : null;
    if (key == null) { fields.tool_order.push({ inline: tool }); continue; }
    fields.tool_order.push({ key });
    if (tool.type === "function") fields.tool_extras[key] = { defer_loading: tool.defer_loading ?? false };
    if (tool.type === "web_search") fields.tool_extras[key] = { mode: tool.mode ?? "live", context_size: tool.context_size ?? "medium" };
    if (tool.type === "mcp") fields.tool_extras[key] = {
      connection_origin: tool.connection_origin ?? "service", credential_id: tool.credential_id ?? null,
      request_metadata: tool.request_metadata ?? {}, required: tool.required ?? false, headers: tool.transport.headers ?? {},
    };
  }
  return encodeResourceMetadata(core.metadata ?? {}, "agent", fields);
}

export function agentResource(agent: AgentView): ResourceObject {
  const { metadata, fields } = decodeResourceMetadata(agent.metadata, "agent");
  const extras = fields?.tool_extras ?? {};
  const tools = new Map<string, ResourceObject>();
  for (const tool of agent.tools) {
    if (tool.type === "custom") tools.set(`function:${tool.name}`, { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, defer_loading: extras[`function:${tool.name}`]?.defer_loading ?? false });
    if (tool.type === "agent_toolset_20260401") {
      const search = tool.configs.find(config => config.name === "web_search");
      if (search?.name === "web_search") tools.set("web_search", {
        type: "web_search", mode: search.enabled ? extras.web_search?.mode === "cached" ? "cached" : "live" : "disabled", context_size: extras.web_search?.context_size ?? "medium",
        allowed_domains: search.allowedDomains ?? null, location: search.userLocation ? { city: search.userLocation.city ?? null, country: search.userLocation.country ?? null, region: search.userLocation.region ?? null, timezone: search.userLocation.timezone ?? null } : null,
      });
    }
  }
  for (const server of agent.mcpServers) {
    const extra = extras[`mcp:${server.name}`] ?? {};
    const toolset = agent.tools.find(tool => tool.type === "mcp_toolset" && tool.mcpServerName === server.name);
    tools.set(`mcp:${server.name}`, resolvedTool({ type: "mcp", server_label: server.name, ...extra, transport: { type: "http", server_url: server.url, headers: extra.headers ?? {} }, allowed_tools: toolset?.type === "mcp_toolset" && !toolset.defaultConfig.enabled ? toolset.configs.filter(config => config.enabled).map(config => config.name) : null }));
    delete tools.get(`mcp:${server.name}`)!.headers;
  }
  const ordered: ResourceObject[] = [];
  for (const entry of fields?.tool_order ?? []) {
    if (entry.inline) ordered.push(entry.inline);
    else if (tools.has(entry.key)) { ordered.push(tools.get(entry.key)!); tools.delete(entry.key); }
  }
  ordered.push(...tools.values());
  const effort = agent.model.effort ?? (fields?.reasoning_effort?.model === agent.model.id ? fields.reasoning_effort.effort : null);
  return {
    ...resolvedAgent({ name: hintedName(agent.name, fields), instructions: agent.system, metadata, model: agent.model.id, tools: ordered, reasoning: { effort, summary: fields?.reasoning_summary }, service_tier: agent.model.speed === "fast" ? "fast" : fields?.service_tier ?? "auto", multi_agent: fields?.multi_agent, text: fields?.text }),
    id: agent.id, object: "agent", created_at: seconds(agent.createdAt), updated_at: seconds(agent.updatedAt),
  };
}

export interface AgentRuntimeMappingFinding { path: string; capability: string }
/** Session execution checks these capabilities explicitly instead of silently
 * accepting a field that the selected runtime cannot enact. */
export function auditAgentRuntimeMapping(input: ResourceObject): AgentRuntimeMappingFinding[] {
  const findings: AgentRuntimeMappingFinding[] = [];
  if (input.multi_agent?.enabled) findings.push({ path: "multi_agent", capability: "dynamic_subagents" });
  if (["none", "minimal"].includes(input.reasoning?.effort)) findings.push({ path: "reasoning.effort", capability: "reasoning_effort" });
  if (input.reasoning?.summary != null) findings.push({ path: "reasoning.summary", capability: "reasoning_summary" });
  if (input.service_tier && !["auto", "fast"].includes(input.service_tier)) findings.push({ path: "service_tier", capability: "service_tier" });
  if (input.text?.format?.type === "json_schema") findings.push({ path: "text.format", capability: "structured_output" });
  if (input.text?.verbosity && input.text.verbosity !== "medium") findings.push({ path: "text.verbosity", capability: "text_verbosity" });
  (input.tools ?? []).forEach((tool: ResourceObject, index: number) => {
    const add = (field: string, capability: string) => findings.push({ path: `tools.${index}${field}`, capability });
    if (tool.type === "function" && tool.defer_loading) add(".defer_loading", "deferred_tools");
    if (tool.type === "tool_search") add("", "tool_search");
    if (tool.type === "programmatic_tool_calling" && tool.enabled !== false) add("", "programmatic_tool_calling");
    if (tool.type === "web_search") {
      if (tool.mode === "cached") add(".mode", "cached_web_search");
      if (tool.context_size && tool.context_size !== "medium") add(".context_size", "web_search_context_size");
    }
    if (tool.type === "mcp") {
      if (tool.transport.type === "stdio") add(".transport", "mcp_stdio");
      if (Object.keys(tool.transport.headers ?? {}).length) add(".transport.headers", "mcp_headers");
      if (tool.connection_origin === "environment") add(".connection_origin", "mcp_environment_origin");
      if (tool.credential_id != null) add(".credential_id", "mcp_credential_selection");
      if (tool.required) add(".required", "mcp_required_initialization");
      if (Object.keys(tool.request_metadata ?? {}).length) add(".request_metadata", "mcp_request_metadata");
    }
  });
  return findings;
}

export function nativeTemplateInputs(environment: EnvironmentView, fields: ResourceObject): ResourceObject {
  if (environment.config.type !== "cloud") throw new Error("Hosted templates require a cloud environment");
  const { networking, packages } = environment.config;
  const domains = networking.type === "unrestricted" ? [] : networking.allowedHosts;
  const sameNetwork = fields.network?.native === networking.type && JSON.stringify(fields.network.domains) === JSON.stringify(domains);
  return { name: hintedName(environment.name, fields), network: { access: sameNetwork ? fields.network.access : networking.type === "unrestricted" ? "enabled" : "restricted", allowed_domains: domains }, packages: { python: packages.pip, system: packages.apt, npm: packages.npm } };
}

export function toCredentialAuth(auth: ResourceObject): CredentialAuthInput {
  if (auth.type === "static_bearer") return { type: auth.type, token: auth.token, mcpServerUrl: auth.mcp_server_url };
  return {
    type: "mcp_oauth", accessToken: auth.access_token, mcpServerUrl: auth.mcp_server_url,
    ...(auth.expires_at !== undefined && { expiresAt: auth.expires_at }),
    ...(auth.refresh !== undefined && { refresh: auth.refresh == null ? null : {
      clientId: auth.refresh.client_id, refreshToken: auth.refresh.refresh_token, tokenEndpoint: auth.refresh.token_endpoint,
      tokenEndpointAuth: auth.refresh.token_endpoint_auth.type === "none" ? { type: "none" } : { type: auth.refresh.token_endpoint_auth.type, clientSecret: auth.refresh.token_endpoint_auth.client_secret },
      ...(auth.refresh.resource !== undefined && { resource: auth.refresh.resource }), ...(auth.refresh.scope !== undefined && { scope: auth.refresh.scope }),
    } }),
  };
}

export function toCredentialRotation(auth: ResourceObject): CredentialAuthUpdate {
  if (auth.type === "static_bearer") return { type: auth.type, token: auth.token };
  return {
    type: "mcp_oauth", ...(auth.access_token !== undefined && { accessToken: auth.access_token }),
    ...(auth.expires_at !== undefined && { expiresAt: auth.expires_at }),
    ...(auth.access_token != null && auth.expires_at === undefined && { expiresAt: null }),
    ...(auth.refresh !== undefined && { refresh: auth.refresh == null ? null : {
      ...(auth.refresh.refresh_token !== undefined && { refreshToken: auth.refresh.refresh_token }),
      ...(auth.refresh.scope !== undefined && { scope: auth.refresh.scope }),
      ...(auth.refresh.token_endpoint_auth != null && { tokenEndpointAuth: { type: auth.refresh.token_endpoint_auth.type, ...(auth.refresh.token_endpoint_auth.client_secret !== undefined && { clientSecret: auth.refresh.token_endpoint_auth.client_secret }) } }),
    } }),
  };
}

export function credentialResource(credential: CredentialView, name?: string): ResourceObject {
  const auth = credential.auth;
  if (auth.type === "environment_variable") throw new Error("Environment variable credentials are not MCP credentials");
  return {
    id: credential.id, object: "vault.credential", vault_id: credential.vaultId, name: name ?? credential.displayName ?? credential.id,
    created_at: seconds(credential.createdAt), updated_at: seconds(credential.updatedAt),
    auth: auth.type === "static_bearer" ? { type: auth.type, mcp_server_url: auth.mcpServerUrl } : {
      type: auth.type, mcp_server_url: auth.mcpServerUrl, expires_at: auth.expiresAt ?? null,
      refresh: auth.refresh == null ? null : { client_id: auth.refresh.clientId, token_endpoint: auth.refresh.tokenEndpoint, token_endpoint_auth: { type: auth.refresh.tokenEndpointAuth.type }, scope: auth.refresh.scope ?? null, resource: auth.refresh.resource ?? null },
    },
  };
}

export function toCoreEnvironmentConfig(input: ResourceObject): EnvironmentConfigInput {
  const network = input.network;
  return { type: "cloud", networking: network == null || network.access === "enabled" ? { type: "unrestricted" } : { type: "limited", allowedHosts: network.access === "disabled" ? [] : network.allowed_domains ?? [], allowMcpServers: false, allowPackageManagers: false }, packages: { pip: input.packages?.python ?? [], apt: input.packages?.system ?? [], npm: input.packages?.npm ?? [] } };
}

export function templateResource(environment: EnvironmentView, input: ResourceObject): ResourceObject {
  return {
    id: environment.id, object: "agent.environment.template", name: input.name ?? null,
    created_at: seconds(environment.createdAt), updated_at: seconds(environment.updatedAt),
    capability_directories: input.capability_directories ?? [],
    network: { access: input.network?.access ?? "enabled", allowed_domains: input.network?.allowed_domains ?? [] },
    packages: { python: input.packages?.python ?? [], system: input.packages?.system ?? [], npm: input.packages?.npm ?? [] },
    files: (input.files ?? []).map((file: ResourceObject) => file.type === "file_id" ? { type: file.type, path: file.path, file_id: file.file_id } : { type: "inline", path: file.path, size_bytes: atob(file.data).length }),
    plugins: (input.plugins ?? []).map((plugin: ResourceObject) => ({ type: "inline", name: plugin.name, description: plugin.description })),
    skills: (input.skills ?? []).map((skill: ResourceObject) => skill.type === "skill_reference" ? { type: skill.type, skill_id: skill.skill_id, version: skill.version ?? null } : { type: "inline", name: skill.name, description: skill.description }),
  };
}
