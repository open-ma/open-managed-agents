import type { AgentSession, Environment } from 'openai/resources/beta/agents/agents';
import type { CreateSessionCommand, SessionView as ManagedSession } from '@open-managed-agents/managed-agents-application/ports/sessions';
import type { UserMessageContentBlock } from '@open-managed-agents/managed-agents-application/ports/session-events';
import type { AgentsApplicationPort, AgentView } from '@open-managed-agents/managed-agents-application/ports/agents';
import type { EnvironmentsApplicationPort } from '@open-managed-agents/managed-agents-application/ports/environments';
import { OpenAIAgentsProtocolError } from '@open-managed-agents/openai-agents-api';
import { agentCompatibilityFields, agentResource, auditAgentRuntimeMapping, isInlineSessionAgent, nativeTemplateInputs, resolvedAgent, seconds, templateResource, toCoreAgentConfig, toCoreEnvironmentConfig, type AgentRuntimeMappingFinding } from './resource-mappers';
import { decodeResourceMetadata, encodeResourceMetadata } from './resource-metadata';
import type { ResourceObject, ResourceSecretSealer } from './resource-types';

/** Only configuration with no equivalent native Session/Agent/Environment field. */
export interface SessionMappingMetadata {
  agent: ResourceObject;
  environment: ResourceObject;
  /** Binds unmatched environment options to the selected native resource. */
  environmentId: string;
}
export interface ManagedSessionMappingRuntime {
  /** Must select/create a native environment that actually enacts this configuration. */
  prepareEnvironment?(configuration: ResourceObject): Promise<{ environmentId: string }>;
  /** Returns actual provider connection details; never synthesize an executor URL. */
  environmentView?(session: ManagedSession, configuration: ResourceObject): Promise<Environment>;
  /** An explicit runtime integration may enact options absent from native Agent fields. */
  assertAgentConfiguration?(configuration: ResourceObject, findings: AgentRuntimeMappingFinding[], environment: ResourceObject): Promise<void> | void;
}
export interface ManagedSessionMappingDependencies {
  agents: AgentsApplicationPort;
  environments: EnvironmentsApplicationPort;
  resources: {
    getAgentConfig?(id: string): Promise<ResourceObject>;
    resolveEnvironmentConfiguration(input: ResourceObject): Promise<ResourceObject>;
  };
  secrets: ResourceSecretSealer;
  runtime?: ManagedSessionMappingRuntime;
}
export interface ManagedSessionMapping {
  prepareCreate(body: ResourceObject): Promise<CreateSessionCommand>;
  sessionView(session: ManagedSession): Promise<AgentSession>;
  prepareMetadata(session: ManagedSession, metadata: Record<string, string> | null): Promise<Record<string, string | null>>;
}
const fail = (message: string, param?: string): never => { throw new OpenAIAgentsProtocolError(501, message, param, 'unsupported_feature'); };

export async function readSessionMappingMetadata(metadata: Record<string, string>, secrets: ResourceSecretSealer): Promise<SessionMappingMetadata | null> {
  const { fields } = decodeResourceMetadata(metadata, 'session');
  if (!fields) return null;
  if (typeof fields.sealed !== 'string') throw new OpenAIAgentsProtocolError(500, 'Session configuration metadata is incomplete');
  try {
    const decoded = JSON.parse(await secrets.open(fields.sealed));
    if (!decoded || typeof decoded !== 'object' || !decoded.agent || !decoded.environment || typeof decoded.environmentId !== 'string') throw new Error('Invalid session configuration');
    return decoded as SessionMappingMetadata;
  } catch { throw new OpenAIAgentsProtocolError(500, 'Session configuration metadata cannot be decoded'); }
}

/** Runtime access is scoped to the native Environment relation. */
export async function readManagedSessionMappingMetadata(session: ManagedSession, secrets: ResourceSecretSealer): Promise<SessionMappingMetadata | null> {
  const saved = await readSessionMappingMetadata(session.metadata, secrets);
  return saved?.environmentId === session.environmentId ? saved : null;
}
export async function isManagedNoEnvironmentSession(session: ManagedSession, secrets: ResourceSecretSealer): Promise<boolean> {
  return (await readManagedSessionMappingMetadata(session, secrets))?.environment.type === 'none';
}

function mergeConfiguration(base: ResourceObject, overrides: ResourceObject): ResourceObject {
  // Official configuration guide: supplied objects/arrays replace the entire
  // field; a null reset resolves to that field's documented defaults.
  return resolvedAgent({ ...base, ...overrides });
}

