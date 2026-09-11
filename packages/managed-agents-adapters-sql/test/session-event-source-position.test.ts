import { describe, expect, it } from 'vitest';
import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import type { SqlClient, SqlStatement } from '@open-managed-agents/sql-client';
import { SqlSessionEventStore } from '@open-managed-agents/session-event-store-sql';
import { SqlSessionRuntimeHistorySource } from '@open-managed-agents/session-runtime-sql/history';
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from '@open-managed-agents/session-runtime-sql/coordination';
import type { Session, SentSessionEvent } from '@open-managed-agents/managed-agents-application';
import { SessionRuntimeHistoryApplicationService } from '@open-managed-agents/managed-agents-application';
import { SqlSessionRuntimeProjectionPersistence } from '../src/session-runtime-projection-sql-persistence';

const at = '2026-09-11T00:00:00.000Z';
const session: Session = {
  id: 'session', agent: { id: 'agent', name: 'Agent', description: null, mcpServers: [], model: { id: 'model' }, multiagent: null, skills: [], system: null, tools: [], version: 1 },
  archivedAt: null, budget: null, createdAt: at, environmentId: 'environment', metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: 'idle', title: null, updatedAt: at, usage: {}, vaultIds: [],
};
const input = (id: string): SentSessionEvent => ({ id, type: 'user.message', content: [{ type: 'text', text: id }], processedAt: at });
async function fixture() {
  const client = await createBetterSqlite3SqlClient(':memory:');
  await client.exec(`
    CREATE TABLE managed_sessions (workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL, agent_id text, agent_version integer, environment_id text, deployment_id text, status text, created_at integer, updated_at integer, archived_at integer, PRIMARY KEY (workspace_id,id));
    CREATE TABLE managed_session_initial_events (workspace_id text, session_id text, sequence integer, document text);
    CREATE TABLE managed_session_events (workspace_id text NOT NULL, session_id text NOT NULL, thread_id text, id text NOT NULL, type text NOT NULL, document text NOT NULL, processed_at integer NOT NULL, PRIMARY KEY (workspace_id,session_id,id));
  `);
  await client.prepare('INSERT INTO managed_sessions (workspace_id,id,document,revision,status,created_at,updated_at) VALUES (?,?,?,1,?,?,?)').bind('workspace', session.id, JSON.stringify(session), 'idle', Date.parse(at), Date.parse(at)).run();
  await ensureSessionExecutionCoordinatorSchema(client);
  const source = new SqlSessionRuntimeHistorySource(client);
  const scope = { workspaceId: 'workspace', sessionId: session.id };
  return { client, source, scope };
}

