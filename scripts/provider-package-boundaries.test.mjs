import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  providerPackageBoundaryViolations,
  providerWorkspaceBoundaryViolations,
} from "./provider-package-boundaries.mjs";

const fixtureRoots = new Set();

test.afterEach(async () => {
  await Promise.all(
    [...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.after(async () => {
  assert.deepEqual(
    [...fixtureRoots].filter((root) => existsSync(root)),
    [],
    "provider boundary tests leaked temporary fixtures",
  );
});

async function fixture(
  packageJson,
  source = "export function createManagedRuntimeProviderDriver() { return {}; }",
  packageDirectory = "managed-runtime-acme",
) {
  const root = await mkdtemp(join(tmpdir(), "oma-provider-boundary-"));
  fixtureRoots.add(root);
  const directory = join(root, "packages", packageDirectory);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: `@open-managed-agents/${packageDirectory}`,
    version: "0.1.0",
    ...packageJson,
  }));
  await writeFile(join(directory, "src", "index.ts"), source);
  return root;
}

test("provider SDKs cannot be runtime dependencies of adapter packages", async () => {
  const root = await fixture({ dependencies: { "@acme/sandbox": "^1.0.0" } });
  assert.deepEqual(await providerPackageBoundaryViolations(root), [
    "packages/managed-runtime-acme/package.json: external runtime dependency @acme/sandbox",
  ]);
});

test("provider source imports require an optional peer dependency", async () => {
  const root = await fixture(
    {},
    'import "@acme/sandbox"; export function createManagedRuntimeProviderDriver() { return {}; }',
  );
  assert.deepEqual(await providerPackageBoundaryViolations(root), [
    "packages/managed-runtime-acme/src/index.ts: provider import @acme/sandbox is not an optional peer dependency",
  ]);
});

test("provider SDK optional peers are isolated inside their adapter package", async () => {
  const root = await fixture({
    dependencies: {
      "@open-managed-agents/managed-runtime-sandbox": "workspace:*",
      "@open-managed-agents/sandbox": "workspace:*",
    },
    peerDependencies: { "@acme/sandbox": "^1.0.0" },
    peerDependenciesMeta: { "@acme/sandbox": { optional: true } },
  }, 'import type { Sandbox } from "@acme/sandbox"; export type Runtime = Sandbox; export function createManagedRuntimeProviderDriver() { return {}; }');
  assert.deepEqual(await providerPackageBoundaryViolations(root), []);
});

test("credentialed certification tests stay outside the provider-neutral typecheck", async () => {
  const root = await fixture({
    peerDependencies: { "@acme/sandbox": "^1.0.0" },
    peerDependenciesMeta: { "@acme/sandbox": { optional: true } },
  });
  const directory = join(root, "packages", "managed-runtime-acme");
  await mkdir(join(directory, "test"), { recursive: true });
  await writeFile(
    join(directory, "test", "acme-certification.e2e.test.ts"),
    'export async function certify() { return import("@acme/sandbox"); }',
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts", "test/**/*.ts"] }),
  );

  assert.deepEqual(await providerPackageBoundaryViolations(root), [
    "packages/managed-runtime-acme/tsconfig.json: default typecheck includes SDK-dependent certification tests",
  ]);

  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      include: ["src/**/*.ts", "test/**/*.ts"],
      exclude: ["test/**/*.certification.e2e.test.ts", "test/**/*-certification.e2e.test.ts"],
    }),
  );
  assert.deepEqual(await providerPackageBoundaryViolations(root), []);
});

test("adapter packages cannot depend on another provider runtime", async () => {
  const root = await fixture({
    dependencies: { "@open-managed-agents/managed-runtime-other": "workspace:*" },
  });
  assert.deepEqual(await providerPackageBoundaryViolations(root), [
    "packages/managed-runtime-acme/package.json: cross-provider dependency @open-managed-agents/managed-runtime-other",
  ]);
});

test("every adapter package exposes the uniform lazy-loader factory", async () => {
  const root = await fixture({}, "export {};");
  assert.deepEqual(await providerPackageBoundaryViolations(root), [
    "packages/managed-runtime-acme/src/index.ts: missing createManagedRuntimeProviderDriver export",
  ]);
});

