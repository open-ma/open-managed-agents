#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  certificationExitCode,
  renderCertificationSummary,
  runCertification,
  writeCertificationReport,
} from "./live-certification.mjs";

const PROVIDER_LANES = [
  ["blaxel", "@open-managed-agents/managed-runtime-blaxel", "@blaxel/core@^0.3.19"],
  ["cloudflare", "@open-managed-agents/managed-runtime-cloudflare", "@cloudflare/sandbox"],
  ["modal", "@open-managed-agents/managed-runtime-modal", "modal@^0.10.0"],
  ["sprites", "@open-managed-agents/managed-runtime-sprites", "@fly/sprites@^0.2.2"],
  ["superserve", "@open-managed-agents/managed-runtime-superserve", "@superserve/sdk@^0.8.2"],
  ["vercel", "@open-managed-agents/managed-runtime-vercel", "@vercel/sandbox@^3.2.1"],
].map(([provider, packageName, sdkVersion]) => ({
  provider,
  credentialRequirements: [],
  command: ["pnpm", "--filter", packageName, "test:certification:offline"],
  sdk_version: sdkVersion,
}));

export function defaultOfflineCertificationLanes() {
  return structuredClone(PROVIDER_LANES);
}

export function runOfflineCertification(options = {}) {
  return runCertification({
    ...options,
    lanes: options.lanes ?? defaultOfflineCertificationLanes(),
    kind: "openma.offline_certification",
  });
}

export function parseOfflineCertificationArguments(argv) {
  const options = {
    reportPath: resolve("artifacts/certification/offline-certification.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--report") options.reportPath = resolve(requiredArgument(argv, ++index, argument));
    else if (argument === "--providers") {
      options.providers = requiredArgument(argv, ++index, argument)
        .split(",")
        .map((provider) => provider.trim())
        .filter(Boolean);
    } else {
      throw new Error(`unknown offline certification option: ${argument}`);
    }
  }
  return options;
}

function requiredArgument(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function selectOfflineCertificationProviders(lanes, providers) {
  if (providers === undefined) return lanes;
  const available = new Map(lanes.map((lane) => [lane.provider, lane]));
  const unknown = providers.filter((provider) => !available.has(provider));
  if (unknown.length > 0) throw new Error(`unknown certification providers: ${unknown.join(", ")}`);
  return providers.map((provider) => available.get(provider));
}

export async function runOfflineCertificationCli({
  argv = process.argv.slice(2),
  lanes: configuredLanes = defaultOfflineCertificationLanes(),
  cwd = process.cwd(),
  commit,
  execute,
  stdout = process.stdout,
  writeReport = writeCertificationReport,
} = {}) {
  const options = parseOfflineCertificationArguments(argv);
  const lanes = selectOfflineCertificationProviders(configuredLanes, options.providers);
  if (lanes.length === 0) throw new Error("offline certification selected no providers");
  const report = await runOfflineCertification({ lanes, cwd, commit, execute });
  await writeReport(report, options.reportPath);
  stdout.write(renderCertificationSummary(report));
  stdout.write(`report: ${options.reportPath}\n`);
  return certificationExitCode(report);
}

const invokedPath = resolve(process.argv[1]);
/* node:coverage ignore next 8 */
if (invokedPath === fileURLToPath(import.meta.url)) {
  runOfflineCertificationCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
