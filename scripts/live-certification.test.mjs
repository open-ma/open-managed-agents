import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  certificationExitCode,
  defaultLiveCertificationLanes,
  probeCredential,
  renderCertificationSummary,
  runLiveCertification,
  writeCertificationReport,
} from "./live-certification.mjs";

const fixtureRoots = new Set();
const repoRoot = new URL("..", import.meta.url).pathname;
const cliPath = new URL("./live-certification.mjs", import.meta.url).pathname;

test.afterEach(async () => {
  await Promise.all(
    [...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  fixtureRoots.clear();
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "oma-live-certification-"));
  fixtureRoots.add(root);
  return root;
}

async function fixtureCommand(root, name, source) {
  const path = join(root, `${name}.mjs`);
  await writeFile(path, source);
  return [process.execPath, path];
}

test("matrix reports missing credentials without starting that provider", async () => {
  const root = await fixtureRoot();
  const marker = join(root, "must-not-run");
  const command = await fixtureCommand(
    root,
    "must-not-run",
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );

  const report = await runLiveCertification({
    lanes: [{
      provider: "acme",
      credentialRequirements: [{ anyOf: ["ACME_API_KEY", "OMA_ACME_API_KEY"] }],
      command,
    }],
    env: {},
    cwd: root,
    commit: { sha: "abc123", dirty: false },
  });

  assert.equal(existsSync(marker), false);
  assert.deepEqual(report.summary, {
    total: 1,
    pass: 0,
    fail: 0,
    not_run_no_credential: 1,
  });
  assert.deepEqual(report.results[0], {
    provider: "acme",
    status: "NOT_RUN_NO_CREDENTIAL",
    missing_credentials: [["ACME_API_KEY", "OMA_ACME_API_KEY"]],
    duration_ms: 0,
  });
  assert.equal(certificationExitCode(report), 2);
  assert.match(renderCertificationSummary(report), /\[NOT_RUN_NO_CREDENTIAL\] acme/);
});

test("credential probe can authorize a lane when environment credentials are absent", async () => {
  const root = await fixtureRoot();
  const command = await fixtureCommand(root, "oauth-authorized", 'console.log("certified with oauth");');
  const probes = [];

  const report = await runLiveCertification({
    lanes: [{
      provider: "cloud-provider",
      credentialRequirements: [{ anyOf: ["CLOUD_API_TOKEN"] }],
      credentialProbe: {
        label: "cli_oauth_profile",
        command: ["cloud-cli", "whoami"],
      },
      command,
    }],
    env: { PATH: process.env.PATH },
    cwd: root,
    commit: { sha: "oauth123", dirty: false },
    probe: async (credentialProbe) => {
      probes.push(credentialProbe);
      return true;
    },
  });

  assert.deepEqual(probes, [{
    label: "cli_oauth_profile",
    command: ["cloud-cli", "whoami"],
  }]);
  assert.equal(report.results[0].status, "PASS");
  assert.equal(report.results[0].credential_source, "cli_oauth_profile");
  assert.match(report.results[0].stdout, /certified with oauth/);
});

test("a failed credential probe remains NOT_RUN and never starts the lane", async () => {
  const root = await fixtureRoot();
  let executions = 0;

  const report = await runLiveCertification({
    lanes: [{
      provider: "cloud-provider",
      credentialRequirements: [{ anyOf: ["CLOUD_API_TOKEN"] }],
      credentialProbe: {
        label: "cli_oauth_profile",
        command: ["cloud-cli", "whoami"],
      },
      command: ["must-not-run"],
    }],
    env: {},
    cwd: root,
    commit: { sha: "oauth456", dirty: false },
    probe: async () => false,
    execute: async () => {
      executions += 1;
      return { exitCode: 0 };
    },
  });

  assert.equal(executions, 0);
  assert.deepEqual(report.results[0], {
    provider: "cloud-provider",
    status: "NOT_RUN_NO_CREDENTIAL",
    missing_credentials: [["CLOUD_API_TOKEN"]],
    credential_probe: "cli_oauth_profile",
    duration_ms: 0,
  });
});

test("credential probes satisfy only their declared requirement groups", async () => {
  let executions = 0;
  const report = await runLiveCertification({
    lanes: [{
      provider: "cloud-r2",
      credentialRequirements: [
        { anyOf: ["CLOUD_API_TOKEN"] },
        { anyOf: ["R2_ACCESS_KEY_ID"] },
      ],
      credentialProbe: {
        label: "cloud_cli_oauth",
        command: ["cloud-cli", "whoami"],
        satisfies: ["CLOUD_API_TOKEN"],
      },
      command: ["must-not-run"],
    }],
    env: {},
    cwd: process.cwd(),
    commit: { sha: "scoped-probe", dirty: false },
    probe: async () => true,
    execute: async () => {
      executions += 1;
      return { exitCode: 0 };
    },
  });

  assert.equal(executions, 0);
  assert.deepEqual(report.results[0], {
    provider: "cloud-r2",
    status: "NOT_RUN_NO_CREDENTIAL",
    missing_credentials: [["R2_ACCESS_KEY_ID"]],
    credential_probe: "cloud_cli_oauth",
    duration_ms: 0,
  });
});

test("credential command probe fails closed without exposing its output", async () => {
  const root = await fixtureRoot();
  assert.equal(await probeCredential({
    label: "success",
    command: [process.execPath, "-e", "process.exit(0)"],
  }, { cwd: root, env: process.env }), true);
  assert.equal(await probeCredential({
    label: "failure",
    command: [process.execPath, "-e", "console.error('sensitive profile'); process.exit(3)"],
    timeoutMs: 10_000,
  }, { cwd: root, env: process.env }), false);
});

test("matrix runs real commands and redacts credentials from failed diagnostics", async () => {
  const root = await fixtureRoot();
  const passCommand = await fixtureCommand(root, "pass", 'console.log("certified");');
  const failCommand = await fixtureCommand(
    root,
    "fail",
    'console.log(`api_key=${process.env.UNUSED_API_KEY}`); console.error(`token=${process.env.SECRET_TOKEN} Authorization: Bearer provider-bearer env.CERTIFICATION_NONCE ("truncated-nonce-value...")`); process.exit(7);',
  );
  const secret = "provider-secret-value";

  const report = await runLiveCertification({
    lanes: [
      { provider: "pass-provider", credentialRequirements: [], command: passCommand },
      {
        provider: "fail-provider",
        credentialRequirements: [{ anyOf: ["SECRET_TOKEN"] }],
        command: failCommand,
      },
    ],
    env: { SECRET_TOKEN: secret },
    cwd: root,
    commit: { sha: "def456", dirty: true },
  });

  assert.equal(report.results[0].status, "PASS");
  assert.equal(report.results[0].exit_code, 0);
  assert.match(report.results[0].stdout, /certified/);
  assert.equal(report.results[1].status, "FAIL");
  assert.equal(report.results[1].exit_code, 7);
  assert.match(report.results[1].stdout, /api_key=<redacted>/);
  assert.match(report.results[1].stderr, /token=<redacted>/);
  assert.match(report.results[1].stderr, /Authorization: Bearer <redacted>/);
  assert.match(report.results[1].stderr, /env\.CERTIFICATION_NONCE \("<redacted>"\)/);
  assert.equal(report.results[1].stderr.includes("truncated-nonce-value"), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(certificationExitCode(report), 1);
  assert.match(renderCertificationSummary(report), /\[PASS\] pass-provider/);
  assert.match(renderCertificationSummary(report), /\[FAIL\] fail-provider/);
});

test("matrix records Git identity, safe runtime metadata, and spawn failures", async () => {
  const root = await fixtureRoot();
  const passCommand = await fixtureCommand(root, "metadata-pass", "process.exit(0);");
  assert.equal(spawnSync("git", ["init"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.email", "certification@example.invalid"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Certification Test"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "metadata-pass.mjs"], { cwd: root }).status, 0);
  assert.equal(
    spawnSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], {
      cwd: root,
    }).status,
    0,
  );
  await writeFile(join(root, "dirty-marker"), "dirty\n");
  const report = await runLiveCertification({
    lanes: [
      {
        provider: "metadata-provider",
        command: passCommand,
        credentialRequirements: [{ anyOf: ["EMPTY_TOKEN", "ACTIVE_TOKEN"] }],
        timeoutMs: 10_000,
        sdk_version: "1.2.3",
        image: "node:24",
        region: "test-region-1",
      },
      {
        provider: "missing-command",
        credentialRequirements: [],
        command: [join(root, "does-not-exist")],
      },
    ],
    env: {
      PATH: process.env.PATH,
      EMPTY_TOKEN: " ",
      ACTIVE_TOKEN: "active-token-value",
      UNUSED_API_KEY: "short-secret",
    },
    cwd: root,
  });

  assert.match(report.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(report.commit.dirty, true);
  assert.deepEqual(report.results[0].metadata, {
    sdk_version: "1.2.3",
    image: "node:24",
    region: "test-region-1",
  });
  assert.equal(report.results[1].status, "FAIL");
  assert.equal(report.results[1].exit_code, 1);
  assert.match(report.results[1].stderr, /does-not-exist/);
});

test("matrix records clean repositories and degrades safely outside Git", async () => {
  const cleanRoot = await fixtureRoot();
  const passCommand = await fixtureCommand(cleanRoot, "git-pass", "process.exit(0);");
  assert.equal(spawnSync("git", ["init"], { cwd: cleanRoot }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.email", "certification@example.invalid"], { cwd: cleanRoot }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Certification Test"], { cwd: cleanRoot }).status, 0);
  assert.equal(spawnSync("git", ["add", "git-pass.mjs"], { cwd: cleanRoot }).status, 0);
  assert.equal(
    spawnSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], {
      cwd: cleanRoot,
    }).status,
    0,
  );

  const cleanReport = await runLiveCertification({
    lanes: [{ provider: "clean-git", command: passCommand }],
    env: { PATH: process.env.PATH },
    cwd: cleanRoot,
  });
  assert.match(cleanReport.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(cleanReport.commit.dirty, false);

  const nonGitRoot = await fixtureRoot();
  const nonGitCommand = await fixtureCommand(nonGitRoot, "non-git-pass", "process.exit(0);");
  const nonGitReport = await runLiveCertification({
    lanes: [{ provider: "non-git", command: nonGitCommand }],
    env: { PATH: process.env.PATH },
    cwd: nonGitRoot,
  });
  assert.deepEqual(nonGitReport.commit, { sha: "unknown", dirty: true });
});