export function toManagedInputContent(value: unknown): Extract<UserMessageContentBlock, { type: 'text' | 'image' }>[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new OpenAIAgentsProtocolError(400, 'Input content must be text or content parts', 'input');
  return value.map((part: ResourceObject) => {
    if (part.type === 'input_text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const data = /^data:(image\/[^;,]+);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u.exec(part.image_url);
      if (data && data[2]) return { type: 'image', source: { type: 'base64', mediaType: data[1]!, data: data[2]! } };
      try {
        const url = new URL(part.image_url);
        if (url.protocol === 'http:' || url.protocol === 'https:') return { type: 'image', source: { type: 'url', url: part.image_url } };
      } catch { /* Invalid image location. */ }
      throw new OpenAIAgentsProtocolError(400, 'Image URL must be HTTP(S) or a base64 image data URL', 'input');
    }
    throw new OpenAIAgentsProtocolError(400, 'Unsupported input content', 'input');
  });
}

function initialEvents(input: unknown): NonNullable<CreateSessionCommand['initialEvents']> {
  if (input === undefined || input === null) return [];
  const messages = typeof input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input }] }] : input;
  if (!Array.isArray(messages)) throw new OpenAIAgentsProtocolError(400, 'Input must be text or user messages', 'input');
  return messages.map((message: ResourceObject) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) throw new OpenAIAgentsProtocolError(400, 'Input must contain user messages', 'input');
    return { type: 'user.message', content: toManagedInputContent(message.content) };
  });
}

