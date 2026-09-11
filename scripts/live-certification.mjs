#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const SECRET_NAME = /(api[_-]?key|token|secret|password|credential|nonce)/i;

const PROVIDER_LANES = [
  {
    provider: "blaxel",
    credentialRequirements: [{ anyOf: ["BL_API_KEY"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-blaxel", "test:certification"],
  },
  {
    provider: "boxlite",
    credentialRequirements: [],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-boxlite", "test:certification"],
  },
  {
    provider: "boxrun",
    credentialRequirements: [{ anyOf: ["BOXRUN_URL"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/sandbox-adapter-boxrun", "test:certification"],
  },
  {
    provider: "cloudflare",
    credentialRequirements: [
      { anyOf: ["CLOUDFLARE_API_TOKEN"] },
      { anyOf: ["CLOUDFLARE_ACCOUNT_ID"] },
    ],
    credentialProbe: {
      label: "wrangler_oauth_profile",
      command: ["pnpm", "exec", "wrangler", "whoami"],
    },
    timeoutMs: 30 * 60_000,
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-cloudflare", "test:certification"],
  },
  {
    provider: "cloudflare-r2",
    credentialRequirements: [
      { anyOf: ["CLOUDFLARE_API_TOKEN"] },
      { anyOf: ["CLOUDFLARE_ACCOUNT_ID"] },
      { anyOf: ["R2_ACCESS_KEY_ID"] },
      { anyOf: ["R2_SECRET_ACCESS_KEY"] },
    ],
    credentialProbe: {
      label: "wrangler_oauth_profile_with_r2_keys",
      command: ["pnpm", "exec", "wrangler", "whoami"],
      satisfies: ["CLOUDFLARE_API_TOKEN"],
    },
    timeoutMs: 30 * 60_000,
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-cloudflare", "test:certification:r2"],
  },
  {
    provider: "cloudflare-bridge",
    credentialRequirements: [
      { anyOf: ["OMA_CLOUDFLARE_BRIDGE_URL"] },
      { anyOf: ["OMA_CLOUDFLARE_BRIDGE_API_KEY"] },
      { anyOf: ["OMA_CLOUDFLARE_BRIDGE_RUNTIME_ID"] },
    ],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-cloudflare-bridge", "test:certification"],
  },
  {
    provider: "daytona",
    credentialRequirements: [{ anyOf: ["DAYTONA_API_KEY"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-daytona", "test:certification"],
  },
  {
    provider: "e2b",
    credentialRequirements: [{ anyOf: ["OMA_E2B_E2E_API_KEY", "E2B_API_KEY"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/sandbox-adapter-e2b", "test:certification"],
  },
  {
    provider: "modal",
    credentialRequirements: [
      { anyOf: ["MODAL_TOKEN_ID"] },
      { anyOf: ["MODAL_TOKEN_SECRET"] },
    ],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-modal", "test:certification"],
  },
  {
    provider: "sprites",
    credentialRequirements: [{ anyOf: ["SPRITES_TOKEN"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-sprites", "test:certification"],
  },
  {
    provider: "superserve",
    credentialRequirements: [{ anyOf: ["SUPERSERVE_API_KEY"] }],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-superserve", "test:certification"],
  },
  {
    provider: "vercel",
    credentialRequirements: [
      { anyOf: ["VERCEL_TOKEN"] },
      { anyOf: ["VERCEL_TEAM_ID"] },
      { anyOf: ["VERCEL_PROJECT_ID"] },
    ],
    command: ["pnpm", "--filter", "@open-managed-agents/managed-runtime-vercel", "test:certification"],
  },
  {
    provider: "local-release",
    credentialRequirements: [],
    timeoutMs: 15 * 60_000,
    command: ["node", "scripts/local-release-certification.mjs"],
  },
  {
    provider: "deepseek-model",
    credentialRequirements: [{ anyOf: ["DEEPSEEK_API_KEY"] }],
    credentialProbe: {
      label: "dsh_credentials_file",
      command: ["node", "scripts/deepseek-live-certification.mjs", "--check-credential"],
    },
    timeoutMs: 20 * 60_000,
    command: ["node", "scripts/deepseek-live-certification.mjs"],
  },
];

export function defaultLiveCertificationLanes() {
  return structuredClone(PROVIDER_LANES);
}

export async function runCertification({
  lanes,
  env = process.env,
  cwd = process.cwd(),
  commit,
  kind = "openma.live_certification",
  execute = executeLane,
  probe = probeCredential,
}) {
  const startedAt = new Date().toISOString();
  const resolvedCommit = commit ?? await inspectCommit(cwd);
  const results = [];

  for (const lane of lanes) {
    let missing = missingCredentialRequirements(lane, env);
    const probeAuthorized = missing.length > 0 && lane.credentialProbe !== undefined
      ? await probe(lane.credentialProbe, { cwd, env })
      : false;
    if (probeAuthorized) {
      const satisfies = lane.credentialProbe.satisfies;
      missing = satisfies === undefined
        ? []
        : missing.filter((group) => !group.some((name) => satisfies.includes(name)));
    }
    if (missing.length > 0) {
      results.push({
        provider: lane.provider,
        status: "NOT_RUN_NO_CREDENTIAL",
        missing_credentials: missing,
        ...(lane.credentialProbe === undefined
          ? {}
          : { credential_probe: lane.credentialProbe.label }),
        duration_ms: 0,
      });
      continue;
    }

    const started = performance.now();
    try {
      const { exitCode = 0, stdout = "", stderr = "" } = await execute(lane, { cwd, env });
      if (exitCode !== 0) {
        throw Object.assign(new Error(`certification command exited ${exitCode}`), {
          code: exitCode,
          stdout,
          stderr,
        });
      }
      results.push({
        provider: lane.provider,
        status: "PASS",
        duration_ms: elapsedMilliseconds(started),
        exit_code: 0,
        stdout: redactDiagnostic(stdout, env, lane),
        stderr: redactDiagnostic(stderr, env, lane),
        ...(probeAuthorized
          ? { credential_source: lane.credentialProbe.label }
          : {}),
        ...safeLaneMetadata(lane),
      });
    } catch (error) {
      results.push({
        provider: lane.provider,
        status: "FAIL",
        duration_ms: elapsedMilliseconds(started),
        exit_code: numericExitCode(error),
        stdout: redactDiagnostic(error?.stdout || "", env, lane),
        stderr: redactDiagnostic(error?.stderr || errorMessage(error), env, lane),
        ...safeLaneMetadata(lane),
      });
    }
  }

  return {
    schema_version: 1,
    kind,
    commit: resolvedCommit,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    summary: summarize(results),
    results,
  };
}

export async function probeCredential(credentialProbe, { cwd, env }) {
  try {
    await execFileAsync(
      credentialProbe.command[0],
      credentialProbe.command.slice(1),
      {
        cwd,
        env,
        timeout: credentialProbe.timeoutMs ?? 30_000,
        maxBuffer: 256 * 1024,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function runLiveCertification(options) {
  return runCertification({ ...options, kind: "openma.live_certification" });
}

async function executeLane(lane, { cwd, env }) {
  const { stdout, stderr } = await execFileAsync(
    lane.command[0],
    lane.command.slice(1),
    {
      cwd,
      env,
      timeout: lane.timeoutMs ?? 15 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { exitCode: 0, stdout, stderr };
}

export function certificationExitCode(report, { allowMissing = false } = {}) {
  if (report.summary.fail > 0) return 1;
  if (!allowMissing && report.summary.not_run_no_credential > 0) return 2;
  return 0;
}

export function renderCertificationSummary(report) {
  const lines = report.results.map((result) => {
    const detail = result.status === "NOT_RUN_NO_CREDENTIAL"
      ? ` missing ${result.missing_credentials.map((group) => group.join("|")).join(", ")}`
      : result.status === "FAIL"
        ? ` exit=${result.exit_code}`
        : ` ${result.duration_ms}ms`;
    return `[${result.status}] ${result.provider}${detail}`;
  });
  const summary = report.summary;
  lines.push(
    `summary: PASS=${summary.pass} FAIL=${summary.fail} NOT_RUN_NO_CREDENTIAL=${summary.not_run_no_credential}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function writeCertificationReport(report, reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  const file = await open(reportPath, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await file.close();
  }
}

function missingCredentialRequirements(lane, env) {
  return (lane.credentialRequirements ?? [])
    .filter(({ anyOf }) => !anyOf.some((name) => hasValue(env[name])))
    .map(({ anyOf }) => [...anyOf]);
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function summarize(results) {
  return {
    total: results.length,
    pass: results.filter(({ status }) => status === "PASS").length,
    fail: results.filter(({ status }) => status === "FAIL").length,
    not_run_no_credential: results.filter(
      ({ status }) => status === "NOT_RUN_NO_CREDENTIAL",
    ).length,
  };
}

function elapsedMilliseconds(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function numericExitCode(error) {
  return typeof error?.code === "number" ? error.code : 1;
}

function errorMessage(error) {
  return String(error);
}

function safeLaneMetadata(lane) {
  const metadata = {};
  for (const key of ["sdk_version", "image", "region"]) {
    if (hasValue(lane[key])) metadata[key] = lane[key];
  }
  return Object.keys(metadata).length === 0 ? {} : { metadata };
}

function redactDiagnostic(input, env, lane) {
  let output = String(input);
  const credentialNames = new Set(
    (lane.credentialRequirements ?? []).flatMap(({ anyOf }) => anyOf),
  );
  const secrets = Object.entries(env)
    .filter(([name, value]) => hasValue(value) && (SECRET_NAME.test(name) || credentialNames.has(name)))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) output = output.split(secret).join("<redacted>");
  output = output
    .replace(/(env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NONCE)[A-Z0-9_]*\s+\(")[^"]*("\))/gi, "$1<redacted>$2")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s]+/gi, "$1<redacted>")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>");
  return output.slice(-MAX_DIAGNOSTIC_BYTES);
}

async function inspectCommit(cwd) {
  try {
    const [{ stdout: sha }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["status", "--porcelain"], { cwd }),
    ]);
    return { sha: sha.trim(), dirty: status.trim() !== "" };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

async function readManifest(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed.lanes)) throw new Error("certification manifest requires a lanes array");
  return parsed.lanes;
}

function parseArguments(argv) {
  const options = {
    allowMissing: false,
    envFilePath: resolve(".env.certification.local"),
    envFileRequired: false,
    reportPath: resolve("artifacts/certification/live-certification.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--allow-missing") options.allowMissing = true;
    else if (argument === "--credentials-file") {
      options.envFilePath = resolve(requiredArgument(argv, ++index, argument));
      options.envFileRequired = true;
    }
    else if (argument === "--report") options.reportPath = resolve(requiredArgument(argv, ++index, argument));
    else if (argument === "--manifest") options.manifestPath = resolve(requiredArgument(argv, ++index, argument));
    else if (argument === "--providers") {
      options.providers = requiredArgument(argv, ++index, argument)
        .split(",")
        .map((provider) => provider.trim())
        .filter(Boolean);
    } else {
      throw new Error(`unknown live certification option: ${argument}`);
    }
  }
  return options;
}

async function loadCertificationEnvironment(path, { required }) {
  try {
    const values = parseEnv(await readFile(path, "utf8"));
    return { ...values, ...process.env };
  } catch (error) {
    if (!required && error?.code === "ENOENT") return process.env;
    throw error;
  }
}

function requiredArgument(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function selectProviders(lanes, providers) {
  if (providers === undefined) return lanes;
  const available = new Map(lanes.map((lane) => [lane.provider, lane]));
  const unknown = providers.filter((provider) => !available.has(provider));
  if (unknown.length > 0) throw new Error(`unknown certification providers: ${unknown.join(", ")}`);
  return providers.map((provider) => available.get(provider));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const env = await loadCertificationEnvironment(options.envFilePath, {
    required: options.envFileRequired,
  });
  const configuredLanes = options.manifestPath
    ? await readManifest(options.manifestPath)
    : defaultLiveCertificationLanes();
  const lanes = selectProviders(configuredLanes, options.providers);
  if (lanes.length === 0) throw new Error("live certification selected no providers");
  const report = await runLiveCertification({ lanes, env });
  await writeCertificationReport(report, options.reportPath);
  process.stdout.write(renderCertificationSummary(report));
  process.stdout.write(`report: ${options.reportPath}\n`);
  process.exitCode = certificationExitCode(report, { allowMissing: options.allowMissing });
}

const invokedPath = resolve(process.argv[1]);
// The CLI boot boundary is exercised by spawn-based tests above; Node's test coverage
// collector intentionally does not merge coverage from those child processes.
/* node:coverage ignore next 6 */
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