describe('Existing SQL event log source positions', () => {
  it('reads revision and history from one snapshot even when an input commits immediately after the read', async () => {
    const { client, scope } = await fixture();
    const store = new SqlSessionEventStore(client);
    let committed = false;
    const afterRead = async <T>(result: T): Promise<T> => {
      if (!committed) {
        committed = true;
        await store.append({ ...scope, expectedRevision: 1, events: [input('concurrent')], nextSession: session });
      }
      return result;
    };
    const interleaved: SqlClient = {
      prepare(sql) {
        let statement = client.prepare(sql);
        const wrapped: SqlStatement = {
          bind(...values) { statement = statement.bind(...values); return wrapped; },
          first: async <T>() => afterRead(await statement.first<T>()),
          all: async <T>() => afterRead(await statement.all<T>()),
          run: async <T>() => statement.run<T>(),
        };
        return wrapped;
      },
      batch: statements => client.batch(statements),
      exec: sql => client.exec(sql),
    };
    const observed = await new SqlSessionRuntimeHistorySource(interleaved).load(scope);
    expect(observed).toEqual({ revision: 1, initialEvents: [], events: [], orderedEvents: [] });
    expect(await new SqlSessionRuntimeHistorySource(client).load(scope)).toMatchObject({ revision: 2, events: [input('concurrent')] });
  });

  it.each([false, true])('preserves acceptance order and committed batch boundaries with executionOutbox=%s', async executionOutbox => {
    const { client, source, scope } = await fixture();
    const store = new SqlSessionEventStore(client, { executionOutbox });
    const first = [input('z_input'), input('a_steer')];
    await expect(store.append({ ...scope, expectedRevision: 1, events: first, nextSession: session })).resolves.toMatchObject({ type: 'appended', events: first });
    const last = [input('m_later')];
    await store.append({ ...scope, expectedRevision: 2, events: last, nextSession: session });
    await expect(store.append({ ...scope, expectedRevision: 1, events: [input('must_not_exist')], nextSession: session })).resolves.toEqual({ type: 'revision_conflict', actualRevision: 3 });
    const history = await source.load(scope);
    expect(history?.revision).toBe(3);
    expect(history?.events.map(e => e.id)).toEqual(['a_steer', 'm_later', 'z_input']);
    expect(history?.orderedEvents).toEqual([
      { event: first[0], position: { revision: 2, index: 0 } },
      { event: first[1], position: { revision: 2, index: 1 } },
      { event: last[0], position: { revision: 3, index: 0 } },
    ]);
    const publicEvents = await store.list({ ...scope, limit: 20, order: 'asc' });
    expect(publicEvents).toEqual([first[1], last[0], first[0]]);
    expect(publicEvents.every(e => !('source_position' in e))).toBe(true);
    const app = new SessionRuntimeHistoryApplicationService({ workspaceId: 'workspace', source });
    expect(await app.loadSessionRuntimeHistory({ sessionId: session.id })).toEqual({ type: 'found', ...history });
    expect(await source.load({ ...scope, workspaceId: 'foreign' })).toBeNull();
  });

  it('keeps runtime batch positions and execution identity stable across exact replay', async () => {
    const { client, source, scope } = await fixture();
    const store = new SqlSessionEventStore(client, { executionOutbox: true });
    await store.append({ ...scope, expectedRevision: 1, events: [input('accepted')], nextSession: session });
    const coordinator = new SqlSessionExecutionCoordinator(client);
    const claimed = await coordinator.claim({ ownerId: 'owner', attemptId: 'attempt', claimedAt: at, leaseTtlMs: 30_000 });
    expect(claimed.type).toBe('claimed');
    if (claimed.type !== 'claimed') throw new Error('Fixture execution was not claimed');
    const writer = new SqlSessionRuntimeProjectionPersistence(client, { now: () => new Date(at) });
    const events = [
      { id: 'z_running', type: 'session.status_running' as const, processedAt: at },
      { id: 'a_output', type: 'agent.message' as const, processedAt: at, content: [{ type: 'text' as const, text: 'Actual output' }] },
      { id: 'm_idle', type: 'session.status_idle' as const, processedAt: at, stopReason: { type: 'end_turn' as const } },
    ];
    const command = { ...scope, expectedRevision: 2, executionFence: claimed.fence, events, next: session };
    await expect(writer.project(command)).resolves.toMatchObject({ type: 'projected', record: { revision: 3 } });
    await expect(writer.project(command)).resolves.toMatchObject({ type: 'projected', record: { revision: 3 } });
    const history = await source.load(scope);
    expect(history?.orderedEvents?.slice(1)).toEqual(events.map((event, index) => ({ event, position: { revision: 3, index }, executionId: claimed.fence.executionId })));
    await expect(writer.project({ ...command, events: [{ ...events[0], id: 'stale' }] })).resolves.toEqual({ type: 'revision_conflict', actualRevision: 3 });
    expect((await source.load(scope))?.orderedEvents).toEqual(history?.orderedEvents);
  });

  it('leaves legacy ordering unchanged and never certifies mixed or invalid source positions', async () => {
    const { client, source, scope } = await fixture();
    const legacy = input('legacy');
    await client.prepare('INSERT INTO managed_session_events (workspace_id,session_id,id,type,document,processed_at) VALUES (?,?,?,?,?,?)').bind('workspace', session.id, legacy.id, legacy.type, JSON.stringify(legacy), Date.parse(at)).run();
    await new SqlSessionEventStore(client).append({ ...scope, expectedRevision: 1, events: [input('new')], nextSession: session });
    expect(await source.load(scope)).toEqual({ revision: 2, initialEvents: [], events: [legacy, input('new')] });
    await client.prepare('UPDATE managed_session_events SET document=? WHERE id=?').bind(JSON.stringify({ ...legacy, source_position: { revision: -1, index: 0 } }), legacy.id).run();
    expect(await source.load(scope)).toEqual({ revision: 2, initialEvents: [], events: [legacy, input('new')] });
    await client.prepare('UPDATE managed_session_events SET document=? WHERE id=?').bind(JSON.stringify({ ...legacy, source_position: { revision: 2, index: 0 } }), legacy.id).run();
    expect(await source.load(scope)).toEqual({ revision: 2, initialEvents: [], events: [legacy, input('new')] });
  });
});
