import { describe, expect, it } from "vitest";

import { readVercelControlPlaneConfig } from "../src/config";

const environment = {
  PUBLIC_BASE_URL: "https://control.example.test/",
  OPENMA_WORKSPACE_ID: "workspace_01",
  OPENMA_ENVIRONMENT_ID: "env_01",
  OPENMA_ENVIRONMENT_KEY: "oma_env_secret",
  OPENMA_ENVIRONMENT_WEBHOOK_SECRET: "whsec_secret",
  OPENMA_VERCEL_SNAPSHOT_ID: "snap_01",
  OPENMA_VERCEL_WORKER_COMMAND: "/opt/openma/openma-acp-work-item",
  OPENMA_VERCEL_HARNESS_ID: "pi-acp",
  CRON_SECRET: "cron-secret",
} as const;

describe("Vercel control-plane configuration", () => {
  it("decodes a complete default configuration", () => {
    expect(readVercelControlPlaneConfig(environment)).toEqual({
      apiBaseUrl: "https://control.example.test",
      workspaceId: "workspace_01",
      environmentId: "env_01",
      environmentKey: "oma_env_secret",
      webhookSecret: "whsec_secret",
      cronSecret: "cron-secret",
      snapshotId: "snap_01",
      sandbox: {
        timeoutMs: 3_600_000,
        maxWorkItemsPerDrain: 4,
        pollTimeoutMs: 20_000,
        worker: {
          command: "/opt/openma/openma-acp-work-item",
          args: [],
          cwd: "/workspace",
          env: {
            OPENMA_HARNESS_ID: "pi-acp",
            OPENMA_HARNESS_VERSION: "1",
          },
        },
      },
    });
  });

  it("decodes bounded provider and installed-agent overrides without a shell", () => {
    expect(readVercelControlPlaneConfig({
      ...environment,
      OPENMA_SANDBOX_API_BASE_URL: "http://127.0.0.1:8787/",
      OPENMA_VERCEL_WORKER_ARGS_JSON: "[\"--mode\",\"managed\"]",
      OPENMA_VERCEL_WORKER_CWD: "/work",
      OPENMA_VERCEL_HARNESS_VERSION: "2",
      OPENMA_VERCEL_ACP_AGENT_ID: "opencode",
      OPENMA_VERCEL_REGION: "hnd1",
      OPENMA_VERCEL_VCPUS: "4",
      OPENMA_VERCEL_TIMEOUT_MS: "600000",
      OPENMA_VERCEL_MAX_WORK_ITEMS: "2",
      OPENMA_VERCEL_POLL_TIMEOUT_MS: "15000",
    })).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:8787",
      sandbox: {
        region: "hnd1",
        resources: { vcpus: 4 },
        timeoutMs: 600_000,
        maxWorkItemsPerDrain: 2,
        pollTimeoutMs: 15_000,
        worker: {
          args: ["--mode", "managed"],
          cwd: "/work",
          env: {
            OPENMA_HARNESS_ID: "pi-acp",
            OPENMA_HARNESS_VERSION: "2",
            OPENMA_ACP_AGENT_ID: "opencode",
          },
        },
      },
    });
  });

  it.each([
    "PUBLIC_BASE_URL",
    "OPENMA_WORKSPACE_ID",
    "OPENMA_ENVIRONMENT_ID",
    "OPENMA_ENVIRONMENT_KEY",
    "OPENMA_ENVIRONMENT_WEBHOOK_SECRET",
    "OPENMA_VERCEL_SNAPSHOT_ID",
    "OPENMA_VERCEL_WORKER_COMMAND",
    "OPENMA_VERCEL_HARNESS_ID",
    "CRON_SECRET",
  ])("fails closed when %s is absent", (key) => {
    expect(() => readVercelControlPlaneConfig({ ...environment, [key]: undefined }))
      .toThrow(`${key} is required`);
  });

  it.each([
    ["OPENMA_VERCEL_TIMEOUT_MS", "0"],
    ["OPENMA_VERCEL_MAX_WORK_ITEMS", "1.5"],
    ["OPENMA_VERCEL_POLL_TIMEOUT_MS", "NaN"],
    ["OPENMA_VERCEL_VCPUS", "-1"],
  ])("rejects invalid positive integer %s=%s", (key, value) => {
    expect(() => readVercelControlPlaneConfig({ ...environment, [key]: value }))
      .toThrow(`${key} must be a positive integer`);
  });

  it.each([
    "not-json",
    "{}",
    "[\"ok\", 1]",
  ])("rejects unsafe worker arguments %s", (args) => {
    expect(() => readVercelControlPlaneConfig({
      ...environment,
      OPENMA_VERCEL_WORKER_ARGS_JSON: args,
    })).toThrow("OPENMA_VERCEL_WORKER_ARGS_JSON");
  });

  it("rejects non-HTTP and insecure public control-plane origins", () => {
    expect(() => readVercelControlPlaneConfig({
      ...environment,
      PUBLIC_BASE_URL: "not a URL",
    })).toThrow("HTTP(S)");
    expect(() => readVercelControlPlaneConfig({
      ...environment,
      PUBLIC_BASE_URL: "ftp://control.example.test",
    })).toThrow("HTTP(S)");
    expect(() => readVercelControlPlaneConfig({
      ...environment,
      PUBLIC_BASE_URL: "http://control.example.test",
    })).toThrow("HTTPS");
  });
});
