import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "jsonc-parser";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function copyFixture(targetRoot, relativePath) {
  const target = join(targetRoot, relativePath);
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(join(repositoryRoot, relativePath), target);
}

async function readJsonc(targetRoot, relativePath) {
  return parse(await readFile(join(targetRoot, relativePath), "utf8"));
}

test("Cloudflare setup provisions a fresh three-Worker deployment without guessing its workers.dev subdomain", async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), "openma-setup-cf-"));
  for (const relativePath of [
    "scripts/setup-cf.sh",
    "apps/main/wrangler.jsonc",
    "apps/agent/wrangler.jsonc",
    "apps/integrations/wrangler.jsonc",
  ]) {
    await copyFixture(targetRoot, relativePath);
  }
  await symlink(join(repositoryRoot, "node_modules"), join(targetRoot, "node_modules"), "dir");

  const fakeBin = join(targetRoot, "fake-bin");
  const invocationLog = join(targetRoot, "invocations.log");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$OPENMA_SETUP_TEST_LOG"
`,
  );
  await writeFile(
    join(fakeBin, "npx"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\\n' "$*" >> "$OPENMA_SETUP_TEST_LOG"
case "$*" in
  "wrangler whoami")
    printf '%s\\n' 'You are logged in.' 'Account ID: 11111111111111111111111111111111'
    ;;
  "wrangler d1 create openma-auth")
    printf '%s\\n' 'database_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"'
    ;;
  "wrangler d1 create openma-integrations")
    printf '%s\\n' 'database_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"'
    ;;
  "wrangler kv namespace create CONFIG_KV")
    printf '%s\\n' '{"id": "cccccccccccccccccccccccccccccccc"}'
    ;;
  wrangler\\ r2\\ bucket\\ create*) ;;
  wrangler\\ d1\\ migrations\\ apply*) printf '%s\\n' 'No migrations to apply.' ;;
  wrangler\\ deployments\\ status*) exit 1 ;;
  wrangler\\ secret\\ list*) printf '%s\\n' '[]' ;;
  wrangler\\ secret\\ put*) cat >/dev/null ;;
  "wrangler deploy --config apps/integrations/wrangler.jsonc")
    printf '%s\\n' 'Uploaded managed-agents-integrations' 'https://managed-agents-integrations.real-subdomain.workers.dev'
    ;;
  wrangler\\ deploy\\ --config\\ apps/integrations/.wrangler.setup.*)
    printf '%s\\n' 'Uploaded bootstrap integrations' 'https://managed-agents-integrations.real-subdomain.workers.dev'
    ;;
  "wrangler deploy --config apps/main/wrangler.jsonc")
    printf '%s\\n' 'Uploaded managed-agents' 'https://managed-agents.real-subdomain.workers.dev'
    ;;
  wrangler\\ deploy\\ --config\\ apps/main/.wrangler.setup.*)
    printf '%s\\n' 'Uploaded bootstrap main' 'https://managed-agents.real-subdomain.workers.dev'
    ;;
  "wrangler deploy --config apps/agent/wrangler.jsonc")
    printf '%s\\n' 'Uploaded sandbox-default' 'https://sandbox-default.real-subdomain.workers.dev'
    ;;
  wrangler\\ r2\\ bucket\\ notification\\ create*) printf '%s\\n' 'Created event notification rule' ;;
  *)
    printf 'unexpected npx invocation: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
  );
  await Promise.all([
    chmod(join(fakeBin, "pnpm"), 0o755),
    chmod(join(fakeBin, "npx"), 0o755),
    chmod(join(targetRoot, "scripts/setup-cf.sh"), 0o755),
  ]);

  const result = spawnSync("bash", ["scripts/setup-cf.sh", "--yes"], {
    cwd: targetRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      OPENMA_SETUP_TEST_LOG: invocationLog,
      ANTHROPIC_API_KEY: "test-model-key",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const main = await readJsonc(targetRoot, "apps/main/wrangler.jsonc");
  const agent = await readJsonc(targetRoot, "apps/agent/wrangler.jsonc");
  const integrations = await readJsonc(targetRoot, "apps/integrations/wrangler.jsonc");
  assert.equal(main.d1_databases.find(({ binding }) => binding === "MAIN_DB").database_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(agent.d1_databases.find(({ binding }) => binding === "MAIN_DB").database_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(integrations.d1_databases.find(({ binding }) => binding === "MAIN_DB").database_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(main.vars.INTEGRATIONS_ORIGIN, "https://managed-agents-integrations.real-subdomain.workers.dev");
  assert.equal(integrations.vars.GATEWAY_ORIGIN, "https://managed-agents-integrations.real-subdomain.workers.dev");

  const calls = await readFile(invocationLog, "utf8");
  assert.match(calls, /pnpm build:console/);
  assert.match(calls, /wrangler deploy --config apps\/integrations\/\.wrangler\.setup\./);
  assert.match(calls, /wrangler deploy --config apps\/main\/\.wrangler\.setup\./);
  assert.match(calls, /wrangler deploy --config apps\/agent\/wrangler\.jsonc/);
  assert.match(calls, /wrangler secret put PLATFORM_ROOT_SECRET --config apps\/main\/wrangler\.jsonc/);
  assert.match(calls, /wrangler r2 bucket notification create managed-agents-memory --event-type object-create object-delete --queue managed-agents-memory-events/);
});
