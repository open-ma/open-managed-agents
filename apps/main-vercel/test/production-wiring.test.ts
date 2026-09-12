import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sandboxGetOrCreate = vi.fn(async () => ({ kind: "created" }));
  const sandboxGet = vi.fn(async () => ({ kind: "existing" }));
  const apiFetch = vi.fn(async (request: Request) => Response.json({
    path: new URL(request.url).pathname,
  }));
  const waitUntil = vi.fn();
  const drain = vi.fn(async () => undefined);
  const handleWebhook = vi.fn((input: { waitUntil(promise: Promise<void>): void }) => {
    input.waitUntil(Promise.resolve());
    return { type: "triggered", eventId: "event_01" };
  });
  const run = vi.fn();
  return {
    sandboxGetOrCreate,
    sandboxGet,
    apiFetch,
    waitUntil,
    drain,
    handleWebhook,
    run,
    anthropicOptions: undefined as unknown,
    workerDependencies: undefined as unknown,
  };
});

vi.mock("@open-managed-agents/main-node", () => ({
  app: { fetch: mocks.apiFetch },
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    getOrCreate: mocks.sandboxGetOrCreate,
    get: mocks.sandboxGet,
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor(options: unknown) {
      mocks.anthropicOptions = options;
    }
  },
}));

vi.mock("../src/environment-worker", () => ({
  createVercelEnvironmentWorker: vi.fn((_config: unknown, dependencies: unknown) => {
    mocks.workerDependencies = dependencies;
    return {
      drain: mocks.drain,
      handleWebhook: mocks.handleWebhook,
      run: mocks.run,
    };
  }),
}));

import type { VercelEnvironmentWorkerDependencies } from "../src/environment-worker";
import { createProductionVercelControlPlane } from "../src/production";

const environment = {
  PUBLIC_BASE_URL: "https://control.example.test",
  OPENMA_WORKSPACE_ID: "workspace_01",
  OPENMA_ENVIRONMENT_ID: "env_01",
  OPENMA_ENVIRONMENT_KEY: "environment-key",
  OPENMA_ENVIRONMENT_WEBHOOK_SECRET: "whsec_01",
  OPENMA_VERCEL_SNAPSHOT_ID: "snapshot_01",
  OPENMA_VERCEL_WORKER_COMMAND: "/opt/openma/work-item",
  OPENMA_VERCEL_HARNESS_ID: "pi-acp",
  CRON_SECRET: "cron-secret",
};

describe("production Vercel wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerDependencies = undefined;
    mocks.anthropicOptions = undefined;
  });

  it("wires the API, Environment worker, Vercel SDK and both error boundaries", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mutableEnvironment: Record<string, string | undefined> = { ...environment };
    const controlPlane = createProductionVercelControlPlane(mutableEnvironment);

    const apiResponse = await controlPlane.fetch(new Request("https://control.example.test/health"));
    expect(await apiResponse.json()).toEqual({ path: "/health" });

    const poll = () => controlPlane.fetch(new Request(
      "https://control.example.test/api/openma/environment/poll",
      { headers: { authorization: "Bearer cron-secret" } },
    ));
    await expect(poll()).resolves.toMatchObject({ status: 200 });
    expect(mocks.anthropicOptions).toMatchObject({
      apiKey: "environment-key",
      baseURL: "https://control.example.test",
      webhookKey: "whsec_01",
      maxRetries: 0,
    });

    const dependencies = mocks.workerDependencies as VercelEnvironmentWorkerDependencies;
    await expect(dependencies.sandboxClient.getOrCreate({} as never))
      .resolves.toEqual({ kind: "created" });
    await expect(dependencies.sandboxClient.get({ name: "sandbox_01" }))
      .resolves.toEqual({ kind: "existing" });
    await dependencies.onError?.(new Error("worker failed"));

    const webhookResponse = await controlPlane.fetch(new Request(
      "https://control.example.test/api/openma/environment/webhook",
      { method: "POST", body: "{}" },
    ));
    expect(webhookResponse.status).toBe(202);
    expect(mocks.waitUntil).toHaveBeenCalledOnce();

    mocks.drain.mockRejectedValueOnce(new Error("poll failed"));
    await expect(poll()).resolves.toMatchObject({ status: 503 });
    expect(consoleError).toHaveBeenCalledWith(
      "[openma:vercel-environment-worker]",
      expect.objectContaining({ message: "worker failed" }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[openma:vercel-control-plane]",
      expect.objectContaining({ message: "poll failed" }),
    );

    expect(mutableEnvironment).toMatchObject({
      OPENMA_PROCESS_MODE: "serverless",
      MEMORY_QUEUE: "disabled",
      FEISHU_WS_RUNNER: "0",
      SESSION_OUTPUTS_DIR: "/tmp/openma/session-outputs",
    });
  });
});
