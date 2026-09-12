import { afterEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBetterSqlite3SqlClient } from '../../sql-client/src/index';
import { SqlAgentPersistence, SqlEnvironmentPersistence, SqlManagedSessionsComposition, SqlSessionEnvironmentSource, type SqlManagedSessionsRuntime } from '../../managed-agents-adapters-sql/src/index';
import { AgentsApplicationService, EnvironmentsApplicationService, SessionRuntimeHistoryApplicationService, SessionRuntimeProjectionApplicationService, type RuntimeProducedSessionEvent, type SessionLifecycleCommandPort } from '../../managed-agents-application/src/index';
import { buildOpenAIAgentsProtocolApi } from '../../openai-agents-api/src/index';
import { createResourcesHandler } from '../src/resources';
import { createManagedSessionMapping } from '../src/session-mapping';
import { createSessionsHandler } from '../src/sessions';
import { resourcesFixture } from './helpers/resources';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openai-sql-sdk-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sessions.sqlite');
  const sql = await createBetterSqlite3SqlClient(filename);
  // Apply the same schema files that the Node production entrypoint migrates.
  const migrations = new URL('../../../apps/main-node/migrations-sqlite/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', migrations), 'utf8')) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) await sql.exec(await readFile(new URL(`${entry.tag}.sql`, migrations), 'utf8'));
  const sharedResources = resourcesFixture();
  const workspaceId = 'workspace_sdk_a';
  const clock = { now: () => new Date('2026-09-11T01:00:00.000Z') };
  let sequence = 0;
  const agents = new AgentsApplicationService({ workspaceId, clock, store: new SqlAgentPersistence(sql), ids: { nextAgentId: () => `agent_${++sequence}` } });
  const environments = new EnvironmentsApplicationService({ workspaceId, clock, store: new SqlEnvironmentPersistence(sql), ids: { nextEnvironmentId: () => `environment_${++sequence}` } });
  const resources = createResourcesHandler({ ...sharedResources, agents, environments });
  const environment = await environments.createEnvironment({ name: 'No-environment logical runtime', config: { type: 'cloud' } });
  if (environment.type !== 'created') throw new Error(environment.message);
  const dispatches: Array<{ sessionId: string; eventIds: string[] }> = [];
  const starts: string[] = [];
  const mapping = createManagedSessionMapping({
    agents, environments, resources, secrets: sharedResources.secrets,
    runtime: {
      async prepareEnvironment(configuration) {
        if (configuration.type !== 'none') throw new Error('This executor fixture only exercises none');
        return { environmentId: environment.environment.id };
      },
      async environmentView() { return { type: 'none' }; },
    },
  });
  async function compose(client = sql) {
    let projection: SessionRuntimeProjectionApplicationService;
    const record = async (sessionId: string, events: RuntimeProducedSessionEvent[]) => {
      const recorded = await projection.recordSessionRuntimeEvents({ sessionId, events });
      if (recorded.type !== 'recorded') throw new Error(`Native runtime recording failed: ${recorded.type}`);
    };
    const produced = async (sessionId: string, source: string, mode: 'initial' | 'lookup' | 'result' | 'hold' | 'cancel' | 'message') => {
      const at = clock.now().toISOString();
      const running: RuntimeProducedSessionEvent = { id: `z_running_${source}`, type: 'session.status_running', processedAt: at };
      const idle: RuntimeProducedSessionEvent = { id: `a_idle_${source}`, type: 'session.status_idle', processedAt: at, stopReason: { type: 'end_turn' } };
      const message: RuntimeProducedSessionEvent = { id: `m_answer_${source}`, type: 'agent.message', processedAt: at, content: [{ type: 'text', text: mode === 'result' ? 'Actual lookup result consumed' : `Actual ${mode} response` }] };
      if (mode === 'cancel') return record(sessionId, [idle]);
      if (mode === 'hold') return record(sessionId, [running]);
      if (mode === 'lookup') return record(sessionId, [running, { id: `call_${source}`, type: 'agent.custom_tool_use', name: 'lookup', input: { key: 'native' }, processedAt: at }, { ...idle, stopReason: { type: 'requires_action', eventIds: [`call_${source}`] } }]);
      return record(sessionId, [running, message, idle]);
    };
    const lifecycle: SessionLifecycleCommandPort = {
      async sessionStarted(input) { starts.push(input.sessionId); await produced(input.sessionId, `bootstrap_${input.sessionId}`, 'initial'); },
      async sessionStopped() {},
    };
    // Only the execution boundary is controlled here. Every API operation,
    // admission, revision, history read and output commit uses real services.
    const runtime: SqlManagedSessionsRuntime = {
      async sessionEventsAccepted(input) {
        dispatches.push({ sessionId: input.sessionId, eventIds: input.events.map(event => event.id) });
        const event = input.events[0]!;
        const text = 'content' in event ? event.content?.flatMap(part => part.type === 'text' ? [part.text] : []).join('') : '';
        const mode = event.type === 'user.interrupt' ? 'cancel' : event.type === 'user.custom_tool_result' ? 'result' : text === 'lookup' ? 'lookup' : text === 'hold' ? 'hold' : 'message';
        await produced(input.sessionId, event.id, mode);
      },
      async sessionThreadArchived() {},
      subscribe: () => (async function* () {})(),
    };
    const composition = new SqlManagedSessionsComposition({ client, environments: new SqlSessionEnvironmentSource(client), lifecycle, runtime, sealer: sharedResources.secrets, clock, ids: { nextSessionId: () => `session_${++sequence}`, nextEventId: () => `event_${++sequence}`, nextOutcomeId: () => `outcome_${++sequence}`, nextResourceId: () => `resource_${++sequence}` } });
    cleanups.push(() => composition.stopAll());
    projection = new SessionRuntimeProjectionApplicationService({ workspaceId, persistence: composition.runtimeProjection });
    const ports = composition.portsFor(workspaceId);
    const sessions = createSessionsHandler({ workspaceId, sessions: ports.sessions, sessionEvents: ports.sessionEvents, history: new SessionRuntimeHistoryApplicationService({ workspaceId, source: composition.runtimeHistory }), mapping, pollMs: 1 });
    const app = buildOpenAIAgentsProtocolApi({ execute: request => request.operation.startsWith('sessions.') ? sessions.execute(request) : resources(request) });
    const sdk = new OpenAI({ apiKey: 'local-test', baseURL: 'http://localhost/v1', maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
    return { sdk, ports, composition };
  }
  return { ...(await compose()), sql, starts, dispatches, async restart() { return compose(await createBetterSqlite3SqlClient(filename)); } };
}

const message = (text: string) => ({ type: 'agent.session.input.message' as const, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text }] }] });

