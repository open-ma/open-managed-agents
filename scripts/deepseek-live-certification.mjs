#!/usr/bin/env node

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildDeepSeekCertificationPlan() {
  return [
    { id: "pi-harness-out", mode: "harness-out-sandbox" },
    { id: "pi-compaction-cache", mode: "harness-out-sandbox" },
    { id: "acp-native-resume-cache", mode: "harness-in-sandbox" },
    { id: "pi-acp-docker", mode: "harness-in-sandbox" },
  ];
}

export function parseDeepSeekCredential(source) {
  const match = source.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\n"'#]+)["']?\s*$/m);
  return match?.[1]?.trim() || null;
}

export async function loadDeepSeekCredential(env = process.env) {
  if (env.DEEPSEEK_API_KEY?.trim()) return env.DEEPSEEK_API_KEY.trim();
  const source = await readFile(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const credential = parseDeepSeekCredential(source);
  if (!credential) {
    throw new Error("DEEPSEEK_API_KEY is missing from env and ~/.dsh/.credentials.yaml");
  }
  return credential;
}

export async function runDeepSeekCertification(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const credential = await loadDeepSeekCredential(options.env ?? process.env);
  const environment = { ...(options.env ?? process.env), DEEPSEEK_API_KEY: credential };
  const plan = buildDeepSeekCertificationPlan();
  const commands = new Map([
    ["pi-harness-out", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:pi-deepseek"]]],
    ["pi-compaction-cache", ["pnpm", ["exec", "tsx", "scripts/probe-pi-deepseek-compaction-cache.ts"]]],
    ["acp-native-resume-cache", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:acp-deepseek-cache"]]],
    ["pi-acp-docker", ["pnpm", ["--filter", "@open-managed-agents/main-node", "test:e2e:pi-acp-docker"]]],
  ]);
  const report = {
    ok: false,
    model: process.env.PROBE_MODEL ?? "deepseek-v4-flash",
    steps: [],
  };
  for (const step of plan) {
    const [command, args] = commands.get(step.id);
    const started = performance.now();
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: repoRoot,
        env: environment,
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      report.steps.push({
        ...step,
        status: "passed",
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        output_tail: redact(stdout, credential).slice(-8_192),
      });
    } catch (error) {
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      throw new Error(`${step.id} failed\n${redact(output, credential).slice(-16_384)}`, { cause: error });
    }
  }
  report.ok = true;
  return report;
}

function redact(value, secret) {
  return String(value).split(secret).join("<redacted>");
}

async function main() {
  if (process.argv.includes("--check-credential")) {
    await loadDeepSeekCredential();
    process.stdout.write("DeepSeek credential available\n");
    return;
  }
  const report = await runDeepSeekCertification();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
