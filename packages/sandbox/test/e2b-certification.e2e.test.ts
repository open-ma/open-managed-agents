import { describe, expect, it } from "vitest";

import { createE2BSandbox } from "../src/adapters/e2b";

const certificationEnabled = process.env.OMA_E2B_CERTIFICATION === "1";
const apiKey = process.env.OMA_E2B_E2E_API_KEY ?? process.env.E2B_API_KEY;

describe.skipIf(!certificationEnabled)("E2B credentialed certification", () => {
  it("runs a real sandbox through exec, lease renewal, suspend/resume and snapshot", async () => {
    if (!apiKey) {
      throw new Error(
        "E2B certification requires OMA_E2B_E2E_API_KEY or E2B_API_KEY",
      );
    }
    const sandbox = await createE2BSandbox({
      apiKey,
      apiUrl: process.env.E2B_API_URL,
      templateId: process.env.OMA_E2B_TEMPLATE ?? "base",
      defaultTimeoutMs: 60_000,
    });
    try {
      await expect(sandbox.exec("printf e2b-certification")).resolves.toContain(
        "e2b-certification",
      );
      await sandbox.renewLease({ ttlMs: 120_000 });
      const suspended = await sandbox.suspend({ kind: "memory" });
      expect(suspended).toMatchObject({
        provider: "e2b",
        scope: "runtime",
        kind: "memory",
      });
      await sandbox.resume(suspended);
      await expect(sandbox.exec("printf resumed")).resolves.toContain("resumed");
      const checkpoint = await sandbox.checkpoint({
        kind: "memory",
        name: `oma-certification-${Date.now()}`,
      });
      expect(checkpoint).toMatchObject({
        provider: "e2b",
        scope: "portable",
        kind: "memory",
      });
    } finally {
      await sandbox.destroy();
    }
  }, 180_000);
});