describe('Official SDK through native SQL managed services', () => {
  it('replays bootstrap, function continuation, cancellation, and idempotent admissions after adapter restart', async () => {
    const f = await fixture();
    const session = await f.sdk.beta.agents.sessions.create({ agent: { model: 'controlled-executor', tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }] }, environment: { type: 'none' }, input: 'Initial request' });
    expect(session).toMatchObject({ status: 'idle', environment: { type: 'none' }, agent: { model: 'controlled-executor' } });
    expect(f.starts).toEqual([session.id]);
    const initialTurns = await f.sdk.beta.agents.sessions.turns.list(session.id, { order: 'asc' });
    expect(initialTurns.data).toMatchObject([{ status: 'completed' }]);
    const initialItems = await f.sdk.beta.agents.sessions.items.list(session.id, { order: 'asc' });
    expect(initialItems.data).toMatchObject([{ role: 'user', content: [{ type: 'input_text', text: 'Initial request' }] }, { role: 'assistant', content: [{ type: 'output_text', text: 'Actual initial response' }], status: 'completed' }]);

    // These keys produce native IDs opposite to admission order. Every event
    // shares one timestamp, so only the persisted source position is authoritative.
    const lookup = { events: [message('lookup')], 'Idempotency-Key': 'hold-request' };
    await f.sdk.beta.agents.sessions.events.create(session.id, lookup);
    await f.sdk.beta.agents.sessions.events.create(session.id, lookup);
    expect(f.dispatches).toHaveLength(1);
    const waiting = await f.sdk.beta.agents.sessions.retrieve(session.id);
    expect(waiting.status).toBe('requires_action');
    const action = waiting.required_actions[0]!;
    if (action.type !== 'function_call') throw new Error('Expected a factual function action');
    expect(action).toMatchObject({ name: 'lookup', arguments: { key: 'native' } });
    const turn = await f.sdk.beta.agents.sessions.turns.retrieve(action.turn_id, { session_id: session.id });
    expect(turn.status).toBe('waiting');
    const result = { events: [{ type: 'agent.session.input.tool_result' as const, call_id: action.call_id, turn_id: action.turn_id, success: true, output: 'Actual native tool result' }], 'Idempotency-Key': 'tool-result' };
    await f.sdk.beta.agents.sessions.events.create(session.id, result);
    await f.sdk.beta.agents.sessions.events.create(session.id, result);
    expect(f.dispatches).toHaveLength(2);
    expect((await f.sdk.beta.agents.sessions.turns.retrieve(action.turn_id, { session_id: session.id })).status).toBe('completed');
    expect((await f.sdk.beta.agents.sessions.turns.list(session.id)).data).toHaveLength(2);
    await expect(f.sdk.beta.agents.sessions.events.create(session.id, { events: [message('changed')], 'Idempotency-Key': 'hold-request' })).rejects.toMatchObject({ status: 409 });
    expect(f.dispatches).toHaveLength(2);

    await f.sdk.beta.agents.sessions.events.create(session.id, { events: [message('hold')], 'Idempotency-Key': 'lookup-request' });
    const active = (await f.sdk.beta.agents.sessions.turns.list(session.id)).data.find(turn => turn.status === 'in_progress');
    expect(active).toBeDefined();
    const cancel = { events: [{ type: 'agent.session.input.cancel' as const }], 'Idempotency-Key': 'cancel-request' };
    await f.sdk.beta.agents.sessions.events.create(session.id, cancel);
    await f.sdk.beta.agents.sessions.events.create(session.id, cancel);
    expect(f.dispatches).toHaveLength(4);
    expect((await f.sdk.beta.agents.sessions.turns.retrieve(active!.id, { session_id: session.id })).status).toBe('cancelled');

    const beforeTurns = await f.sdk.beta.agents.sessions.turns.list(session.id, { order: 'asc' });
    // SDK 7.15.0 explicitly orders this collection by created_at, then turn ID;
    // this wire sort must not alter the internally projected input ownership.
    expect(beforeTurns.data.map(turn => turn.id)).toEqual([initialTurns.data[0]!.id, active!.id, action.turn_id]);
    expect(beforeTurns.data.map(turn => turn.status)).toEqual(['completed', 'cancelled', 'completed']);
    const beforeItems = await f.sdk.beta.agents.sessions.items.list(session.id, { order: 'asc', limit: 100 });
    const restarted = await f.restart();
    expect((await restarted.sdk.beta.agents.sessions.turns.list(session.id, { order: 'asc' })).data).toEqual(beforeTurns.data);
    expect((await restarted.sdk.beta.agents.sessions.items.list(session.id, { order: 'asc', limit: 100 })).data).toEqual(beforeItems.data);
    expect(beforeItems.data).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: action.call_id, turn_id: action.turn_id, output: [{ type: 'input_text', text: 'Actual native tool result' }] }));
    expect(JSON.stringify(beforeItems)).not.toContain('source_position');
    const history = await restarted.composition.runtimeHistory.load({ workspaceId: 'workspace_sdk_a', sessionId: session.id });
    expect(history?.orderedEvents?.map(row => row.event.id)).not.toEqual(history?.events.map(event => event.id));
    expect(new Set(beforeTurns.data.map(turn => turn.id)).size).toBe(3);
    const raw = await f.sql.prepare('SELECT document FROM managed_session_events WHERE session_id=?').bind(session.id).all<{ document: string }>();
    expect(raw.results?.every(row => JSON.parse(row.document).source_position)).toBe(true);
  });
  it('streams factual SQL-recorded output through the official SDK and disconnects without durable cancellation', async () => {
    const f = await fixture();
    const streamed = await f.sdk.beta.agents.sessions.create({ agent: { model: 'controlled-executor' }, environment: { type: 'none' }, input: 'Stream actual recorded output', stream: true });
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let sessionId: string | undefined;
    for await (const event of streamed) {
      events.push(event as unknown as { type: string; [key: string]: unknown });
      if (event.type === 'agent.session.created') sessionId = event.session.id;
      if (event.type === 'agent.session.turn.completed' && event.turn.subagent_id === null) break;
    }
    expect(sessionId).toBeDefined();
    expect(events[0]?.type).toBe('agent.session.created');
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.session.turn.output_text.done', text: 'Actual initial response' }));
    expect(events.some(event => event.type === 'agent.session.turn.output_text.delta')).toBe(false);
    expect(f.dispatches).toEqual([]);
    expect((await f.sdk.beta.agents.sessions.retrieve(sessionId!)).status).toBe('idle');
    expect((await f.sdk.beta.agents.sessions.turns.list(sessionId!)).data).toMatchObject([{ status: 'completed' }]);
    const history = await f.composition.runtimeHistory.load({ workspaceId: 'workspace_sdk_a', sessionId: sessionId! });
    expect(history?.events.some(event => event.type === 'user.interrupt')).toBe(false);
  });

});
