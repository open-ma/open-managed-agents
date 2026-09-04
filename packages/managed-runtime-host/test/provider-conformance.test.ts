import { describe, expect, it } from "vitest";

import {
  MANAGED_RUNTIME_PROVIDER_CONFORMANCE,
  getManagedRuntimeProviderConformance,
} from "../src/provider-conformance";

describe("managed runtime provider conformance", () => {
  it("keeps the shipped ManagedRuntimeHost presets distinct from legacy SandboxPort adapters", () => {
    expect(MANAGED_RUNTIME_PROVIDER_CONFORMANCE).toEqual([
      expect.objectContaining({
        id: "node-docker",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "cloudflare",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "e2b",
        status: "managed-runtime",
        driverLanes: ["ama_worker"],
      }),
      expect.objectContaining({ id: "daytona", status: "sandbox-port-only" }),
      expect.objectContaining({ id: "litebox", status: "sandbox-port-only" }),
      expect.objectContaining({ id: "boxrun", status: "sandbox-port-only" }),
    ]);
  });

  it("does not infer managed-runtime conformance from generic sandbox capabilities", () => {
    expect(getManagedRuntimeProviderConformance("daytona")).toMatchObject({
      status: "sandbox-port-only",
      managedRuntime: false,
      reason: expect.stringContaining("ManagedRuntimeHost composition"),
    });
    expect(getManagedRuntimeProviderConformance("boxrun")).toMatchObject({
      status: "sandbox-port-only",
      managedRuntime: false,
      workspace: { strategies: [] },
      outputs: { strategies: [] },
    });
  });

  it("fails closed for an unknown provider", () => {
    expect(() => getManagedRuntimeProviderConformance("unknown" as never))
      .toThrow(/Unknown managed runtime provider/);
  });
});
