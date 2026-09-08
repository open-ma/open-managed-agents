import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed runtime adapter boundary", () => {
  it("depends only on v1 application and interface packages", () => {
    expect(Object.keys(sources).sort()).toEqual([
      "../src/anthropic-messages-dream-curator.ts",
      "../src/application-dream-memory-workspace.ts",
      "../src/configured-model-catalog.ts",
      "../src/configured-model-module.ts",
      "../src/credential-validation-probe.ts",
      "../src/deduplicating-dream-curator.ts",
      "../src/deployment-schedule-planner.ts",
      "../src/environment-work-availability-waiter.ts",
      "../src/environment-work-runtime-ingress.ts",
      "../src/environment-work-session-credential-issuer.ts",
      "../src/environment-work-session-token.ts",
      "../src/environment-work-webhook-wakeup.ts",
      "../src/in-process-dream-execution-scheduler.ts",
      "../src/index.ts",
      "../src/local-tunnel-provisioner.ts",
      "../src/memory-content-descriptor.ts",
      "../src/model-card-catalog.ts",
      "../src/session-lifecycle-router.ts",
      "../src/skill-package-compiler.ts",
      "../src/webcrypto-tunnel-certificate-authority.ts",
      "../src/webcrypto-tunnel-token-manager.ts",
    ]);
    for (const source of Object.values(sources)) {
      expect(source).toContain("@open-managed-agents/managed-agents-application");
      expect(source).not.toMatch(/@open-managed-agents\/(?:managed-agents-api|session-runtime(?!-contract)|shared|services|.*-store)/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk|hono|zod|drizzle-orm/);
    }
  });
});
