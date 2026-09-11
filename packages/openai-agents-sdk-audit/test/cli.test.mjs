import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
test('CLI verifies the baseline and reports request coverage without claiming compatibility', () => {
  const output = execFileSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.match(output, /43 SDK methods, 44 scenarios/);
  assert.match(output, /OpenMA compatibility: unverified/);
});

test('CLI exits nonzero when the checked baseline hides an operation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openai-sdk-audit-'));
  try {
    const baseline = JSON.parse(readFileSync(new URL('../baseline.json', import.meta.url), 'utf8'));
    baseline.operations.pop();
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify(baseline));
    const result = spawnSync(process.execPath, [cli, '--baseline', path], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /baseline drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
