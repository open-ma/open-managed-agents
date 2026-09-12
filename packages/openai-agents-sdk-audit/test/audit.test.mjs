import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as audit from '../src/audit.mjs';

// These tests catch omitted SDK resources, unnoticed drift, and false claims
// that request capture demonstrates OpenMA's server-side implementation.
test('discovery walks nested SDK resources and excludes SDK internals', () => {
  class Child { list() {} }
  class Resource { constructor() { this.child = new Child(); this._client = this; } create() {} }
  assert.deepEqual(audit.discoverMethods(new Resource()), ['beta.agents.child.list', 'beta.agents.create']);
});

test('coverage rejects both new upstream methods and stale baseline methods', () => {
  assert.throws(() => audit.assertCoverage(['beta.agents.create', 'beta.agents.newMethod'], [
    { method: 'beta.agents.create' }, { method: 'beta.agents.removed' },
  ]), /uncovered: beta.agents.newMethod; stale: beta.agents.removed/);
});

test('coverage accepts separate streaming scenarios for the same SDK method', () => {
  assert.doesNotThrow(() => audit.assertCoverage(['beta.agents.sessions.create'], [
    { method: 'beta.agents.sessions.create' }, { method: 'beta.agents.sessions.create' },
  ]));
});

test('wire assertions reject a changed URL, body, or beta header', () => {
  const expected = { httpMethod: 'POST', path: '/v1/agents', query: {}, body: { model: 'audit-model' }, headers: { 'openai-beta': 'agents=v1' } };
  assert.doesNotThrow(() => audit.assertRequest(expected, expected));
  assert.throws(() => audit.assertRequest({ ...expected, path: '/v1/wrong' }, expected));
  assert.throws(() => audit.assertRequest({ ...expected, body: { model: 'wrong' } }, expected));
  assert.throws(() => audit.assertRequest({ ...expected, headers: {} }, expected));
});

test('report distinguishes captured requests from unverified implementation', () => {
  const report = audit.buildReport([{ id: 'agents.create', method: 'beta.agents.create', requests: [] }]);
  assert.equal(report.sdk.version, '7.15.0');
  assert.equal(report.operations[0].requestContract, 'captured');
  assert.equal(report.operations[0].openmaCompatibility, 'unverified');
  assert.equal(report.runtimeVerified, false);
});