test("report writer creates a stable JSON artifact without credential values", async () => {
  const root = await fixtureRoot();
  const reportPath = join(root, "live.json");
  const secret = "never-persist-this-token";
  const command = await fixtureCommand(
    root,
    "echo-secret",
    'process.stdout.write(process.env.API_KEY);',
  );
  const report = await runLiveCertification({
    lanes: [{
      provider: "safe-report",
      credentialRequirements: [{ anyOf: ["API_KEY"] }],
      command,
    }],
    env: { API_KEY: secret },
    cwd: root,
    commit: { sha: "feedface", dirty: false },
  });

  await writeFile(reportPath, "stale report\n");
  await chmod(reportPath, 0o644);
  await writeCertificationReport(report, reportPath);
  const persisted = await readFile(reportPath, "utf8");
  assert.equal(persisted.includes(secret), false);
  assert.deepEqual(JSON.parse(persisted), report);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test("default matrix names every supported provider and system certification lane", () => {
  assert.deepEqual(
    defaultLiveCertificationLanes().map(({ provider }) => provider),
    [
      "blaxel",
      "boxlite",
      "boxrun",
      "cloudflare",
      "cloudflare-r2",
      "cloudflare-bridge",
      "daytona",
      "e2b",
      "modal",
      "sprites",
      "superserve",
      "vercel",
      "local-release",
      "deepseek-model",
    ],
  );
});

test("exit policy distinguishes pass, failed, strict missing, and inventory missing", () => {
  assert.equal(certificationExitCode({ summary: { fail: 0, not_run_no_credential: 0 } }), 0);
  assert.equal(certificationExitCode({ summary: { fail: 1, not_run_no_credential: 0 } }), 1);
  assert.equal(certificationExitCode({ summary: { fail: 0, not_run_no_credential: 1 } }), 2);
  assert.equal(
    certificationExitCode(
      { summary: { fail: 0, not_run_no_credential: 1 } },
      { allowMissing: true },
    ),
    0,
  );
});

test("CLI is strict by default and still writes a report when credentials are missing", async () => {
  const root = await fixtureRoot();
  const manifestPath = join(root, "manifest.json");
  const reportPath = join(root, "live.json");
  await writeFile(manifestPath, JSON.stringify({
    lanes: [{
      provider: "acme",
      credentialRequirements: [{ anyOf: ["ACME_API_KEY"] }],
      command: [process.execPath, "unused.mjs"],
    }],
  }));

  const result = spawnSync(process.execPath, [
    cliPath,
    "--",
    "--manifest",
    manifestPath,
    "--report",
    reportPath,
  ], {
    cwd: root,
    env: {},
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /\[NOT_RUN_NO_CREDENTIAL\] acme/);
  assert.match(result.stdout, /report: .*live\.json/);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.results[0].status, "NOT_RUN_NO_CREDENTIAL");
});

test("CLI loads reusable local credentials from one env file without persisting them", async () => {
  const root = await fixtureRoot();
  const envPath = join(root, ".env.certification.local");
  const manifestPath = join(root, "manifest.json");
  const reportPath = join(root, "live.json");
  const secret = "reusable-local-provider-secret";
  const command = await fixtureCommand(
    root,
    "require-key",
    'if (process.env.ACME_API_KEY !== "reusable-local-provider-secret") process.exit(9);',
  );
  await writeFile(envPath, `ACME_API_KEY=${secret}\n`);
  await writeFile(manifestPath, JSON.stringify({
    lanes: [{
      provider: "acme",
      credentialRequirements: [{ anyOf: ["ACME_API_KEY"] }],
      command,
    }],
  }));

  const result = spawnSync(process.execPath, [
    cliPath,
    "--credentials-file",
    envPath,
    "--manifest",
    manifestPath,
    "--report",
    reportPath,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[PASS\] acme/);
  assert.equal((await readFile(reportPath, "utf8")).includes(secret), false);
});

test("CLI selects default providers and rejects malformed invocations", async () => {
  const root = await fixtureRoot();
  const reportPath = join(root, "selected.json");
  const selected = spawnSync(process.execPath, [
    cliPath,
    "--allow-missing",
    "--providers",
    ",e2b,",
    "--report",
    reportPath,
  ], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /\[NOT_RUN_NO_CREDENTIAL\] e2b/);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).results.length, 1);

  const unknownProvider = spawnSync(process.execPath, [
    cliPath,
    "--providers",
    "unknown-provider",
  ], { cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(unknownProvider.status, 1);
  assert.match(unknownProvider.stderr, /unknown certification providers: unknown-provider/);

  const unknownOption = spawnSync(process.execPath, [cliPath, "--wat"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /unknown live certification option: --wat/);

  const missingEnvFile = spawnSync(process.execPath, [
    cliPath,
    "--credentials-file",
    join(root, "missing.env"),
  ], { cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(missingEnvFile.status, 1);
  assert.match(missingEnvFile.stderr, /ENOENT/);

  const missingValue = spawnSync(process.execPath, [cliPath, "--report"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--report requires a value/);

  const optionAsValue = spawnSync(process.execPath, [cliPath, "--report", "--wat"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(optionAsValue.status, 1);
  assert.match(optionAsValue.stderr, /--report requires a value/);

  const invalidManifestPath = join(root, "invalid.json");
  await writeFile(invalidManifestPath, JSON.stringify({ lanes: {} }));
  const invalidManifest = spawnSync(process.execPath, [
    cliPath,
    "--manifest",
    invalidManifestPath,
  ], { cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(invalidManifest.status, 1);
  assert.match(invalidManifest.stderr, /manifest requires a lanes array/);

  const emptyManifestPath = join(root, "empty.json");
  await writeFile(emptyManifestPath, JSON.stringify({ lanes: [] }));
  const emptyManifest = spawnSync(process.execPath, [
    cliPath,
    "--manifest",
    emptyManifestPath,
  ], { cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(emptyManifest.status, 1);
  assert.match(emptyManifest.stderr, /selected no providers/);
});
