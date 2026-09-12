import { describe, expect, it, vi } from "vitest";

import {
  renewVercelSandboxLease,
  type VercelSandboxSdkPort,
} from "../src/index";

function sandbox(input: {
  status?: string;
  expiresAt?: Date;
} = {}): VercelSandboxSdkPort {
  return {
    name: "sandbox",
    status: input.status ?? "running",
    persistent: true,
    tags: {},
    currentSnapshotId: undefined,
    expiresAt: input.expiresAt,
    extendTimeout: vi.fn(async () => undefined),
  } as unknown as VercelSandboxSdkPort;
}

describe("renewVercelSandboxLease", () => {
  it("extends only the missing lease duration and forwards cancellation", async () => {
    const value = sandbox({ expiresAt: new Date(40_000) });
    const signal = new AbortController().signal;

    await renewVercelSandboxLease({
      sandbox: value,
      ttlMs: 90_000,
      now: () => 10_000,
      signal,
    });

    expect(value.extendTimeout).toHaveBeenCalledWith(60_000, { signal });
  });

  it("does not shorten a sufficient lease", async () => {
    const value = sandbox({ expiresAt: new Date(120_000) });
    await renewVercelSandboxLease({ sandbox: value, ttlMs: 90_000, now: () => 10_000 });
    expect(value.extendTimeout).not.toHaveBeenCalled();
  });

  it("handles an unreported expiry and the default clock", async () => {
    const value = sandbox();
    await renewVercelSandboxLease({ sandbox: value, ttlMs: 1 });
    expect(value.extendTimeout).toHaveBeenCalledWith(1);
  });

  it("rejects invalid, stopped, expired, and cancelled renewals", async () => {
    await expect(renewVercelSandboxLease({ sandbox: sandbox(), ttlMs: 0 }))
      .rejects.toThrow("positive finite");
    await expect(renewVercelSandboxLease({ sandbox: sandbox({ status: "failed" }), ttlMs: 1 }))
      .rejects.toThrow("no longer available");
    await expect(renewVercelSandboxLease({
      sandbox: sandbox({ expiresAt: new Date(10_000) }),
      ttlMs: 1,
      now: () => 10_000,
    })).rejects.toThrow("no longer available");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(renewVercelSandboxLease({
      sandbox: sandbox(),
      ttlMs: 1,
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
  });

  it("observes cancellation after the provider extension", async () => {
    const controller = new AbortController();
    const value = sandbox();
    vi.mocked(value.extendTimeout).mockImplementation(async () => {
      controller.abort(new Error("cancelled after extension"));
    });

    await expect(renewVercelSandboxLease({
      sandbox: value,
      ttlMs: 1,
      signal: controller.signal,
    })).rejects.toThrow("cancelled after extension");
  });
});
