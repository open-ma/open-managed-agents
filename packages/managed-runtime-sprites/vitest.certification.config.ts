import { defineConfig } from "vitest/config";

// Deliberately has no @fly/sprites alias. The live certification lane must load
// the published SDK and must never be able to pass against the unit-test fake.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/sprites-certification.e2e.test.ts"],
  },
});
