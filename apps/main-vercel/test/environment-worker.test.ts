import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import type {
  VercelCommandFinishedPort,
  VercelCommandPort,
  VercelGetOrCreateOptions,
  VercelRunCommandInput,
  VercelSandboxSdkPort,
  VercelSdkPort,
} from "@open-managed-agents/vercel-sandbox-contract";
import { describe, expect, it, vi } from "vitest";

import type { VercelControlPlaneConfig } from "../src/config";
import { createVercelEnvironmentWorker } from "../src/environment-worker";

const work: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-10T00:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: {},
  secret: "scoped-work-secret",
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

const config: VercelControlPlaneConfig = {
  apiBaseUrl: "https://control.example.test",
  workspaceId: "workspace_01",
  environmentId: "env_01",
  environmentKey: "standing-environment-key",
  webhookSecret: "whsec_secret",
  cronSecret: "cron-secret",
  snapshotId: "snap_01",
  sandbox: {
    timeoutMs: 90_000,
    maxWorkItemsPerDrain: 1,
    pollTimeoutMs: 20_000,
    region: "hnd1",
    resources: { vcpus: 2 },
    worker: {
      command: "/opt/openma/openma-acp-work-item",
      args: [],
      cwd: "/workspace",
      env: { OPENMA_HARNESS_ID: "pi-acp", OPENMA_HARNESS_VERSION: "1" },
    },
  },
};

function sandboxFixture() {
  const finished: VercelCommandFinishedPort = {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };
  const detached: VercelCommandPort = {
    wait: async () => ({ exitCode: 0 }),
    kill: async () => undefined,
  };
  const runCommand = vi.fn(async (input: VercelRunCommandInput) =>
    input.detached ? detached : finished);
  const sandbox: VercelSandboxSdkPort = {
    name: "pending",
    status: "running",
    persistent: true,
    tags: undefined,
    currentSnapshotId: undefined,
    expiresAt: new Date("2026-09-10T00:00:30.000Z"),
    extendTimeout: vi.fn(async () => undefined),
    runCommand: runCommand as VercelSandboxSdkPort["runCommand"],
    mkDir: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => null),
    writeFiles: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({})),
    updateNetworkPolicy: vi.fn(async (policy) => policy),
    delete: vi.fn(async () => undefined),
  };
  const getOrCreate = vi.fn(async (input: VercelGetOrCreateOptions) => {
    Object.defineProperties(sandbox, {
      name: { configurable: true, value: input.name },
      tags: { configurable: true, value: input.tags },
    });
    return sandbox;
  });
  const client: VercelSdkPort = { getOrCreate, get: vi.fn() };
  return { client, getOrCreate, runCommand };
}

describe("Vercel Environment Worker composition", () => {
  it("polls with the standing key but launches only a scoped Work capability", async () => {
    const polls = [work, null];
    const poll = vi.fn(async () => polls.shift() ?? null);
    const withOptions = vi.fn(() => ({
      beta: { environments: { work: { poll, stop: vi.fn() } } },
    }));
    const controlClient = {
      baseURL: "https://wrong.example.test",
      beta: { webhooks: { unwrap: vi.fn() } },
      withOptions,
    };
    const sandbox = sandboxFixture();
    const worker = createVercelEnvironmentWorker(config, {
      controlClient,
      sandboxClient: sandbox.client,
      now: () => Date.parse("2026-09-10T00:00:00.000Z"),
    });

    await worker.drain();

    expect(withOptions).toHaveBeenCalledWith({
      apiKey: null,
      authToken: "standing-environment-key",
      credentials: null,
      config: null,
      profile: null,
    });
    expect(poll).toHaveBeenCalledOnce();
    expect(sandbox.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: "snapshot", snapshotId: "snap_01" },
      timeout: 90_000,
      region: "hnd1",
      resources: { vcpus: 2 },
    }));
    const launched = sandbox.runCommand.mock.calls[0]?.[0] as VercelRunCommandInput;
    expect(launched.env).toMatchObject({
      ANTHROPIC_WORK_SECRET: "scoped-work-secret",
      OPENMA_HARNESS_ID: "pi-acp",
    });
    expect(JSON.stringify(launched)).not.toContain("standing-environment-key");
  });
});
