import { OpenAIAgentsProtocolError, type OpenAIAgentsOperationRequest, type OpenAIAgentsOperationResponse } from "@open-managed-agents/openai-agents-api";
import type { AgentView } from "@open-managed-agents/managed-agents-application/ports/agents";
import type { VaultView } from "@open-managed-agents/managed-agents-application/ports/vaults";
import type { ResourceDependencies, ResourceObject } from "./resource-types";
import { agentCompatibility, agentResource, coreName, credentialResource, isInlineSessionAgent, nativeTemplateInputs, resolvedAgent, seconds, templateResource, toCoreAgentConfig, toCoreEnvironmentConfig, toCredentialAuth, toCredentialRotation } from "./resource-mappers";
import { decodeResourceMetadata, encodeResourceMetadata, hintedName, nameHint } from "./resource-metadata";

export { toCoreAgentConfig, toCoreEnvironmentConfig, resolvedAgent, templateResource } from "./resource-mappers";
export { resolvedAgent as normalizeAgentConfig } from "./resource-mappers";
export { auditAgentRuntimeMapping } from "./resource-mappers";
export type * from "./resource-types";

/** Native configuration records allocated for individual sessions are not
 * reusable templates in the public protocol. */
export function createSessionRuntimeEnvironmentMetadata(): Record<string, string> {
  return encodeResourceMetadata({}, "environment_template", { session_runtime: true });
}

function result<T extends { type: string }>(value: T): T {
  if (value.type === "not_found") throw new OpenAIAgentsProtocolError(404, "Resource not found", undefined, "resource_not_found");
  if (value.type === "invalid_request") throw new OpenAIAgentsProtocolError(400, (value as T & { message: string }).message);
  if (value.type === "version_conflict") throw new OpenAIAgentsProtocolError(409, (value as T & { message: string }).message);
  return value;
}

async function allPages<T>(fetch: (cursor?: string) => Promise<{ values: T[]; cursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await fetch(cursor);
    items.push(...page.values);
    cursor = page.cursor ?? undefined;
    if (cursor != null && seen.has(cursor)) throw new OpenAIAgentsProtocolError(500, "Application returned a repeated cursor");
    if (cursor != null) seen.add(cursor);
  } while (cursor != null);
  return items;
}

function page(items: ResourceObject[], query: OpenAIAgentsOperationRequest["query"], statuses?: Map<string, string>): ResourceObject {
  const direction = query.order === "asc" ? 1 : -1;
  const sorted = [...items].sort((a, b) => direction * (a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const anchor = query.after == null ? -1 : sorted.findIndex(item => item.id === query.after);
  if (query.after != null && anchor < 0) throw new OpenAIAgentsProtocolError(400, "The after cursor does not belong to this resource collection", "after");
  const filters = query.status == null ? null : Array.isArray(query.status) ? query.status : [query.status];
  const selected = sorted.slice(anchor + 1).filter(item => !filters || !statuses || filters.includes(statuses.get(item.id)!));
  const limit = Number(query.limit ?? 20);
  const data = selected.slice(0, limit);
  return { data, has_more: selected.length > limit };
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw new OpenAIAgentsProtocolError(400, "Name must be a string", "name");
  const name = value.trim();
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0 || bytes > 256) throw new OpenAIAgentsProtocolError(400, "Name must contain 1 to 256 UTF-8 bytes after trimming", "name");
  return name;
}

export function workspacePath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/workspace/") || path.includes("\0") || path.split("/").includes("..") || path.split("/").includes(".") || path.endsWith("/")) {
    throw new OpenAIAgentsProtocolError(400, "Path must be an absolute file path inside /workspace", "path");
  }
  return path;
}

