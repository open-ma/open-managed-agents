#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadDeepSeekCredential } from "./deepseek-live-certification.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildHarnessInSandboxCertificationPlan() {
  return [
    { id: "pi-acp", credential: "deepseek", nativeState: "pi" },
    { id: "codex-acp", credential: "codex-oauth", nativeState: "codex" },
    { id: "mcode", credential: "deepseek", nativeState: "mcode" },
  ];
}

export function credentialPathsForHarness(harnessId, home = homedir()) {
  if (harnessId === "pi-acp") return [];
  if (harnessId === "codex-acp") return [join(home, ".codex", "auth.json")];
  if (harnessId === "mcode") return [];
  throw new Error(`Unsupported harness for live certification: ${harnessId}`);
}

export function redactCertificationOutput(value, secrets) {
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .reduce((output, secret) => output.split(secret).join("<redacted>"), String(value));
}

export async function runHarnessInSandboxCertification(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const environment = { ...(options.env ?? process.env) };
  environment.DEEPSEEK_API_KEY = await loadDeepSeekCredential(environment);
  const plan = buildHarnessInSandboxCertificationPlan();
  const commands = new Map([
    ["pi-acp", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:pi-acp-docker"]]],
    ["codex-acp", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:codex-acp-docker"]]],
    ["mcode", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:mcode-acp-docker"]]],
  ]);
  const report = { ok: false, steps: [] };
  for (const step of plan) {
    for (const credentialPath of credentialPathsForHarness(step.id)) {
      await access(credentialPath);
    }
    const [command, args] = commands.get(step.id);
    const started = performance.now();
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: repoRoot,
        env: environment,
        timeout: 15 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      report.steps.push({
        ...step,
        status: "passed",
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        output_tail: redactCertificationOutput(stdout, [environment.DEEPSEEK_API_KEY]).slice(-8_192),
      });
    } catch (error) {
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const redacted = redactCertificationOutput(output, [environment.DEEPSEEK_API_KEY]);
      throw new Error(`${step.id} failed\n${redacted.slice(-16_384)}`, { cause: error });
    }
  }
  report.ok = true;
  return report;
}

async function main() {
  const report = await runHarnessInSandboxCertification();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
