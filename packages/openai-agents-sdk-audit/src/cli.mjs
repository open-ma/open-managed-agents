import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { VERSION as actualVersion } from 'openai/version';
import { assertCoverage, buildReport, discoverMethods } from './audit.mjs';
import { captureScenario } from './runner.mjs';
import { scenarios } from './scenarios.mjs';

try {
  const args = process.argv.slice(2);
  const baselineIndex = args.indexOf('--baseline');
  const baselinePath = baselineIndex === -1 ? new URL('../baseline.json', import.meta.url) : args[baselineIndex + 1];
  if (!baselinePath) throw new Error('--baseline requires a path');
  const allowed = args.filter((value, index) => index !== baselineIndex && index !== baselineIndex + 1);
  // For the default path, no --baseline pair was removed.
  for (const arg of baselineIndex === -1 ? args : allowed) {
    if (!['--json', '--write-baseline'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  assert.equal(actualVersion, '7.15.0', 'Pinned SDK version drift: review the upstream API before updating');
  const client = new OpenAI({ apiKey: 'sdk-audit-key' });
  assertCoverage(discoverMethods(client.beta.agents), scenarios);
  const captures = [];
  for (const scenario of scenarios) captures.push(await captureScenario(scenario));
  const report = buildReport(captures);
  if (args.includes('--write-baseline')) {
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    assert.deepEqual(report, baseline, 'SDK baseline drift: inspect changes before explicitly refreshing');
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`openai@${actualVersion}: ${report.methodCount} SDK methods, ${report.scenarioCount} scenarios verified.`);
    console.log('OpenMA compatibility: unverified. This audit makes no runtime or live-server calls.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
