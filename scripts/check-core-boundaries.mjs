import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  providerPackageBoundaryViolations,
  providerWorkspaceBoundaryViolations,
} from "./provider-package-boundaries.mjs";

const CORE_PACKAGES = [
  "packages/execution-control",
  "packages/managed-agents-domain",
  "packages/managed-agents-application",
  "packages/managed-agents-api",
  "packages/openai-agents-api",
  "packages/openai-agents-compat",
  "packages/managed-agents-app",
];

const FORBIDDEN_PREFIXES = [
  "cloudflare:",
  "node:",
  "better-sqlite3",
  "postgres",
  "drizzle-orm",
  "@aws-sdk/",
  "@open-managed-agents/managed-agents-adapters-",
  "@open-managed-agents/platform-node",
  "@open-managed-agents/sql-client",
];

const PROVIDER_NEUTRAL_PACKAGES = [
  "packages/sandbox",
  "packages/managed-runtime-sandbox",
];

const PROVIDER_NEUTRAL_ALLOWED_DEPENDENCIES = new Map([
  ["packages/sandbox", new Set([
    "@open-managed-agents/observability",
    "@open-managed-agents/shared",
  ])],
  ["packages/managed-runtime-sandbox", new Set([
    "@open-managed-agents/blob-store",
    "@open-managed-agents/runtime-resource-contract",
    "@open-managed-agents/sandbox",
    "effect",
  ])],
]);

// Runtime orchestration may use Effect internally, but the dependency must not
// spread into public contracts, provider adapters, or unrelated sandbox code.
const RESTRICTED_NEUTRAL_IMPORTS = new Map([
  ["effect", new Set([
    "packages/managed-runtime-sandbox/src/effect-kernel.ts",
    "packages/managed-runtime-sandbox/src/provider-runtime.ts",
  ])],
]);

const PROVIDER_DEPENDENCY_PREFIXES = [
  "e2b",
  "@daytona/",
  "@daytonaio/",
  "@boxlite-ai/",
  "@cloudflare/sandbox",
  "@open-managed-agents/sandbox-adapter-",
  "@open-managed-agents/managed-runtime-",
];

const violations = [];

for (const packageDirectory of CORE_PACKAGES) {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (isForbidden(dependency)) {
      violations.push(`${packageJsonPath}: dependency ${dependency}`);
    }
  }

  for (const sourcePath of await sourceFiles(join(packageDirectory, "src"))) {
    const source = await readFile(sourcePath, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (isForbidden(specifier)) violations.push(`${sourcePath}: import ${specifier}`);
    }
  }
}

for (const packageDirectory of PROVIDER_NEUTRAL_PACKAGES) {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const declaredDependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
  const allowedDependencies = PROVIDER_NEUTRAL_ALLOWED_DEPENDENCIES.get(
    packageDirectory,
  );
  if (allowedDependencies === undefined) {
    throw new Error(`Missing provider-neutral dependency allowlist: ${packageDirectory}`);
  }
  for (const dependency of Object.keys(declaredDependencies)) {
    if (!allowedDependencies.has(dependency)) {
      violations.push(`${packageJsonPath}: unapproved dependency ${dependency}`);
    } else if (isProviderSpecific(dependency)) {
      violations.push(`${packageJsonPath}: provider dependency ${dependency}`);
    }
  }
  for (const sourcePath of await sourceFiles(join(packageDirectory, "src"))) {
    const source = await readFile(sourcePath, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!isAllowedNeutralImport(specifier, allowedDependencies)) {
        violations.push(`${sourcePath}: unapproved import ${specifier}`);
      } else if (!isAllowedRestrictedNeutralImport(sourcePath, specifier)) {
        violations.push(`${sourcePath}: restricted import ${specifier}`);
      } else if (isProviderSpecific(specifier)) {
        violations.push(`${sourcePath}: provider import ${specifier}`);
      }
    }
  }
}

function isAllowedRestrictedNeutralImport(sourcePath, specifier) {
  const allowedPaths = RESTRICTED_NEUTRAL_IMPORTS.get(specifier);
  return allowedPaths === undefined || allowedPaths.has(sourcePath);
}

violations.push(...await providerWorkspaceBoundaryViolations(process.cwd()));
violations.push(...await providerPackageBoundaryViolations(process.cwd()));

if (violations.length > 0) {
  throw new Error(
    `Core boundary violation(s):\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
}

console.log(
  `Core boundary check passed for ${CORE_PACKAGES.length} core, ${PROVIDER_NEUTRAL_PACKAGES.length} provider-neutral packages, and all isolated provider adapters.`,
);

function isForbidden(specifier) {
  return FORBIDDEN_PREFIXES.some((prefix) =>
    specifier === prefix || specifier.startsWith(prefix),
  );
}

function isProviderSpecific(specifier) {
  return PROVIDER_DEPENDENCY_PREFIXES.some((prefix) =>
    specifier === prefix || specifier.startsWith(prefix),
  );
}

function isAllowedNeutralImport(specifier, allowedDependencies) {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return true;
  return [...allowedDependencies].some((dependency) =>
    specifier === dependency || specifier.startsWith(`${dependency}/`)
  );
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".mts"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  const imports = new Set();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}
