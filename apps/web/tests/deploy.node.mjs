import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as deployWizard from "../src/lib/deploy-wizard.ts";

import {
  buildDeploymentPlan,
  DEPLOYMENT_TARGETS,
  parseBrowserSelection,
  serializeBrowserSelection,
} from "../src/lib/deploy-wizard.ts";

test("Vercel Deploy Button provisions Postgres, carries callback, and no secret values", () => {
  assert.equal(typeof deployWizard.buildVercelDeployButtonUrl, "function");
  const deployUrl = new URL(deployWizard.buildVercelDeployButtonUrl({
    redirectUrl: "https://openma.dev/deploy/?provider=vercel&phase=callback",
  }));

  assert.equal(deployUrl.origin, "https://vercel.com");
  assert.equal(deployUrl.pathname, "/new/clone");
  assert.equal(
    deployUrl.searchParams.get("repository-url"),
    "https://github.com/openma-ai/open-managed-agents",
  );
  assert.equal(
    deployUrl.searchParams.get("redirect-url"),
    "https://openma.dev/deploy/?provider=vercel&phase=callback",
  );
  const environmentKeys = new Set(deployUrl.searchParams.get("env")?.split(","));
  for (const key of [
    "BETTER_AUTH_SECRET",
    "PLATFORM_ROOT_SECRET",
    "MEMORY_S3_SECRET_KEY",
    "FILES_S3_SECRET_KEY",
  ]) {
    assert.ok(environmentKeys.has(key), `missing ${key}`);
  }
  assert.equal(environmentKeys.has("DATABASE_URL"), false);
  assert.equal(environmentKeys.has("PUBLIC_BASE_URL"), false);
  assert.deepEqual(JSON.parse(deployUrl.searchParams.get("products")), [{
    type: "integration",
    protocol: "storage",
    productSlug: "neon",
    integrationSlug: "neon",
  }]);
  assert.equal(deployUrl.searchParams.has("envDefaults"), false);
  assert.doesNotMatch(deployUrl.href, /postgres:\/\/|whsec_|secret-key/i);
});

test("Vercel callback parser accepts deployment metadata but rejects unsafe URLs", () => {
  assert.equal(typeof deployWizard.parseVercelDeploymentCallback, "function");
  const callback = deployWizard.parseVercelDeploymentCallback(new URLSearchParams({
    provider: "vercel",
    phase: "callback",
    "project-name": "openma-demo",
    "deployment-url": "https://openma-demo.vercel.app",
    "project-dashboard-url": "https://vercel.com/acme/openma-demo",
    "deployment-dashboard-url": "https://vercel.com/acme/openma-demo/deployments/dep_01",
    "repository-url": "https://github.com/acme/openma-demo",
  }));

  assert.deepEqual(callback, {
    projectName: "openma-demo",
    deploymentUrl: "https://openma-demo.vercel.app/",
    projectDashboardUrl: "https://vercel.com/acme/openma-demo",
    deploymentDashboardUrl: "https://vercel.com/acme/openma-demo/deployments/dep_01",
    repositoryUrl: "https://github.com/acme/openma-demo",
  });
  assert.equal(deployWizard.parseVercelDeploymentCallback(new URLSearchParams()), null);
  assert.equal(deployWizard.parseVercelDeploymentCallback(new URLSearchParams({
    provider: "vercel",
    phase: "callback",
    "project-name": "unsafe",
    "deployment-url": "javascript:alert(1)",
  })), null);
});

test("deployment targets expose honest support boundaries", () => {
  assert.equal(DEPLOYMENT_TARGETS.cloudflare.availability, "ready");
  assert.equal(DEPLOYMENT_TARGETS.docker.availability, "ready");
  assert.equal(DEPLOYMENT_TARGETS.fly.availability, "ready");
  assert.equal(DEPLOYMENT_TARGETS.vercel.availability, "guided");
  assert.match(DEPLOYMENT_TARGETS.vercel.note, /Postgres.*Sandbox/i);
});

test("Cloudflare plan uses the repository setup wizard and never asks the website for secrets", () => {
  const plan = buildDeploymentPlan({
    target: "cloudflare",
    modelSetup: "console",
    dataMode: "managed",
  });

  assert.equal(plan.target, "cloudflare");
  assert.match(plan.command, /pnpm setup:cloudflare/);
  assert.match(plan.topology, /3 Workers/i);
  assert.match(plan.verificationCommand, /health/);
  assert.equal(plan.collectsSecrets, false);
});