test("provider-native activation packages expose their own lazy-loader factory", async () => {
  const missing = await fixture(
    {},
    "export {};",
    "environment-activation-acme",
  );
  assert.deepEqual(await providerPackageBoundaryViolations(missing), [
    "packages/environment-activation-acme/src/index.ts: missing createManagedEnvironmentActivationPort export",
  ]);

  const isolated = await fixture(
    {
      dependencies: {
        "@open-managed-agents/managed-runtime-host": "workspace:*",
      },
      peerDependencies: { "@acme/launcher": "^1.0.0" },
      peerDependenciesMeta: { "@acme/launcher": { optional: true } },
    },
    'import type { Launcher } from "@acme/launcher"; export type Client = Launcher; export function createManagedEnvironmentActivationPort() { return {}; }',
    "environment-activation-acme",
  );
  assert.deepEqual(await providerPackageBoundaryViolations(isolated), []);
});

test("provider-neutral activation stores are not mistaken for provider adapters", async () => {
  const root = await fixture(
    { dependencies: { "@open-managed-agents/sql-client": "workspace:*" } },
    "export class Store {}",
    "environment-activation-store-acme",
  );
  assert.deepEqual(await providerPackageBoundaryViolations(root), []);
});

test("provider dispatch packages expose their own lazy-loader factory", async () => {
  const missing = await fixture({}, "export {};", "environment-dispatch-acme");
  assert.deepEqual(await providerPackageBoundaryViolations(missing), [
    "packages/environment-dispatch-acme/src/index.ts: missing createManagedEnvironmentWorkDispatchPort export",
  ]);

  const isolated = await fixture(
    {
      dependencies: {
        "@open-managed-agents/managed-runtime-host": "workspace:*",
      },
      peerDependencies: { "@acme/control-plane": "^1.0.0" },
      peerDependenciesMeta: { "@acme/control-plane": { optional: true } },
    },
    'import type { Client } from "@acme/control-plane"; export type Control = Client; export function createManagedEnvironmentWorkDispatchPort() { return {}; }',
    "environment-dispatch-acme",
  );
  assert.deepEqual(await providerPackageBoundaryViolations(isolated), []);
});

test("the workspace does not auto-install every optional provider SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "oma-provider-workspace-"));
  fixtureRoots.add(root);
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
  assert.deepEqual(await providerWorkspaceBoundaryViolations(root), [
    "pnpm-workspace.yaml: autoInstallPeers must be false",
  ]);
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages: ['packages/*']\nautoInstallPeers: false\n",
  );
  assert.deepEqual(await providerWorkspaceBoundaryViolations(root), []);
});

test("Cloudflare sandbox SDK, container runtime, and deployment image stay lock-step", async () => {
  const agentPackage = JSON.parse(await readFile("apps/agent/package.json", "utf8"));
  const mainPackage = JSON.parse(await readFile("apps/main/package.json", "utf8"));
  const imageDockerfile = await readFile("apps/agent/Dockerfile", "utf8");
  const deploymentDockerfile = await readFile("apps/agent/Dockerfile.sandbox", "utf8");
  const imageWorkflow = await readFile(".github/workflows/build-sandbox-image.yml", "utf8");

  const sdkVersion = agentPackage.dependencies["@cloudflare/sandbox"];
  assert.match(sdkVersion, /^\d+\.\d+\.\d+$/, "agent must pin the Sandbox SDK exactly");
  assert.equal(
    mainPackage.dependencies["@cloudflare/sandbox"],
    sdkVersion,
    "main and agent must use the same Sandbox SDK version",
  );
  assert.match(
    imageDockerfile,
    new RegExp(`^FROM docker\\.io/cloudflare/sandbox:${sdkVersion}$`, "m"),
    "custom container must extend the matching Cloudflare runtime",
  );

  const contentHash = createHash("sha256").update(imageDockerfile).digest("hex");
  assert.match(
    deploymentDockerfile,
    new RegExp(`^FROM docker\\.io/openma/sandbox-base:${contentHash}$`, "m"),
    "deployment must pin the custom image by Dockerfile content hash",
  );
  assert.match(
    imageWorkflow,
    /CONTENT_HASH=\$\(sha256sum apps\/agent\/Dockerfile/,
    "image workflow must derive the immutable tag from Dockerfile content",
  );
  assert.match(
    imageWorkflow,
    /steps\.ver\.outputs\.content_hash/,
    "image workflow must publish the content-addressed tag",
  );
});
