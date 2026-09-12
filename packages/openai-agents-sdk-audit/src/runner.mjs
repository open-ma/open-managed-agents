import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { assertRequest } from './audit.mjs';

const session = {
  id: 'sess_audit', object: 'agent.session', created_at: 1, last_active_at: 1,
  agent: {
    id: 'agent_audit', model: 'audit-model', name: null, instructions: null,
    multi_agent: { enabled: false, max_concurrent_subagents: null },
    reasoning: { effort: null, summary: null }, service_tier: 'auto',
    text: { format: { type: 'text' }, verbosity: 'medium' }, tools: [],
  },
  environment: { type: 'none' }, error: null, metadata: {}, required_actions: [],
  status: 'idle', usage: null, vault_ids: [],
};
const idleEvent = { type: 'agent.session.idle', event_id: 'event_audit', session };

/** Always replaces network I/O. No API keys or external servers are read. */
export function createCaptureClient(respond) {
  const requests = [];
  const client = new OpenAI({
    apiKey: 'sdk-audit-key', baseURL: 'https://sdk-audit.test/v1', maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://sdk-audit.test', 'Audit transport must remain local');
      const content = await request.text();
      const headers = {};
      // Keep only protocol headers: SDK runtime/OS telemetry changes across hosts.
      for (const name of ['openai-beta', 'authorization', 'accept', 'content-type', 'idempotency-key']) {
        const value = request.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const query = {};
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length === 1 ? values[0] : values;
      }
      const captured = {
        httpMethod: request.method, path: url.pathname,
        query,
        body: content ? JSON.parse(content) : null, headers,
      };
      requests.push(captured);
      return respond(captured, requests.length - 1);
    },
  });
  return { client, requests };
}

function fixtureResponse(scenario, request) {
  if (request.headers.accept === 'text/event-stream' || scenario.mode === 'stream') {
    return new Response(`event: ${idleEvent.type}\ndata: ${JSON.stringify(idleEvent)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  if (scenario.mode === 'void' || (scenario.mode === 'helper' && request.httpMethod === 'POST')) {
    return new Response(null, { status: 204 });
  }
  if (scenario.mode === 'binary') {
    return new Response(new Uint8Array([0, 255, 1, 128]), { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (scenario.mode === 'page') {
    return Response.json({ object: 'list', data: [], has_more: false, first_id: null, last_id: null, next: null });
  }
  // Only the stream helper consumes a resource field (status). The generic
  // JSON response intentionally makes no claim of response schema conformance.
  return Response.json(scenario.mode === 'helper' ? session : {});
}

export async function captureScenario(scenario) {
  const { client, requests } = createCaptureClient(request => fixtureResponse(scenario, request));
  const parts = scenario.method.split('.');
  const methodName = parts.pop();
  const resource = parts.reduce((value, part) => value[part], client);
  const result = await resource[methodName](...structuredClone(scenario.args));
  if (scenario.mode === 'stream' || scenario.mode === 'helper') {
    let received = 0;
    for await (const event of result) {
      assert.deepEqual(event, idleEvent);
      received += 1;
      if (scenario.mode === 'helper') break; // Closing local iteration never cancels the backend turn.
    }
    assert.equal(received, 1, 'SSE fixture was not parsed');
  } else if (scenario.mode === 'binary') {
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([0, 255, 1, 128]));
  } else if (scenario.mode === 'void') {
    assert.equal(result, null);
  }
  assert.equal(requests.length, scenario.expected.length, `${scenario.id}: request count drift`);
  requests.forEach((request, index) => assertRequest(request, scenario.expected[index]));
  return { id: scenario.id, method: scenario.method, mode: scenario.mode, requests };
}
