import { describe, expect, it } from "vitest";

import {
  MANAGED_RUNTIME_PROVIDER_CONFORMANCE,
  getManagedRuntimeProviderConformance,
  requireManagedRuntimeProvider,
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
        id: "cloudflare-bridge",
        status: "managed-runtime",
        driverLanes: ["ama_worker"],
      }),
      expect.objectContaining({
        id: "e2b",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "daytona",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "litebox",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "boxrun",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "blaxel",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "sprites",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "vercel",
        status: "managed-runtime",
        driverLanes: ["ama_worker"],
      }),
      expect.objectContaining({
        id: "modal",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
      expect.objectContaining({
        id: "superserve",
        status: "managed-runtime",
        driverLanes: ["ama_worker", "openma_supervised"],
      }),
    ]);
  });

  it("does not infer managed-runtime conformance from generic sandbox capabilities", () => {
    expect(getManagedRuntimeProviderConformance("daytona")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
      workspace: {
        strategies: ["retained_runtime", "checkpoint_restore"],
        durability: "durable",
      },
    });
    expect(getManagedRuntimeProviderConformance("boxrun")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "best_effort",
      },
      outputs: {
        strategies: ["final_collect"],
        durability: "durable",
      },
    });
    expect(getManagedRuntimeProviderConformance("blaxel")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "best_effort",
      },
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
    });
    expect(getManagedRuntimeProviderConformance("sprites")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "durable",
      },
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
      runtimeCheckpoints: [],
    });
    expect(getManagedRuntimeProviderConformance("vercel")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "durable",
      },
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
      runtimeCheckpoints: [],
    });
    expect(getManagedRuntimeProviderConformance("modal")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "durable",
      },
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
      runtimeCheckpoints: [],
    });
    expect(getManagedRuntimeProviderConformance("superserve")).toMatchObject({
      status: "managed-runtime",
      managedRuntime: true,
      workspace: {
        strategies: ["retained_runtime"],
        durability: "durable",
      },
      lifecycle: {
        lease: "host-fenced",
        suspendResume: "supported",
        hardTerminate: "supported",
        orphanReap: "host-managed",
      },
      runtimeCheckpoints: [],
    });
  });

  it("fails closed for an unknown provider", () => {
    expect(() => getManagedRuntimeProviderConformance("unknown" as never))
      .toThrow(/Unknown managed runtime provider/);
  });

  it("admits only providers with a complete managed-runtime composition", () => {
    expect(requireManagedRuntimeProvider("e2b")).toMatchObject({
      id: "e2b",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("daytona")).toMatchObject({
      id: "daytona",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("litebox")).toMatchObject({
      id: "litebox",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("boxrun")).toMatchObject({
      id: "boxrun",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("blaxel")).toMatchObject({
      id: "blaxel",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("sprites")).toMatchObject({
      id: "sprites",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("vercel")).toMatchObject({
      id: "vercel",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("modal")).toMatchObject({
      id: "modal",
      managedRuntime: true,
    });
    expect(requireManagedRuntimeProvider("superserve")).toMatchObject({
      id: "superserve",
      managedRuntime: true,
    });
  });
});