export function decodeInline(data: unknown): Uint8Array {
  if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw new OpenAIAgentsProtocolError(400, "File data must use standard base64", "data");
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

function templateInputs(input: ResourceObject): ResourceObject {
  const next = structuredClone(input);
  for (const file of next.files ?? []) {
    workspacePath(file.path);
    if (file.type === "inline") decodeInline(file.data);
  }
  return next;
}

/** Implements resources through existing application ports. Protocol extras live
 * in the same native resource/version record, so native mutations remain visible. */
export function createResourcesHandler(deps: ResourceDependencies) {
  const retrieveAgent = async (id: string): Promise<AgentView> => {
    const retrieved = result(await deps.agents.retrieveAgent({ agentId: id }));
    if (retrieved.type !== "found" || retrieved.agent.archivedAt !== null || decodeResourceMetadata(retrieved.agent.metadata, "agent").fields?.session_inline === true) throw new OpenAIAgentsProtocolError(404, "Agent not found");
    return retrieved.agent;
  };
  const getAgentConfig = async (id: string): Promise<ResourceObject> => {
    const core = await retrieveAgent(id);
    return agentResource(core);
  };
  const vaultWire = async (vault: VaultView) => {
    const { metadata, fields } = decodeResourceMetadata(vault.metadata, "vault");
    return { id: vault.id, object: "vault", created_at: seconds(vault.createdAt), metadata, name: hintedName(vault.displayName, fields) };
  };
  const credentialWire = async (credential: Parameters<typeof credentialResource>[0]) => {
    return credentialResource(credential);
  };
  const credentialRows = (vaultId: string) => allPages(async cursor => {
    const listed = result(await deps.credentials.listCredentials({ vaultId, pageSize: 100, includeArchived: true, ...(cursor && { cursor }) }));
    if (listed.type !== "page") throw new Error("Invalid credential page");
    return { values: listed.page.credentials, cursor: listed.page.nextCursor };
  });
  const getTemplateConfiguration = async (id: string) => {
    const core = result(await deps.environments.retrieveEnvironment({ environmentId: id }));
    if (core.type !== "found" || core.environment.archivedAt !== null) throw new OpenAIAgentsProtocolError(404, "Environment template not found");
    if (core.environment.config.type !== "cloud") throw new OpenAIAgentsProtocolError(404, "Hosted environment template not found");
    const fields = decodeResourceMetadata(core.environment.metadata, "environment_template").fields ?? {};
    if (fields.session_runtime === true) throw new OpenAIAgentsProtocolError(404, "Environment template not found");
    const extra: ResourceObject = fields.sealed ? JSON.parse(await deps.secrets.open(fields.sealed)) : {};
    return { environment: core.environment, input: { ...extra, ...nativeTemplateInputs(core.environment, fields) } };
  };
  const getTemplate = async (id: string): Promise<ResourceObject> => {
    const { environment, input } = await getTemplateConfiguration(id);
    return templateResource(environment, input);
  };
  const templateMetadata = async (input: ResourceObject, nativeName: string, metadata: Record<string, string> = {}) => {
    const extra = Object.fromEntries(["env", "setup_commands", "files", "plugins", "skills", "capability_directories"].filter(key => input[key] != null).map(key => [key, input[key]]));
    return encodeResourceMetadata(metadata, "environment_template", {
      ...nameHint(input.name ?? null, nativeName),
      network: { native: input.network?.access === "enabled" || input.network == null ? "unrestricted" : "limited", access: input.network?.access ?? "enabled", domains: input.network?.access === "disabled" ? [] : input.network?.allowed_domains ?? [] },
      ...(Object.keys(extra).length && { sealed: await deps.secrets.seal(JSON.stringify(extra)) }),
    });
  };
  const resolveEnvironmentConfiguration = async (input: ResourceObject): Promise<ResourceObject> => {
    if (input.type !== "openai_hosted" || !input.environment_template_id) return structuredClone(input);
    const { input: base } = await getTemplateConfiguration(input.environment_template_id);
    const next = templateInputs({ ...base, ...input });
    if ("network" in input && base.network?.access !== undefined && base.network.access !== "enabled") {
      const access = input.network?.access ?? "enabled";
      const allowed = base.network.allowed_domains ?? [];
      const broadened = base.network.access === "disabled" ? access !== "disabled" : access === "enabled" || (access === "restricted" && (input.network?.allowed_domains ?? []).some((domain: string) => !allowed.includes(domain)));
      if (broadened) throw new OpenAIAgentsProtocolError(400, "Environment overrides cannot broaden the template network policy", "environment.network");
    }
    return next;
  };

  const execute = async (request: OpenAIAgentsOperationRequest): Promise<OpenAIAgentsOperationResponse> => {
    const { operation, params, body, query } = request;
    const input = body as ResourceObject;
    const agentId = params.agent_id!;
    const vaultId = params.vault_id!;
    const credentialId = params.credential_id!;
    const templateId = params.environment_template_id!;
    const environmentId = params.environment_id!;
    switch (operation) {
      case "agents.create": {
        const config = resolvedAgent(input);
        const command = toCoreAgentConfig(config);
        const created = result(await deps.agents.createAgent({
          ...command,
          openma: { compatibility: agentCompatibility(config, command) },
        }));
        if (created.type !== "created") throw new Error("Invalid agent create result");
        return { body: agentResource(created.agent) };
      }
      case "agents.retrieve": return { body: await getAgentConfig(agentId) };
      case "agents.update": {
        const core = await retrieveAgent(agentId);
        const current = agentResource(core);
        const config = resolvedAgent({ ...current, ...input });
        const command = toCoreAgentConfig(config);
        const metadata = Object.fromEntries([
          ...Object.keys(core.metadata)
            .filter(key => !(key in (command.metadata ?? {})))
            .map(key => [key, null]),
          ...Object.entries(command.metadata ?? {}),
        ]);
        const updated = result(await deps.agents.updateAgent({
          ...command,
          agentId,
          metadata,
          openma: { compatibility: agentCompatibility(config, command) },
          expectedVersion: core.version,
        }));
        if (updated.type !== "updated") throw new Error("Invalid agent update result");
        return { body: agentResource(updated.agent) };
      }
      case "agents.list": {
        const agents = await allPages(async cursor => {
          const listed = result(await deps.agents.listAgents({ pageSize: 100, ...(cursor && { cursor }) }));
          if (listed.type !== "page") throw new Error("Invalid agent page");
          return { values: listed.page.agents, cursor: listed.page.nextCursor };
        });
        return { body: page(agents.filter(agent => !isInlineSessionAgent(agent)).map(agentResource), query) };
      }
      case "agents.delete": {
        await retrieveAgent(agentId);
        result(await deps.agents.archiveAgent({ agentId }));
        return { body: { id: agentId, object: "agent.deleted", deleted: true } };
      }
      case "vaults.create": {
        const name = input.name === undefined ? null : validateName(input.name);
        const displayName = coreName(name, "OpenAI vault");
        const created = result(await deps.vaults.createVault({ displayName, metadata: encodeResourceMetadata(input.metadata ?? {}, "vault", nameHint(name, displayName)) }));
        if (created.type !== "created") throw new Error("Invalid vault create result");
        return { body: await vaultWire(created.vault) };
      }
      case "vaults.retrieve": {
        const retrieved = result(await deps.vaults.retrieveVault({ vaultId }));
        if (retrieved.type !== "found") throw new Error("Invalid vault retrieve result");
        return { body: await vaultWire(retrieved.vault) };
      }
      case "vaults.list": {
        const vaults = await allPages(async cursor => {
          const listed = result(await deps.vaults.listVaults({ pageSize: 100, includeArchived: true, ...(cursor && { cursor }) }));
          if (listed.type !== "page") throw new Error("Invalid vault page");
          return { values: listed.page.vaults, cursor: listed.page.nextCursor };
        });
        return { body: page(await Promise.all(vaults.map(vaultWire)), query, new Map(vaults.map(vault => [vault.id, vault.archivedAt === null ? "active" : "archived"]))) };
      }
      case "vaults.delete": {
        result(await deps.vaults.retrieveVault({ vaultId }));
        for (const credential of await credentialRows(vaultId)) {
          result(await deps.credentials.deleteCredential({ vaultId, credentialId: credential.id }));
        }
        result(await deps.vaults.deleteVault({ vaultId }));
        return { body: { id: vaultId, object: "vault.deleted", deleted: true } };
      }
      case "vaults.credentials.create": {
        const name = validateName(input.name);
        const created = result(await deps.credentials.createCredential({ vaultId, displayName: name, auth: toCredentialAuth(input.auth) }));
        if (created.type !== "created") throw new Error("Invalid credential create result");
        return { body: await credentialWire(created.credential) };
      }
      case "vaults.credentials.retrieve": {
        const retrieved = result(await deps.credentials.retrieveCredential({ vaultId, credentialId }));
        if (retrieved.type !== "found" || retrieved.credential.auth.type === "environment_variable") throw new OpenAIAgentsProtocolError(404, "Credential not found");
        return { body: await credentialWire(retrieved.credential) };
      }
      case "vaults.credentials.update": {
        const updated = result(await deps.credentials.updateCredential({ vaultId, credentialId, auth: toCredentialRotation(input.auth) }));
        if (updated.type !== "updated") throw new Error("Invalid credential update result");
        return { body: await credentialWire(updated.credential) };
      }
      case "vaults.credentials.list": {
        const credentials = (await credentialRows(vaultId)).filter(credential => credential.auth.type !== "environment_variable");
        return { body: page(await Promise.all(credentials.map(credentialWire)), query, new Map(credentials.map(credential => [credential.id, credential.archivedAt === null ? "active" : "archived"]))) };
      }
      case "vaults.credentials.delete": {
        result(await deps.credentials.deleteCredential({ vaultId, credentialId }));
        return { body: { id: credentialId, object: "vault.credential.deleted", deleted: true } };
      }
      case "environments.templates.create": {
        const config = templateInputs(input);
        const name = coreName(input.name, "OpenAI environment template");
        const created = result(await deps.environments.createEnvironment({ name, config: toCoreEnvironmentConfig(config), metadata: await templateMetadata(config, name) }));
        if (created.type !== "created") throw new Error("Invalid environment create result");
        return { body: await getTemplate(created.environment.id) };
      }
      case "environments.templates.retrieve": return { body: await getTemplate(templateId) };
      case "environments.templates.update": {
        const { environment, input: current } = await getTemplateConfiguration(templateId);
        const config = templateInputs({ ...current, ...input });
        const name = coreName(config.name, "OpenAI environment template");
        const { metadata } = decodeResourceMetadata(environment.metadata, "environment_template");
        const updated = result(await deps.environments.updateEnvironment({ environmentId: templateId, name, config: toCoreEnvironmentConfig(config), metadata: await templateMetadata(config, name, metadata) }));
        if (updated.type !== "updated") throw new Error("Invalid environment update result");
        return { body: await getTemplate(templateId) };
      }
      case "environments.templates.list": {
        const stored = await allPages(async cursor => {
          const listed = result(await deps.environments.listEnvironments({ pageSize: 100, ...(cursor && { cursor }) }));
          if (listed.type !== "page") throw new Error("Invalid environment page");
          return { values: listed.page.environments, cursor: listed.page.nextCursor };
        });
        const live: ResourceObject[] = [];
        for (const environment of stored) {
          if (environment.config.type === "cloud" && decodeResourceMetadata(environment.metadata, "environment_template").fields?.session_runtime !== true) live.push(await getTemplate(environment.id));
        }
        return { body: page(live, query) };
      }
      case "environments.templates.delete": {
        await getTemplate(templateId);
        result(await deps.environments.deleteEnvironment({ environmentId: templateId }));
        return { body: { id: templateId, object: "agent.environment.template.deleted", deleted: true } };
      }
      case "environments.retrieve": {
        const environment = await deps.runtime?.getEnvironment(environmentId);
        if (!environment) throw new OpenAIAgentsProtocolError(404, "Execution environment not found");
        return { body: environment };
      }
      case "environments.files.create": {
        const path = workspacePath(input.path);
        const environment = await deps.runtime?.getEnvironment(environmentId);
        if (!environment) throw new OpenAIAgentsProtocolError(404, "Execution environment not found");
        if (environment.status !== "connected") throw new OpenAIAgentsProtocolError(409, "Execution environment is not connected");
        let bytes: Uint8Array;
        if (input.type === "inline") bytes = decodeInline(input.data);
        else {
          const downloaded = deps.files ? result(await deps.files.downloadFile({ fileId: input.file_id })) : null;
          if (downloaded?.type !== "found") throw new OpenAIAgentsProtocolError(404, "Source file not found", "file_id");
          bytes = downloaded.file.content;
        }
        await deps.runtime!.writeFile(environmentId, path, bytes);
        return { body: { object: "agent.environment.file", environment_id: environmentId, path, size_bytes: bytes.length } };
      }
      case "environments.files.list": {
        const environment = await deps.runtime?.getEnvironment(environmentId);
        if (!environment) throw new OpenAIAgentsProtocolError(404, "Execution environment not found");
        if (environment.status !== "connected") throw new OpenAIAgentsProtocolError(409, "Execution environment is not connected");
        const directory = query.path == null ? "/workspace" : String(query.path).replace(/\/$/u, "");
        workspacePath(`${directory}/.listing`);
        const direction = query.order === "asc" ? 1 : -1;
        const files = (await deps.runtime!.listFiles(environmentId, directory)).filter(file => file.path.startsWith(`${directory}/`)).sort((a, b) => direction * (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        let offset = 0;
        if (query.page != null) {
          try {
            const token = JSON.parse(new TextDecoder().decode(decodeInline(String(query.page))));
            if (token.environment_id !== environmentId || token.path !== directory || token.order !== (query.order ?? "desc") || typeof token.after !== "string") throw new Error("Mismatched cursor");
            const index = files.findIndex(file => file.path === token.after);
            if (index < 0) throw new Error("Unknown cursor");
            offset = index + 1;
          } catch { throw new OpenAIAgentsProtocolError(400, "Invalid environment file cursor", "page"); }
        }
        const limit = Number(query.limit ?? 20);
        const data = files.slice(offset, offset + limit).map(file => ({ ...file, object: "agent.environment.file", environment_id: environmentId }));
        const hasMore = offset + limit < files.length;
        const nextCursor = hasMore ? btoa(Array.from(new TextEncoder().encode(JSON.stringify({ environment_id: environmentId, path: directory, order: query.order ?? "desc", after: data.at(-1)!.path })), byte => String.fromCharCode(byte)).join("")) : null;
        return { body: { data, has_more: hasMore, next: nextCursor } };
      }
      default: throw new OpenAIAgentsProtocolError(404, "Unknown resource operation");
    }
  };
  return Object.assign(execute, { getAgentConfig, resolveEnvironmentConfiguration });
}
