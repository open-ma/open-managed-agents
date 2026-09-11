import assert from 'node:assert/strict';

export function discoverMethods(resource, prefix = 'beta.agents', seen = new Set()) {
  if (seen.has(resource)) return [];
  seen.add(resource);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(resource))
    .filter(name => name !== 'constructor' && !name.startsWith('_') && typeof resource[name] === 'function')
    .map(name => `${prefix}.${name}`);
  for (const [name, child] of Object.entries(resource)) {
    if (!name.startsWith('_') && child && typeof child === 'object') {
      methods.push(...discoverMethods(child, `${prefix}.${name}`, seen));
    }
  }
  return methods.sort();
}

export function assertCoverage(methods, scenarios) {
  const upstream = new Set(methods);
  const covered = new Set(scenarios.map(scenario => scenario.method));
  const uncovered = [...upstream].filter(method => !covered.has(method)).sort();
  const stale = [...covered].filter(method => !upstream.has(method)).sort();
  if (uncovered.length || stale.length) {
    throw new Error(`SDK surface drift; uncovered: ${uncovered.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}`);
  }
}

export function assertRequest(actual, expected) {
  for (const key of ['httpMethod', 'path', 'query', 'body']) {
    assert.deepEqual(actual[key], expected[key], `SDK request ${key} drift`);
  }
  for (const [name, value] of Object.entries(expected.headers)) {
    assert.equal(actual.headers[name], value, `SDK request header ${name} drift`);
  }
}

export function buildReport(captures) {
  return {
    schemaVersion: 1,
    sdk: { name: 'openai', version: '7.15.0', namespace: 'beta.agents' },
    scope: 'SDK serialization and local response parsing; no OpenMA runtime calls',
    runtimeVerified: false,
    methodCount: new Set(captures.map(capture => capture.method)).size,
    scenarioCount: captures.length,
    operations: captures.map(capture => ({
      ...capture,
      requestContract: 'captured',
      openmaCompatibility: 'unverified',
      compatibilityEvidence: [],
    })),
  };
}
