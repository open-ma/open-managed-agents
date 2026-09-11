import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedEnvironmentWorkDispatchPort,
  type CloudflareManagedEnvironmentDispatchOptions,
  type CloudflareManagedSessionRuntimePort,
} from "../src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _FactoryKeepsCloudflareConstructorOptions = Assert<Equal<
  Parameters<typeof createManagedEnvironmentWorkDispatchPort>[0],
  CloudflareManagedEnvironmentDispatchOptions
>>;

const work: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-07T04:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: { backend: "microvm" },
  secret: "opaque-work-secret",
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

describe("Cloudflare Managed Agents Work dispatcher", () => {
  it("routes a reserved Session Work to its session-named MicroVM runtime", async () => {
    const dispatch = vi.fn(async (
      _input: Parameters<CloudflareManagedSessionRuntimePort["dispatch"]>[0],
    ) => ({ created: true }));
    const runtime: CloudflareManagedSessionRuntimePort = { dispatch };
    const getRuntime = vi.fn(() => runtime);
    const port = createManagedEnvironmentWorkDispatchPort({
      resolveBackend: vi.fn(async () => "microvm"),
      getRuntime,
    });

    await port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "must-not-enter-runtime-payload",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(getRuntime).toHaveBeenCalledWith({
      backend: "microvm",
      sessionId: "session_01",
    });
    expect(dispatch).toHaveBeenCalledWith({
      apiBaseUrl: "https://api.openma.test",
      environmentId: "env_01",
      sessionId: "session_01",
      signal: expect.any(AbortSignal),
      workId: "work_01",
    });
    expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("environmentKey");
  });

  it("uses the same idempotent session dispatch contract for Isolate runtimes", async () => {
    const dispatch = vi.fn(async (
      _input: Parameters<CloudflareManagedSessionRuntimePort["dispatch"]>[0],
    ) => ({ created: false }));
    const port = createManagedEnvironmentWorkDispatchPort({
      resolveBackend: vi.fn(async () => "isolate"),
      getRuntime: vi.fn(() => ({ dispatch })),
    });

    await port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(port.descriptor()).toEqual({
      provider: "cloudflare",
      strategy: "poll_unacked_then_dispatch",
      version: "1.0.0",
    });
  });

  it("fails closed before runtime creation when backend resolution is invalid", async () => {
    const getRuntime = vi.fn();
    const port = createManagedEnvironmentWorkDispatchPort({
      resolveBackend: vi.fn(async () => "unknown"),
      getRuntime,
    });

    await expect(port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    })).rejects.toThrow(/unsupported Cloudflare backend/);
    expect(getRuntime).not.toHaveBeenCalled();
  });
});
