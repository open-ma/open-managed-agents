import { describe, expect, it } from 'vitest';
import type { Session } from '@open-managed-agents/managed-agents-application';
import { resourcesFixture } from './helpers/resources';
import { createManagedSessionMapping, readSessionMappingMetadata, toManagedInputContent } from '../src/session-mapping';
import { validateOpenAIAgentsSchema } from '@open-managed-agents/openai-agents-api';

async function fixture() {
  const f = resourcesFixture();
  const prepared: Record<string, any>[] = [];
  const mapping = createManagedSessionMapping({
    agents: f.agents, environments: f.environments, resources: f.handler, secrets: f.secrets,
    runtime: {
      async assertAgentConfiguration() {},
      async prepareEnvironment(config) {
        prepared.push(structuredClone(config));
        const result = await f.environments.createEnvironment({ name: 'Runtime environment', config: { type: 'cloud' } });
        if (result.type !== 'created') throw new Error('Fixture environment failed');
        return { environmentId: result.environment.id };
      },
      async environmentView(_session, config) {
        if (config.type === 'none') return { type: 'none' };
        if (config.type === 'self_hosted') return { id: _session.environmentId, type: 'self_hosted', remote_url: 'wss://actual-executor.test/remote', workspace_directory: config.workspace_directory ?? '/workspace', capability_directories: config.capability_directories ?? [] };
        throw new Error('Unconfigured fixture hosted runtime');
      },
    },
  });
  async function snapshot(command: Awaited<ReturnType<typeof mapping.prepareCreate>>): Promise<Session> {
    const found = await f.agents.retrieveAgent({ agentId: command.agent.agentId, ...('version' in command.agent ? { version: command.agent.version } : {}) });
    if (found.type !== 'found') throw new Error('Missing selected agent');
    const { metadata: _metadata, createdAt: _created, updatedAt: _updated, archivedAt: _archived, ...agent } = found.agent;
    const overrides = command.agent.type === 'overrides' ? command.agent : undefined;
    return { id: 'session', agent: { ...agent, multiagent: null, ...(overrides?.system !== undefined ? { system: overrides.system } : {}), ...(overrides?.model !== undefined ? { model: typeof overrides.model === 'string' ? { id: overrides.model } : overrides.model as typeof agent.model } : {}), ...(overrides?.tools !== undefined ? { tools: overrides.tools as typeof agent.tools } : {}) }, archivedAt: null, budget: null, createdAt: '2026-09-11T01:00:00Z', updatedAt: '2026-09-11T01:00:01Z', environmentId: command.environmentId, metadata: command.metadata ?? {}, outcomeEvaluations: [], resources: [], stats: {}, status: 'running', title: null, usage: {}, vaultIds: command.vaultIds ?? [] };
  }
  return { ...f, mapping, snapshot, prepared };
}

