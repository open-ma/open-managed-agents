import { describe, expect, it, vi } from "vitest";

vi.mock("@daytona/sdk", () => { throw new Error("current missing"); });

describe("Daytona legacy SDK fallback", () => {
  it("loads the deprecated peer while migrating", async () => {
    const { createDaytonaManagedRuntime } = await import("../src/daytona");
    await expect(createDaytonaManagedRuntime({
      environmentId: "environment",
      leaseTtlMs: 100,
      image: "image",
    }))
      .resolves.toBeDefined();
  });
});
