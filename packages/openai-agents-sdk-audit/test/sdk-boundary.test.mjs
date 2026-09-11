import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import OpenAI from 'openai';
import { assertCoverage, assertRequest, buildReport, discoverMethods } from '../src/audit.mjs';
import { scenarios } from '../src/scenarios.mjs';
import * as runner from '../src/runner.mjs';

test('every released Agents SDK method has an executable boundary scenario', () => {
  const client = new OpenAI({ apiKey: 'sdk-audit-key' });
  assertCoverage(discoverMethods(client.beta.agents), scenarios);
  assert.equal(new Set(scenarios.map(scenario => scenario.id)).size, scenarios.length);
  assert.equal(scenarios.filter(scenario => scenario.method === 'beta.agents.sessions.create').length, 2);
});

for (const scenario of scenarios) {
  test(`SDK wire contract: ${scenario.id}`, async () => {
    const captured = await runner.captureScenario(scenario);
    assert.equal(captured.requests.length, scenario.expected.length);
    captured.requests.forEach((request, index) => assertRequest(request, scenario.expected[index]));
  });
}

test('request capture observes serialized path parameters without rewriting them', async () => {
  const { client, requests } = runner.createCaptureClient(() => Response.json({}));
  await client.beta.agents.retrieve('agent with space');
  assert.equal(requests[0].path, '/v1/agents/agent%20with%20space');
});

test('capture transport preserves SDK typed errors and request IDs', async () => {
  const { client } = runner.createCaptureClient(() => Response.json({
    error: { message: 'No such session', type: 'invalid_request_error', code: 'session_not_found', param: 'session_id' },
  }, { status: 404, headers: { 'x-request-id': 'req_audit' } }));
  await assert.rejects(client.beta.agents.sessions.retrieve('missing'), error => {
    assert.ok(error instanceof OpenAI.NotFoundError);
    assert.equal(error.requestID, 'req_audit');
    assert.equal(error.code, 'session_not_found');
    assert.equal(error.param, 'session_id');
    return true;
  });
});

test('request capture preserves repeated status filters rather than silently dropping one', async () => {
  const { client, requests } = runner.createCaptureClient(() => Response.json({ object: 'list', data: [], has_more: false }));
  await client.beta.agents.vaults.list({ status: ['active', 'archived'] });
  assert.deepEqual(requests[0].query, { 'status[]': ['active', 'archived'] });
});

test('optional vault create arguments serialize an empty JSON body', async () => {
  const { client, requests } = runner.createCaptureClient(() => Response.json({}));
  await client.beta.agents.vaults.create();
  assert.deepEqual(requests[0].body, {});
  assert.equal(requests[0].httpMethod, 'POST');
});

test('cursor pagination follows the last object ID and preserves filters', async () => {
  const { client, requests } = runner.createCaptureClient((request, index) => Response.json(index === 0
    ? { object: 'list', data: [{ id: 'sess_first' }], has_more: true, first_id: 'sess_first', last_id: 'sess_first' }
    : { object: 'list', data: [{ id: 'sess_second' }], has_more: false, first_id: 'sess_second', last_id: 'sess_second' }));
  const ids = [];
  for await (const session of client.beta.agents.sessions.list({ limit: 1, order: 'asc', agent_id: 'agent_audit' })) ids.push(session.id);
  assert.deepEqual(ids, ['sess_first', 'sess_second']);
  assert.deepEqual(requests[1].query, { limit: '1', order: 'asc', agent_id: 'agent_audit', after: 'sess_first' });
});

test('environment file pagination uses opaque page tokens rather than file IDs', async () => {
  const { client, requests } = runner.createCaptureClient((request, index) => Response.json(index === 0
    ? { object: 'list', data: [{ path: '/workspace/first' }], has_more: true, next: 'opaque/next==' }
    : { object: 'list', data: [{ path: '/workspace/second' }], has_more: false, next: null }));
  const paths = [];
  for await (const file of client.beta.agents.environments.files.list('env_audit', { path: '/workspace', limit: 1 })) paths.push(file.path);
  assert.deepEqual(paths, ['/workspace/first', '/workspace/second']);
  assert.deepEqual(requests[1].query, { path: '/workspace', limit: '1', page: 'opaque/next==' });
});

test('SSE capture consumes split UTF-8 frames, heartbeats, and data events through the SDK', async () => {
  const event = { type: 'agent.session.idle', event_id: 'event_audit', session: { id: 'sess_你好', status: 'idle' } };
  const bytes = new TextEncoder().encode(`: ping\r\n\r\nevent: agent.session.idle\r\ndata: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const { client } = runner.createCaptureClient(() => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const received = [];
  for await (const value of await client.beta.agents.sessions.events.stream('sess_audit')) received.push(value);
  assert.deepEqual(received, [event]);
});

test('SSE errors are surfaced instead of a successful empty transcript', async () => {
  const { client } = runner.createCaptureClient(() => new Response('event: error\ndata: {"error":{"message":"audit failure","code":"server_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(async () => {
    for await (const event of await client.beta.agents.sessions.events.stream('sess_audit')) void event;
  }, /audit failure/);
});

test('checked-in baseline remains equal to the measured SDK surface', async () => {
  const baseline = JSON.parse(await readFile(new URL('../baseline.json', import.meta.url), 'utf8'));
  const captures = [];
  for (const scenario of scenarios) captures.push(await runner.captureScenario(scenario));
  assert.deepEqual(buildReport(captures), baseline);
});
