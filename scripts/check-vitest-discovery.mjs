import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("root Cloudflare runtime aliases stay inside the repository checkout", async () => {
  const { default: config } = await import(join(repoRoot, "vitest.config.ts"));

  const aliases = Array.isArray(config.resolve?.alias)
    ? config.resolve.alias
    : [];
  const externalAliases = aliases.flatMap((alias) => {
    if (typeof alias !== "object" || typeof alias.replacement !== "string") return [];
    if (isAbsolute(alias.replacement) || !alias.replacement.startsWith(".")) return [];

    const resolved = resolve(repoRoot, alias.replacement);
    const relativePath = relative(repoRoot, resolved);
    return relativePath === ".." || relativePath.startsWith(`..${sep}`)
      ? [`${String(alias.find)} -> ${alias.replacement}`]
      : [];
  });

  assert.deepEqual(
    externalAliases,
    [],
    `runtime aliases escape the repository checkout: ${externalAliases.join(", ")}`,
  );
});

test("root Cloudflare test discovery excludes generated and Node-only trees", () => {
  const buildDir = mkdtempSync(join(repoRoot, "apps/agent/build-vitest-discovery-"));
  const fixturePath = join(buildDir, "generated-artifact.test.ts");
  const relativeFixturePath = relative(repoRoot, fixturePath).split(sep).join("/");

  try {
    writeFileSync(
      fixturePath,
      'import { test } from "vitest";\ntest("generated artifact", () => {});\n',
    );

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(
      pnpm,
      ["exec", "vitest", "list", "--filesOnly", "--staticParse"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const collectedFiles = result.stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(
      !collectedFiles.includes(relativeFixturePath),
      `generated test artifact was collected by the root Cloudflare test project: ${relativeFixturePath}`,
    );
    const nodeOnlyPackageTests = collectedFiles.filter((path) =>
      [
        "packages/acp-runtime/",
        "packages/cli/",
        "packages/environment-activation-",
        "packages/environment-dispatch-",
        "packages/harness-runtime-acp/",
        "packages/managed-agents-runtime/",
        "packages/session-runtime-sql/test/",
        "packages/sandbox/test/",
      ].some((prefix) => path.startsWith(prefix)),
    );
    assert.deepEqual(
      nodeOnlyPackageTests,
      [],
      `Node-only package tests were collected by the root Cloudflare test project: ${nodeOnlyPackageTests.join(", ")}`,
    );
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});
