import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const genericManagedRuntimePackages = new Set([
  "@open-managed-agents/managed-runtime-host",
  "@open-managed-agents/managed-runtime-sandbox",
]);

export async function providerPackageBoundaryViolations(root) {
  const violations = [];
  const packagesRoot = join(root, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const adapterDirectories = entries
    .filter((entry) => entry.isDirectory() && isProviderAdapterDirectory(entry.name))
    .map((entry) => join(packagesRoot, entry.name))
    .sort();

  for (const directory of adapterDirectories) {
    const packageJsonPath = join(directory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const displayPackageJson = relative(root, packageJsonPath);
    const peers = packageJson.peerDependencies ?? {};
    const peerMeta = packageJson.peerDependenciesMeta ?? {};

    const isManagedRuntime = packageJson.name?.startsWith(
      "@open-managed-agents/managed-runtime-",
    );
    const isEnvironmentActivation = packageJson.name?.startsWith(
      "@open-managed-agents/environment-activation-",
    );
    const isEnvironmentDispatch = packageJson.name?.startsWith(
      "@open-managed-agents/environment-dispatch-",
    );
    if (isManagedRuntime || isEnvironmentActivation || isEnvironmentDispatch) {
      const indexPath = join(directory, "src", "index.ts");
      let indexSource = "";
      try {
        indexSource = await readFile(indexPath, "utf8");
      } catch {
        // Report through the same stable contract failure below.
      }
      const requiredFactory = isEnvironmentActivation
        ? "createManagedEnvironmentActivationPort"
        : isEnvironmentDispatch
          ? "createManagedEnvironmentWorkDispatchPort"
          : "createManagedRuntimeProviderDriver";
      if (!new RegExp(`\\b${requiredFactory}\\b`).test(indexSource)) {
        violations.push(
          `${relative(root, indexPath)}: missing ${requiredFactory} export`,
        );
      }
    }

    for (const [field, dependencies] of [
      ["dependencies", packageJson.dependencies ?? {}],
      ["optionalDependencies", packageJson.optionalDependencies ?? {}],
    ]) {
      for (const dependency of Object.keys(dependencies)) {
        if (!dependency.startsWith("@open-managed-agents/")) {
          violations.push(`${displayPackageJson}: external runtime dependency ${dependency}`);
          continue;
        }
        if (
          (dependency.startsWith("@open-managed-agents/managed-runtime-")
            || dependency.startsWith("@open-managed-agents/environment-activation-")
            || dependency.startsWith("@open-managed-agents/environment-dispatch-"))
          && dependency !== "@open-managed-agents/managed-runtime-host"
          && !genericManagedRuntimePackages.has(dependency)
        ) {
          violations.push(`${displayPackageJson}: cross-provider dependency ${dependency}`);
        }
      }
    }

    for (const sourcePath of await sourceFiles(join(directory, "src"))) {
      const source = await readFile(sourcePath, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier.startsWith(".")
          || specifier.startsWith("node:")
          || specifier.startsWith("@open-managed-agents/")
        ) continue;
        if (!(specifier in peers) || peerMeta[specifier]?.optional !== true) {
          violations.push(
            `${relative(root, sourcePath)}: provider import ${specifier} is not an optional peer dependency`,
          );
        }
      }
    }

    const certificationTests = (await sourceFiles(join(directory, "test")))
      .filter((path) => /certification\.e2e\.test\.[cm]?tsx?$/.test(path));
    const hasSdkDependentCertification = (await Promise.all(
      certificationTests.map(async (path) => {
        const source = await readFile(path, "utf8");
        return importSpecifiers(source).some((specifier) => specifier in peers);
      }),
    )).some(Boolean);
    if (hasSdkDependentCertification) {
      const tsconfigPath = join(directory, "tsconfig.json");
      let tsconfig = {};
      try {
        tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
      } catch {
        // A missing or unreadable default project cannot isolate the lane.
      }
      const excludesCertification = (tsconfig.exclude ?? []).some(
        (pattern) => typeof pattern === "string" && pattern.includes("certification"),
      );
      if (!excludesCertification) {
        violations.push(
          `${relative(root, tsconfigPath)}: default typecheck includes SDK-dependent certification tests`,
        );
      }
    }
  }

  return violations.sort();
}

/** Keep the default monorepo install provider-neutral. pnpm otherwise
 * auto-installs optional peer SDKs for every workspace adapter, which turns a
 * source-level boundary into one large transitive dependency graph. */
export async function providerWorkspaceBoundaryViolations(root) {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  return /^autoInstallPeers:\s*false\s*$/m.test(workspace)
    ? []
    : ["pnpm-workspace.yaml: autoInstallPeers must be false"];
}

function isProviderAdapterDirectory(name) {
  if (name.startsWith("sandbox-adapter-")) return true;
  if (
    name.startsWith("environment-activation-")
    && !name.startsWith("environment-activation-store-")
  ) return true;
  if (name.startsWith("environment-dispatch-")) return true;
  return name.startsWith("managed-runtime-")
    && !["managed-runtime-host", "managed-runtime-node", "managed-runtime-sandbox"].includes(name);
}

async function sourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
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
