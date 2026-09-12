import { describe, expect, it, vi } from "vitest";

vi.mock("@daytona/sdk", () => { throw new Error("current missing"); });
vi.mock("@daytonaio/sdk", () => { throw new Error("legacy missing"); });

describe("Daytona optional SDK failure", () => {
  it("reports both supported package names", async () => {
    const { createDaytonaManagedRuntime } = await import("../src/daytona");
    await expect(createDaytonaManagedRuntime({ environmentId: "environment", leaseTtlMs: 100 }))
      .rejects.toThrow("requires '@daytona/sdk'");
  });
});
