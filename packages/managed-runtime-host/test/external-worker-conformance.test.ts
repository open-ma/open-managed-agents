import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

import {
  runExternalEnvironmentWorkerConformance,
  type ExternalEnvironmentWorkerConformanceOptions,
} from "../src/external-worker-conformance";

describe("external Environment Worker conformance probe", () => {
  it("accepts the official Anthropic client without an adapter", () => {
    const client = new Anthropic({
      apiKey: null,
      authToken: "environment-key",
      baseURL: "https://openma.example.test",
      fetch: vi.fn(),
    });
    const options = {
      client,
      environmentId: "environment-1",
      environmentKey: "environment-key",
      expectedWorkId: "work-1",
      claimClientFor: () => client,
    } satisfies ExternalEnvironmentWorkerConformanceOptions;
    expect(options.client).toBe(client);
  });

  it("uses the official claim/ACK iterator, heartbeats, verifies the work secret, and stops", async () => {
    const abort = vi.fn();
    const standingHeartbeat = vi.fn();
    const standingStop = vi.fn();
    const heartbeat = vi.fn(async () => ({
      last_heartbeat: "2026-09-06T12:00:00.000Z",
      lease_extended: true,
      state: "active",
      ttl_seconds: 90,
    }));
    const stop = vi.fn(async () => ({ id: "work-1", state: "stopped" }));
    const poller = vi.fn(() => ({
      signal: new AbortController().signal,
      abort,
      async *[Symbol.asyncIterator]() {
        yield {
          id: "work-1",
          environment_id: "environment-1",
          secret: "opaque-work-secret",
          data: { type: "session", id: "session-1" },
        };
      },
    }));
    const verifyWorkSecret = vi.fn(async () => {});
    const claimClientFor = vi.fn(() => ({
      beta: { environments: { work: { heartbeat, stop } } },
    }));

    const report = await runExternalEnvironmentWorkerConformance({
      client: {
        beta: {
          environments: {
            work: { poller, heartbeat: standingHeartbeat, stop: standingStop },
          },
        },
      },
      environmentId: "environment-1",
      environmentKey: "oma_env_secret",
      expectedWorkId: "work-1",
      workerId: "conformance-1",
      claimClientFor,
      verifyWorkSecret,
    });

    expect(poller).toHaveBeenCalledWith({
      environmentId: "environment-1",
      environmentKey: "oma_env_secret",
      workerId: "conformance-1",
      autoStop: false,
      blockMs: null,
      drain: true,
    });
    expect(verifyWorkSecret).toHaveBeenCalledWith(expect.objectContaining({
      id: "work-1",
      secret: "opaque-work-secret",
    }));
    expect(claimClientFor).toHaveBeenCalledWith(expect.objectContaining({
      id: "work-1",
      secret: "opaque-work-secret",
    }));
    expect(standingHeartbeat).not.toHaveBeenCalled();
    expect(standingStop).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith("work-1", {
      environment_id: "environment-1",
      desired_ttl_seconds: 90,
      expected_last_heartbeat: "NO_HEARTBEAT",
    });
    expect(stop).toHaveBeenCalledWith("work-1", {
      environment_id: "environment-1",
      force: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(report).toEqual({
      environmentId: "environment-1",
      workId: "work-1",
      sessionId: "session-1",
      heartbeatTtlSeconds: 90,
      state: "stopped",
    });
  });

  it("refuses unexpected work and leaves it reclaimable", async () => {
    const stop = vi.fn();
    const abort = vi.fn();
    const client = {
      beta: {
        environments: {
          work: {
            poller: () => ({
              signal: new AbortController().signal,
              abort,
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "somebody-elses-work",
                  environment_id: "environment-1",
                  secret: "secret",
                  data: { type: "session", id: "session-1" },
                };
              },
            }),
            heartbeat: vi.fn(),
            stop,
          },
        },
      },
    };

    await expect(runExternalEnvironmentWorkerConformance({
      client,
      environmentId: "environment-1",
      environmentKey: "oma_env_secret",
      expectedWorkId: "expected-work",
      claimClientFor: () => client,
    })).rejects.toThrow("unexpected Work");
    expect(stop).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each([0, 1.5])("rejects invalid heartbeat TTL %s before polling", async (heartbeatTtlSeconds) => {
    await expect(runExternalEnvironmentWorkerConformance({
      client: {} as never,
      environmentId: "environment-1",
      environmentKey: "key",
      expectedWorkId: "work-1",
      heartbeatTtlSeconds,
      claimClientFor: () => ({} as never),
    })).rejects.toThrow("positive integer");
  });

  it("requires an expected work id before using the destructive probe", async () => {
    await expect(runExternalEnvironmentWorkerConformance({
      client: {} as never,
      environmentId: "environment-1",
      environmentKey: "key",
      expectedWorkId: "",
      claimClientFor: () => ({} as never),
    })).rejects.toThrow("expectedWorkId is required");
  });

  it.each([
    ["no work", [], /no queued Work/],
    ["wrong environment", [{ id: "work-1", environment_id: "other", secret: "secret", data: { type: "session", id: "session-1" } }], /unexpected Work/],
    ["wrong data type", [{ id: "work-1", environment_id: "environment-1", secret: "secret", data: { type: "task", id: "session-1" } }], /requires Session Work/],
    ["null secret", [{ id: "work-1", environment_id: "environment-1", secret: null, data: { type: "session", id: "session-1" } }], /requires Session Work/],
    ["empty secret", [{ id: "work-1", environment_id: "environment-1", secret: "", data: { type: "session", id: "session-1" } }], /requires Session Work/],
  ])("rejects %s while leaving the poller reclaimable", async (_name, work, message) => {
    const abort = vi.fn();
    const client = {
      beta: { environments: { work: {
        poller: () => ({
          abort,
          async *[Symbol.asyncIterator]() {
            for (const item of work) yield item;
          },
        }),
        heartbeat: vi.fn(),
        stop: vi.fn(),
      } } },
    };

    await expect(runExternalEnvironmentWorkerConformance({
      client: client as never,
      environmentId: "environment-1",
      environmentKey: "key",
      expectedWorkId: "work-1",
      claimClientFor: () => client as never,
    })).rejects.toThrow(message);
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each([
    [false, "active"],
    [true, "stopping"],
  ])("rejects a heartbeat that does not retain the lease (%s, %s)", async (leaseExtended, state) => {
    const abort = vi.fn();
    const lifecycle = {
      beta: { environments: { work: {
        heartbeat: vi.fn(async () => ({
          lease_extended: leaseExtended,
          state,
          ttl_seconds: 90,
        })),
        stop: vi.fn(),
      } } },
    };
    const client = {
      beta: { environments: { work: {
        poller: () => ({
          abort,
          async *[Symbol.asyncIterator]() {
            yield { id: "work-1", environment_id: "environment-1", secret: "secret", data: { type: "session", id: "session-1" } };
          },
        }),
        heartbeat: vi.fn(),
        stop: vi.fn(),
      } } },
    };

    await expect(runExternalEnvironmentWorkerConformance({
      client: client as never,
      environmentId: "environment-1",
      environmentKey: "key",
      expectedWorkId: "work-1",
      claimClientFor: () => lifecycle,
    })).rejects.toThrow("did not retain an active lease");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("supports omitted worker id, secret verifier, and stop state", async () => {
    const poller = vi.fn(() => ({
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { id: "work-1", environment_id: "environment-1", secret: "secret", data: { type: "session", id: "session-1" } };
      },
    }));
    const lifecycle = {
      beta: { environments: { work: {
        heartbeat: vi.fn(async () => ({ lease_extended: true, state: "active", ttl_seconds: 45 })),
        stop: vi.fn(async () => ({})),
      } } },
    };

    await expect(runExternalEnvironmentWorkerConformance({
      client: { beta: { environments: { work: { poller } } } } as never,
      environmentId: "environment-1",
      environmentKey: "key",
      expectedWorkId: "work-1",
      heartbeatTtlSeconds: 45,
      claimClientFor: () => lifecycle,
    })).resolves.toMatchObject({ state: "stopped", heartbeatTtlSeconds: 45 });
    expect(poller).toHaveBeenCalledWith(expect.not.objectContaining({ workerId: expect.anything() }));
  });
});