export function createManagedSessionMapping(deps: ManagedSessionMappingDependencies): ManagedSessionMapping {
  async function environmentConfiguration(session: ManagedSession, metadata: SessionMappingMetadata | null): Promise<ResourceObject> {
    const result = await deps.environments.retrieveEnvironment({ environmentId: session.environmentId });
    if (result.type !== 'found') throw new OpenAIAgentsProtocolError(404, 'Session environment not found');
    const extras = metadata?.environmentId === session.environmentId ? metadata.environment : null;
    if (extras?.type === 'none') return { type: 'none' };
    if (extras?.type === 'self_hosted' || result.environment.config.type === 'self_hosted') return { ...extras, type: 'self_hosted' };
    const native = nativeTemplateInputs(result.environment, { network: extras?.network_hint });
    return { ...extras, ...native, type: 'openai_hosted' };
  }
  return {
    async prepareCreate(body) {
      const inputs = initialEvents(body.input);
      const rawEnvironment = body.environment;
      if (!rawEnvironment || typeof rawEnvironment.type !== 'string') throw new OpenAIAgentsProtocolError(400, 'An execution environment is required', 'environment');
      if (rawEnvironment.type === 'none' && inputs.length === 0) throw new OpenAIAgentsProtocolError(400, 'Sessions without an environment require initial input', 'input');
      if (!['none', 'self_hosted', 'openai_hosted'].includes(rawEnvironment.type)) throw new OpenAIAgentsProtocolError(400, 'Unknown environment type', 'environment.type');
      const environment = await deps.resources.resolveEnvironmentConfiguration(rawEnvironment);
      let nativeAgent: AgentView | undefined;
      if (body.agent_id != null) {
        const found = await deps.agents.retrieveAgent({ agentId: body.agent_id });
        if (found.type !== 'found' || found.agent.archivedAt !== null || isInlineSessionAgent(found.agent)) throw new OpenAIAgentsProtocolError(404, 'Agent not found', 'agent_id');
        nativeAgent = found.agent;
      }
      // Derive both the selected version and its configuration from one native
      // read, so a concurrent saved-agent update cannot mix two versions.
      const configuration = mergeConfiguration(nativeAgent ? agentResource(nativeAgent) : {}, body.agent ?? {});
      if (typeof configuration.model !== 'string' || configuration.model.length === 0) throw new OpenAIAgentsProtocolError(400, 'A model or saved agent is required', 'agent.model');
      const findings = auditAgentRuntimeMapping(configuration);
      if (deps.runtime?.assertAgentConfiguration) await deps.runtime.assertAgentConfiguration(configuration, findings, environment);
      else if (findings.length > 0) fail(`Selected runtime cannot enact ${findings[0]!.capability}`, `agent.${findings[0]!.path}`);
      if (environment.type !== 'openai_hosted' && !deps.runtime?.prepareEnvironment) fail(`The selected runtime does not support ${environment.type} sessions`, 'environment.type');
      if (environment.type === 'self_hosted' && !deps.runtime?.environmentView) fail('A compatible self-hosted executor connection is unavailable', 'environment.type');
      if (!deps.runtime?.prepareEnvironment) {
        const extra = ['env', 'setup_commands', 'files', 'plugins', 'skills', 'capability_directories'].find(key => environment[key] != null && Object.keys(environment[key]).length > 0);
        if (extra) fail(`The selected runtime does not support environment.${extra}`, `environment.${extra}`);
      }
      let environmentId: string;
      if (deps.runtime?.prepareEnvironment) ({ environmentId } = await deps.runtime.prepareEnvironment(environment));
      else {
        const created = await deps.environments.createEnvironment({ name: 'OpenAI session environment', config: toCoreEnvironmentConfig(environment) });
        if (created.type !== 'created') throw new OpenAIAgentsProtocolError(400, created.message, 'environment');
        environmentId = created.environment.id;
      }
      const core = toCoreAgentConfig(configuration);
      if (environment.type === 'none') core.tools = [{ type: 'agent_toolset_20260401', defaultConfig: { enabled: false }, configs: [] }, ...(core.tools ?? [])];
      const agentFields = agentCompatibilityFields(configuration, core);
      if (!nativeAgent) {
        const created = await deps.agents.createAgent({
          ...core,
          openma: {
            compatibility: {
              openai_agents_v1: {
                version: 1,
                fields: { session_inline: true },
              },
            },
          },
        });
        if (created.type !== 'created') throw new OpenAIAgentsProtocolError(400, created.message, 'agent');
        nativeAgent = created.agent;
      }
      const extras = Object.fromEntries(Object.entries(environment).filter(([key]) => !['packages', 'network', 'name', 'type'].includes(key)));
      const saved: SessionMappingMetadata = {
        agent: agentFields ?? {}, environmentId,
        environment: { ...extras, type: environment.type, ...(environment.network?.access === 'disabled' ? { network_hint: { native: 'limited', access: 'disabled', domains: [] } } : {}) },
      };
      return {
        agent: { type: 'overrides', agentId: nativeAgent.id, version: nativeAgent.version, model: core.model, system: core.system, tools: core.tools, mcpServers: core.mcpServers },
        environmentId,
        initialEvents: inputs,
        metadata: encodeResourceMetadata(body.metadata ?? {}, 'session', { sealed: await deps.secrets.seal(JSON.stringify(saved)) }),
        vaultIds: body.vault_ids ?? [],
      };
    },
    async sessionView(session) {
      const saved = await readSessionMappingMetadata(session.metadata, deps.secrets);
      const config = await environmentConfiguration(session, saved);
      let environment: Environment;
      if (deps.runtime?.environmentView) environment = await deps.runtime.environmentView(session, config);
      else if (config.type === 'none') environment = { type: 'none' };
      else if (config.type === 'self_hosted') return fail('A compatible self-hosted executor connection is unavailable', 'environment');
      else {
        const found = await deps.environments.retrieveEnvironment({ environmentId: session.environmentId });
        if (found.type !== 'found') throw new OpenAIAgentsProtocolError(404, 'Session environment not found');
        const view = templateResource(found.environment, config);
        environment = { id: session.environmentId, type: 'openai_hosted', capability_directories: view.capability_directories, network: view.network, packages: view.packages, files: view.files, plugins: view.plugins, skills: view.skills };
      }
      const projected = agentResource({
        ...session.agent,
        multiagent: null,
        archivedAt: null,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
        metadata: {},
        openma: {
          ...session.agent.openma,
          compatibility: {
            openai_agents_v1: {
              version: 1,
              fields: saved?.agent ?? {},
            },
          },
        },
      });
      const { id, instructions, model, multi_agent, name, reasoning, service_tier, text, tools } = projected;
      return {
        id: session.id, object: 'agent.session', agent: { id, instructions, model, multi_agent, name, reasoning, service_tier, text, tools },
        created_at: seconds(session.createdAt), last_active_at: seconds(session.updatedAt), environment,
        metadata: decodeResourceMetadata(session.metadata, 'session').metadata,
        status: session.status === 'running' || session.status === 'rescheduling' ? 'in_progress' : 'idle',
        error: null, required_actions: [], usage: null, vault_ids: [...session.vaultIds],
      };
    },
    async prepareMetadata(session, metadata) {
      const { fields } = decodeResourceMetadata(session.metadata, 'session');
      const encoded = fields ? encodeResourceMetadata(metadata ?? {}, 'session', fields) : metadata ?? {};
      return Object.fromEntries([
        ...Object.keys(session.metadata).filter(key => !(key in encoded)).map(key => [key, null]),
        ...Object.entries(encoded),
      ]);
    },
  };
}
