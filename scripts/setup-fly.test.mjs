import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function runSetup(
  dataMode,
  sandboxProvider = "e2b",
  providerEnvironment = sandboxProvider === "e2b" ? { E2B_API_KEY: "e2b-test-key" } : {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "openma-fly-setup-"));
  const bin = join(scratch, "bin");
  const log = join(scratch, "fly.log");
  const secretInput = join(scratch, "secrets.env");
  await mkdir(bin);
  await writeFile(join(bin, "fly"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$OPENMA_FLY_TEST_LOG"
if [ "$1" = "status" ]; then exit 1; fi
if [ "$1" = "secrets" ] && [ "$2" = "import" ]; then cat > "$OPENMA_FLY_SECRET_INPUT"; fi
`, { mode: 0o755 });
  await writeFile(join(bin, "openssl"), `#!/bin/sh
printf 'generated-test-secret\\n'
`, { mode: 0o755 });

  try {
    const result = await execFileAsync("bash", ["scripts/setup-fly.sh"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENMA_FLY_DATA_MODE: dataMode,
        ...(sandboxProvider === null
          ? { OPENMA_FLY_SANDBOX_PROVIDER: "" }
          : { OPENMA_FLY_SANDBOX_PROVIDER: sandboxProvider }),
        ...providerEnvironment,
        OPENMA_FLY_TEST_LOG: log,
        OPENMA_FLY_SECRET_INPUT: secretInput,
      },
    });
    return {
      stdout: result.stdout,
      calls: (await readFile(log, "utf8")).trim().split("\n"),
      secrets: await readFile(secretInput, "utf8"),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("Fly setup launches the checked-in config, imports locally generated secrets, deploys, and verifies", async () => {
  const result = await runSetup("sqlite");
  const releaseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  })).stdout.trim();

  assert.deepEqual(result.calls, [
    "auth whoami",
    "status --json",
    "launch --copy-config --no-deploy --ha=false",
    "secrets import --stage",
    `deploy --image ghcr.io/openma-ai/open-managed-agents:sha-${releaseSha} --strategy rolling`,
    "checks list",
  ]);
  assert.match(result.secrets, /^BETTER_AUTH_SECRET=generated-test-secret$/m);
  assert.match(result.secrets, /^PLATFORM_ROOT_SECRET=generated-test-secret$/m);
  assert.match(result.secrets, /^SANDBOX_PROVIDER=e2b$/m);
  assert.match(result.secrets, /^E2B_API_KEY=e2b-test-key$/m);
  assert.doesNotMatch(result.stdout, /generated-test-secret/);
  assert.doesNotMatch(result.stdout, /e2b-test-key/);
});

test("Fly setup accepts an explicitly digest-pinned server release", async () => {
  const image = `ghcr.io/openma-ai/open-managed-agents@sha256:${"a".repeat(64)}`;
  const result = await runSetup("sqlite", "e2b", {
    E2B_API_KEY: "e2b-test-key",
    OPENMA_FLY_IMAGE: image,
  });

  assert.ok(result.calls.includes(`deploy --image ${image} --strategy rolling`));
});

test("Fly setup rejects a mutable server image tag before touching Fly", async () => {
  await assert.rejects(
    runSetup("sqlite", "e2b", {
      E2B_API_KEY: "e2b-test-key",
      OPENMA_FLY_IMAGE: "ghcr.io/openma-ai/open-managed-agents:latest",
    }),
    /immutable release image/i,
  );
});

test("server image workflow publishes a full-SHA checkpoint to GHCR", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/build-server-image.yml"),
    "utf8",
  );

  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /apps\/main-node\/Dockerfile/);
  assert.match(workflow, /type=sha,format=long/);
  assert.match(workflow, /packages:\s*write/);
});

test("Fly setup delegates managed Postgres provisioning to Fly Launch", async () => {
  const result = await runSetup("postgres");

  assert.ok(result.calls.includes("launch --copy-config --no-deploy --ha=false --db mpg"));
});

test("Fly setup refuses to deploy without an isolated sandbox provider", async () => {
  await assert.rejects(runSetup("sqlite", null), /OPENMA_FLY_SANDBOX_PROVIDER.*required/i);
});

test("Fly setup refuses the non-isolated subprocess adapter", async () => {
  await assert.rejects(runSetup("sqlite", "subprocess"), /subprocess.*test-only/i);
});

test("Fly setup fails before deploy when the selected provider credential is missing", async () => {
  await assert.rejects(runSetup("sqlite", "e2b", {}), /E2B_API_KEY.*required/i);
});

test("Fly setup stages Daytona configuration without printing credentials", async () => {
  const result = await runSetup("sqlite", "daytona", {
    DAYTONA_API_KEY: "daytona-test-key",
    DAYTONA_API_URL: "https://daytona.example.test",
  });

  assert.match(result.secrets, /^SANDBOX_PROVIDER=daytona$/m);
  assert.match(result.secrets, /^DAYTONA_API_KEY=daytona-test-key$/m);
  assert.match(result.secrets, /^DAYTONA_API_URL=https:\/\/daytona\.example\.test$/m);
  assert.doesNotMatch(result.stdout, /daytona-test-key/);
});

test("Fly setup stages a remote BoxRun endpoint and optional token", async () => {
  const result = await runSetup("sqlite", "boxrun", {
    BOXRUN_URL: "https://boxrun.example.test/v1/default",
    BOXRUN_TOKEN: "boxrun-test-token",
  });

  assert.match(result.secrets, /^SANDBOX_PROVIDER=boxrun$/m);
  assert.match(result.secrets, /^BOXRUN_URL=https:\/\/boxrun\.example\.test\/v1\/default$/m);
  assert.match(result.secrets, /^BOXRUN_TOKEN=boxrun-test-token$/m);
  assert.doesNotMatch(result.stdout, /boxrun-test-token/);
});

test("Fly setup rejects provider names not supported by the Fly deployment adapter", async () => {
  await assert.rejects(runSetup("sqlite", "unknown", {}), /must be e2b, daytona, or boxrun/i);
});