test("Docker plan keeps durable state and vault proxy in the generated topology", () => {
  const plan = buildDeploymentPlan({
    target: "docker",
    modelSetup: "console",
    dataMode: "sqlite",
  });

  assert.match(plan.command, /docker compose up -d --build/);
  assert.match(plan.topology, /vault sidecar/i);
  assert.match(plan.persistence, /\.\/data/);
  assert.match(plan.command, /SANDBOX_PROVIDER=<e2b\|daytona\|boxrun\|litebox>/);
  assert.ok(plan.requirements.some((item) => /isolated sandbox provider/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /subprocess.*not available/i.test(item)));
});

test("Fly plan uses the checked-in Machine adapter and lets Fly Launch provision its volume", () => {
  const plan = buildDeploymentPlan({
    target: "fly",
    modelSetup: "console",
    dataMode: "sqlite",
  });

  assert.equal(plan.status, "Ready");
  assert.match(plan.topology, /Fly Machine.*Node control plane/i);
  assert.match(plan.command, /pnpm setup:fly/);
  assert.match(plan.command, /release checkpoint/i);
  assert.match(plan.command, /E2B_API_KEY=\.\.\./);
  assert.match(plan.command, /OPENMA_FLY_SANDBOX_PROVIDER=e2b/);
  assert.match(plan.persistence, /\/app\/data/);
  assert.ok(plan.requirements.some((item) => /isolated sandbox provider/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /initial_size.*volume/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /main-fly/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /immutable.*image|Git SHA.*image/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /subprocess.*not available/i.test(item)));
  assert.equal(plan.launchUrl, undefined);
  assert.equal(plan.collectsSecrets, false);
});

test("Vercel plan ships the bounded control plane without claiming credentialed certification", () => {
  const plan = buildDeploymentPlan({
    target: "vercel",
    modelSetup: "console",
    dataMode: "managed",
  });

  assert.equal(plan.status, "Beta");
  assert.match(plan.topology, /bounded Function.*Sandbox/i);
  assert.match(plan.command, /pnpm build:vercel/);
  assert.match(plan.command, /vercel.*deploy/i);
  assert.match(plan.verificationCommand, /health/);
  assert.ok(plan.requirements.some((item) => /Postgres/i.test(item)));
  assert.ok(plan.requirements.some((item) => /snapshot/i.test(item)));
  assert.ok(plan.nextSteps.some((item) => /credentialed.*E2E/i.test(item)));
  assert.doesNotMatch(plan.command, /not certified/i);
});

test("browser-only wizard state round-trips and rejects malformed storage", () => {
  const selection = {
    target: "docker",
    modelSetup: "environment",
    dataMode: "postgres",
  };

  assert.deepEqual(parseBrowserSelection(serializeBrowserSelection(selection)), selection);
  assert.equal(parseBrowserSelection("not-json"), null);
  assert.equal(parseBrowserSelection('{"target":"unknown"}'), null);
});

test("deploy page renders an accessible wizard and a no-secret boundary", async () => {
  const html = await readFile(
    new URL("../dist/deploy/index.html", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../src/pages/deploy.astro", import.meta.url),
    "utf8",
  );

  assert.match(html, /<title>Deploy OpenMA \| OpenMA<\/title>/);
  assert.match(html, /data-deploy-wizard/);
  assert.match(html, /aria-label="Deployment progress"/);
  assert.match(html, /Cloudflare/);
  assert.match(html, /Docker/);
  assert.match(html, /Fly\.io/);
  assert.match(html, /Vercel/);
  assert.match(html, /Secrets never leave your machine/i);
  assert.match(source, /sessionStorage/);
  assert.doesNotMatch(source, /entrypoint still needs certification/i);
  assert.match(html, /data-copy-command/);
  assert.match(html, /data-vercel-deploy/);
  assert.match(html, /data-vercel-callback/);
  assert.match(source, /parseVercelDeploymentCallback/);
});

test("site navigation links to the deployment wizard", async () => {
  const homepage = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );

  assert.match(homepage, /href="\/deploy\/"[^>]*>Deploy<\/a>/);
});
