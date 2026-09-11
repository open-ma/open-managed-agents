// Hand-reviewed against openai@7.15.0 resources/beta/agents/**/*.ts.
// Expected paths are independent of the SDK implementation being exercised.
const sessionInput = { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }] };
const createSession = { agent_id: 'agent_audit', environment: { type: 'none' }, input: 'Hello' };
const page = { limit: 2, after: 'cursor_audit', order: 'asc' };
const pageQuery = { limit: '2', after: 'cursor_audit', order: 'asc' };
const auth = { type: 'mcp_oauth', access_token: 'synthetic-audit-secret', mcp_server_url: 'https://mcp.example.test' };
const credential = { name: 'Audit', auth };

function request(httpMethod, path, { body = null, query = {}, headers = {} } = {}) {
  return { httpMethod, path: `/v1${path}`, query, body, headers: {
    'openai-beta': 'agents=v1', authorization: 'Bearer sdk-audit-key',
    accept: 'application/json', ...headers,
  } };
}
function operation(method, args, httpMethod, path, options = {}) {
  const { mode = 'json', ...expected } = options;
  return { id: method, method: `beta.agents.${method}`, args, mode, expected: [request(httpMethod, path, expected)] };
}

export const scenarios = [
  operation('create', [{ model: 'audit-model', instructions: 'Audit', metadata: { source: 'audit' } }], 'POST', '/agents', { body: { model: 'audit-model', instructions: 'Audit', metadata: { source: 'audit' } } }),
  operation('retrieve', ['agent_audit'], 'GET', '/agents/agent_audit'),
  operation('update', ['agent_audit', { instructions: null, metadata: {} }], 'POST', '/agents/agent_audit', { body: { instructions: null, metadata: {} } }),
  operation('list', [page], 'GET', '/agents', { query: pageQuery, mode: 'page' }),
  operation('delete', ['agent_audit'], 'DELETE', '/agents/agent_audit'),
  operation('environments.retrieve', ['env_audit'], 'GET', '/agents/environments/env_audit'),
  operation('environments.files.create', ['env_audit', { type: 'inline', path: '/workspace/a.txt', data: 'SGVsbG8=' }], 'POST', '/agents/environments/env_audit/files', { body: { type: 'inline', path: '/workspace/a.txt', data: 'SGVsbG8=' } }),
  operation('environments.files.list', ['env_audit', { limit: 2, page: 'opaque_audit', path: '/workspace', order: 'asc' }], 'GET', '/agents/environments/env_audit/files', { query: { limit: '2', page: 'opaque_audit', path: '/workspace', order: 'asc' }, mode: 'page' }),
  operation('environments.templates.create', [{}], 'POST', '/agents/environments/templates', { body: {} }),
  operation('environments.templates.retrieve', ['et_audit'], 'GET', '/agents/environments/templates/et_audit'),
  operation('environments.templates.update', ['et_audit', {}], 'POST', '/agents/environments/templates/et_audit', { body: {} }),
  operation('environments.templates.list', [page], 'GET', '/agents/environments/templates', { query: pageQuery, mode: 'page' }),
  operation('environments.templates.delete', ['et_audit'], 'DELETE', '/agents/environments/templates/et_audit'),
  operation('vaults.create', [{ name: 'Audit', metadata: { source: 'audit' } }], 'POST', '/vaults', { body: { name: 'Audit', metadata: { source: 'audit' } } }),
  operation('vaults.retrieve', ['vault_audit'], 'GET', '/vaults/vault_audit'),
  operation('vaults.list', [{ ...page, status: ['active', 'archived'] }], 'GET', '/vaults', { query: { ...pageQuery, 'status[]': ['active', 'archived'] }, mode: 'page' }),
  operation('vaults.delete', ['vault_audit'], 'DELETE', '/vaults/vault_audit'),
  operation('vaults.credentials.create', ['vault_audit', credential], 'POST', '/vaults/vault_audit/credentials', { body: credential }),
  operation('vaults.credentials.retrieve', ['cred_audit', { vault_id: 'vault_audit' }], 'GET', '/vaults/vault_audit/credentials/cred_audit'),
  operation('vaults.credentials.update', ['cred_audit', { vault_id: 'vault_audit', auth: { type: 'mcp_oauth', access_token: 'synthetic-rotated-secret' } }], 'POST', '/vaults/vault_audit/credentials/cred_audit', { body: { auth: { type: 'mcp_oauth', access_token: 'synthetic-rotated-secret' } } }),
  operation('vaults.credentials.list', ['vault_audit', page], 'GET', '/vaults/vault_audit/credentials', { query: pageQuery, mode: 'page' }),
  operation('vaults.credentials.delete', ['cred_audit', { vault_id: 'vault_audit' }], 'DELETE', '/vaults/vault_audit/credentials/cred_audit'),
  operation('sessions.create', [createSession], 'POST', '/agents/sessions', { body: createSession }),
  { ...operation('sessions.create', [{ ...createSession, stream: true }], 'POST', '/agents/sessions', { body: { ...createSession, stream: true }, mode: 'stream' }), id: 'sessions.create.streaming' },
  operation('sessions.retrieve', ['sess_audit'], 'GET', '/agents/sessions/sess_audit'),
  operation('sessions.update', ['sess_audit', { metadata: null }], 'POST', '/agents/sessions/sess_audit', { body: { metadata: null } }),
  operation('sessions.list', [{ ...page, agent_id: 'agent_audit' }], 'GET', '/agents/sessions', { query: { ...pageQuery, agent_id: 'agent_audit' }, mode: 'page' }),
  operation('sessions.delete', ['sess_audit'], 'DELETE', '/agents/sessions/sess_audit'),
  operation('sessions.subagents.retrieve', ['sub_audit', { session_id: 'sess_audit' }], 'GET', '/agents/sessions/sess_audit/subagents/sub_audit'),
  operation('sessions.subagents.list', ['sess_audit', page], 'GET', '/agents/sessions/sess_audit/subagents', { query: pageQuery, mode: 'page' }),
  operation('sessions.subagents.items.list', ['sub_audit', { session_id: 'sess_audit', ...page }], 'GET', '/agents/sessions/sess_audit/subagents/sub_audit/items', { query: pageQuery, mode: 'page' }),
  operation('sessions.subagents.turns.retrieve', ['turn_audit', { session_id: 'sess_audit', subagent_id: 'sub_audit' }], 'GET', '/agents/sessions/sess_audit/subagents/sub_audit/turns/turn_audit'),
  operation('sessions.subagents.turns.list', ['sub_audit', { session_id: 'sess_audit', ...page }], 'GET', '/agents/sessions/sess_audit/subagents/sub_audit/turns', { query: pageQuery, mode: 'page' }),
  operation('sessions.subagents.turns.items.list', ['turn_audit', { session_id: 'sess_audit', subagent_id: 'sub_audit', ...page }], 'GET', '/agents/sessions/sess_audit/subagents/sub_audit/turns/turn_audit/items', { query: pageQuery, mode: 'page' }),
  operation('sessions.artifacts.retrieve', ['artifact_audit', { session_id: 'sess_audit' }], 'GET', '/agents/sessions/sess_audit/artifacts/artifact_audit'),
  operation('sessions.artifacts.list', ['sess_audit', page], 'GET', '/agents/sessions/sess_audit/artifacts', { query: pageQuery, mode: 'page' }),
  operation('sessions.artifacts.delete', ['artifact_audit', { session_id: 'sess_audit' }], 'DELETE', '/agents/sessions/sess_audit/artifacts/artifact_audit'),
  operation('sessions.artifacts.content', ['artifact_audit', { session_id: 'sess_audit' }], 'GET', '/agents/sessions/sess_audit/artifacts/artifact_audit/content', { headers: { accept: 'application/octet-stream' }, mode: 'binary' }),
  operation('sessions.items.list', ['sess_audit', page], 'GET', '/agents/sessions/sess_audit/items', { query: pageQuery, mode: 'page' }),
  operation('sessions.events.create', ['sess_audit', { events: [sessionInput], 'Idempotency-Key': 'audit-input-key' }], 'POST', '/agents/sessions/sess_audit/events', { body: { events: [sessionInput] }, headers: { accept: '*/*', 'idempotency-key': 'audit-input-key' }, mode: 'void' }),
  operation('sessions.events.stream', ['sess_audit'], 'GET', '/agents/sessions/sess_audit/events', { headers: { accept: 'text/event-stream' }, mode: 'stream' }),
  operation('sessions.turns.retrieve', ['turn_audit', { session_id: 'sess_audit' }], 'GET', '/agents/sessions/sess_audit/turns/turn_audit'),
  operation('sessions.turns.list', ['sess_audit', page], 'GET', '/agents/sessions/sess_audit/turns', { query: pageQuery, mode: 'page' }),
  {
    id: 'sessions.stream', method: 'beta.agents.sessions.stream', mode: 'helper',
    args: ['sess_audit', { input: 'Hello', idempotencyKey: 'audit-helper-input' }],
    expected: [
      request('GET', '/agents/sessions/sess_audit'),
      request('GET', '/agents/sessions/sess_audit/events', { headers: { accept: 'text/event-stream' } }),
      request('POST', '/agents/sessions/sess_audit/events', { body: { events: [sessionInput] }, headers: { accept: '*/*', 'idempotency-key': 'audit-helper-input' } }),
    ],
  },
];