describe('Managed Session semantic mapping', () => {
  it('pins saved agent version, retains only unmatched sealed config, and reads the native Session snapshot', async () => {
    const f = await fixture();
    const saved = await f.run('agents.create', { name: 'Original', model: 'model-one', instructions: 'Original instructions', text: { verbosity: 'high' }, reasoning: { summary: 'concise' }, tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, defer_loading: true }] });
    const command = await f.mapping.prepareCreate({ agent_id: saved.id, environment: { type: 'none' }, input: 'Begin', metadata: { owner: 'original' } });
    expect(command.agent).toMatchObject({ agentId: saved.id, version: 1 });
    const core = await f.snapshot(command);
    await f.agents.updateAgent({ agentId: saved.id, name: 'Changed later', system: 'Changed instructions', model: 'model-two' });
    const wire = await f.mapping.sessionView(core);
    expect(wire).toMatchObject({ object: 'agent.session', agent: { id: saved.id, name: 'Original', model: 'model-one', instructions: 'Original instructions', text: { verbosity: 'high' }, reasoning: { summary: 'concise' }, tools: [{ type: 'function', defer_loading: true }] }, metadata: { owner: 'original' }, environment: { type: 'none' }, usage: null });
    expect(validateOpenAIAgentsSchema(wire, 'agents.AgentSession')).toEqual({ success: true });
    const fields = await readSessionMappingMetadata(core.metadata, f.secrets);
    expect(JSON.stringify(fields)).not.toMatch(/Original instructions|model-one|"Original"/);
    expect(fields?.agent).not.toHaveProperty('tools');
    const changedNative = { ...core, agent: { ...core.agent, system: 'Native Session edit', model: { id: 'native-current-model' } } };
    expect(await f.mapping.sessionView(changedNative)).toMatchObject({ agent: { model: 'native-current-model', instructions: 'Native Session edit' } });
  });

  it('translates input text/images and keeps secret unmatched configuration out of native metadata plaintext', async () => {
    const f = await fixture();
    const command = await f.mapping.prepareCreate({ agent: { model: 'model', tools: [{ type: 'mcp', server_label: 'private', transport: { type: 'http', server_url: 'https://private.test', headers: { Authorization: 'secret-token' } } }] }, environment: { type: 'self_hosted', workspace_directory: '/actual', capability_directories: ['/capabilities'] }, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect' }, { type: 'input_image', image_url: 'https://img.test/a.png' }] }], vault_ids: ['vault'] });
    expect(command.initialEvents).toEqual([{ type: 'user.message', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', source: { type: 'url', url: 'https://img.test/a.png' } }] }]);
    expect(JSON.stringify(command.metadata)).not.toContain('secret-token');
    const native = await f.agents.retrieveAgent({ agentId: command.agent.agentId });
    expect(JSON.stringify(native)).not.toContain('secret-token');
    const session = await f.snapshot(command);
    expect(await f.mapping.sessionView(session)).toMatchObject({ vault_ids: ['vault'], environment: { type: 'self_hosted', workspace_directory: '/actual', remote_url: 'wss://actual-executor.test/remote' }, agent: { tools: [{ transport: { headers: { Authorization: 'secret-token' } } }] } });
    expect(await f.run('agents.list')).toMatchObject({ data: [] });
  });

  it('replaces public metadata, preserves internal fields, and round-trips a user key collision', async () => {
    const f = await fixture();
    const core = await f.snapshot(await f.mapping.prepareCreate({ agent: { model: 'model' }, environment: { type: 'none' }, input: 'Start', metadata: { old: 'delete', __openai_agents_v1: 'user value' } }));
    const patch = await f.mapping.prepareMetadata(core, { next: 'value', __openai_agents_v1: 'new user value' });
    const metadata = { ...core.metadata };
    for (const [key, value] of Object.entries(patch)) { if (value === null) delete metadata[key]; else metadata[key] = value; }
    expect(await f.mapping.sessionView({ ...core, metadata })).toMatchObject({ metadata: { next: 'value', __openai_agents_v1: 'new user value' }, environment: { type: 'none' } });
    const clear = await f.mapping.prepareMetadata({ ...core, metadata }, null);
    for (const [key, value] of Object.entries(clear)) { if (value === null) delete metadata[key]; else metadata[key] = value; }
    expect(await f.mapping.sessionView({ ...core, metadata })).toMatchObject({ metadata: {}, agent: { model: 'model' } });
  });

  it('rejects an unavailable runtime semantic before creating support resources', async () => {
    const f = resourcesFixture();
    const mapping = createManagedSessionMapping({ agents: f.agents, environments: f.environments, resources: f.handler, secrets: f.secrets });
    await expect(mapping.prepareCreate({ agent: { model: 'model' }, environment: { type: 'none' }, input: 'Start' })).rejects.toMatchObject({ status: 501 });
    await expect(mapping.prepareCreate({ agent: { model: 'model' }, environment: { type: 'self_hosted' } })).rejects.toMatchObject({ status: 501 });
    await expect(mapping.prepareCreate({ agent: { model: 'model', reasoning: { summary: 'auto' } }, environment: { type: 'openai_hosted' }, input: 'Start' })).rejects.toMatchObject({ status: 501 });
    expect(await f.agents.listAgents({})).toMatchObject({ page: { agents: [] } });
    expect(await f.environments.listEnvironments({})).toMatchObject({ page: { environments: [] } });
  });
  it('disables default native filesystem and shell tools for none and preserves that execution marker across metadata updates', async () => {
    const f = await fixture();
    const command = await f.mapping.prepareCreate({ agent: { model: 'model', tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: {} }] }, environment: { type: 'none' }, input: 'Go' });
    expect(command.agent).toMatchObject({ type: 'overrides', tools: [
      { type: 'agent_toolset_20260401', defaultConfig: { enabled: false }, configs: [] },
      { type: 'custom', name: 'lookup' },
    ] });
    const session = await f.snapshot(command);
    const wire = await f.mapping.sessionView(session);
    expect(wire.agent.tools.map(tool => tool.type)).toEqual(['function']);
    const { isManagedNoEnvironmentSession } = await import('../src/session-mapping');
    expect(await isManagedNoEnvironmentSession(session, f.secrets)).toBe(true);
    expect(await isManagedNoEnvironmentSession({ ...session, environmentId: 'replaced-natively' }, f.secrets)).toBe(false);
  });

  it('maps plain hosted configuration through native environment packages and network', async () => {
    const f = resourcesFixture();
    const mapping = createManagedSessionMapping({ agents: f.agents, environments: f.environments, resources: f.handler, secrets: f.secrets });
    const command = await mapping.prepareCreate({ agent: { model: 'model' }, environment: { type: 'openai_hosted', network: { access: 'disabled' }, packages: { npm: ['lodash'], python: ['requests'] } }, input: 'Go' });
    expect(await f.environments.retrieveEnvironment({ environmentId: command.environmentId })).toMatchObject({ environment: { config: { type: 'cloud', networking: { type: 'limited', allowedHosts: [] }, packages: { npm: ['lodash'], pip: ['requests'] } } } });
    const saved = await readSessionMappingMetadata(command.metadata!, f.secrets);
    expect(saved?.environment).not.toHaveProperty('packages');
    expect(saved?.environment).not.toHaveProperty('network');
  });

  it('replaces supplied agent objects as documented instead of merging saved nested fields', async () => {
    const f = await fixture();
    const saved = await f.run('agents.create', { model: 'model', text: { format: { type: 'json_schema', schema: { type: 'object' } }, verbosity: 'low' }, reasoning: { effort: 'high', summary: 'concise' }, tools: [{ type: 'function', name: 'old', description: '', parameters: {} }] });
    const command = await f.mapping.prepareCreate({ agent_id: saved.id, agent: { text: { verbosity: 'high' }, reasoning: { effort: 'low' }, tools: null }, environment: { type: 'none' }, input: 'Go' });
    const session = await f.snapshot(command);
    expect(await f.mapping.sessionView(session)).toMatchObject({ agent: { text: { format: { type: 'text' }, verbosity: 'high' }, reasoning: { effort: 'low', summary: null }, tools: [] } });
    const reset = await f.mapping.prepareCreate({ agent_id: saved.id, agent: { text: null, reasoning: null }, environment: { type: 'none' }, input: 'Reset' });
    expect(await f.mapping.sessionView(await f.snapshot(reset))).toMatchObject({ agent: { text: { format: { type: 'text' }, verbosity: 'medium' }, reasoning: { effort: null, summary: null } } });
  });

  it('uses the same base64 and URL image conversion for initial input and later tool results', () => {
    expect(toManagedInputContent([{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }])).toEqual([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' } }]);
    expect(toManagedInputContent('Actual tool result')).toEqual([{ type: 'text', text: 'Actual tool result' }]);
    expect(() => toManagedInputContent([{ type: 'input_image', image_url: 'file:///private/secret' }])).toThrow(/Image URL/);
    expect(() => toManagedInputContent([{ type: 'input_image', image_url: 'data:text/html;base64,aGVsbG8=' }])).toThrow(/Image URL/);
  });

  it('gives runtime capability validation the resolved environment before creating resources', async () => {
    const f = resourcesFixture();
    const seen: unknown[] = [];
    const mapping = createManagedSessionMapping({ agents: f.agents, environments: f.environments, resources: f.handler, secrets: f.secrets, runtime: {
      assertAgentConfiguration(configuration, findings, environment) {
        seen.push({ model: configuration.model, findings, type: environment.type });
        throw new Error('This executor cannot enact the requested environment tools');
      },
    } });
    await expect(mapping.prepareCreate({ agent: { model: 'model' }, environment: { type: 'none' }, input: 'Go' })).rejects.toThrow('cannot enact');
    expect(seen).toEqual([{ model: 'model', findings: [], type: 'none' }]);
    expect(await f.agents.listAgents({})).toMatchObject({ page: { agents: [] } });
  });

});
