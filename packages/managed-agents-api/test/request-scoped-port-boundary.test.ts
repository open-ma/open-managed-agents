import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("../src/routes/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents HTTP application-port boundary", () => {
  it("resolves every application port from the current request context", () => {
    expect(Object.keys(routeSources).sort()).toEqual([
      "../src/routes/agents.ts",
      "../src/routes/credentials.ts",
      "../src/routes/deployment-runs.ts",
      "../src/routes/deployments.ts",
      "../src/routes/dreams.ts",
      "../src/routes/environment-work.ts",
      "../src/routes/environments.ts",
      "../src/routes/files.ts",
      "../src/routes/memories.ts",
      "../src/routes/memory-stores.ts",
      "../src/routes/memory-versions.ts",
      "../src/routes/models.ts",
      "../src/routes/session-events.ts",
      "../src/routes/session-outputs.ts",
      "../src/routes/session-resources.ts",
      "../src/routes/session-threads.ts",
      "../src/routes/sessions.ts",
      "../src/routes/skill-versions.ts",
      "../src/routes/skills.ts",
      "../src/routes/tunnel-certificates.ts",
      "../src/routes/tunnels.ts",
      "../src/routes/user-profiles.ts",
      "../src/routes/vaults.ts",
    ]);
    for (const [path, source] of Object.entries(routeSources)) {
      expect(source, path).toMatch(/resolveApplicationPort\(/);
      expect(source, path).not.toMatch(/build[A-Za-z]+Routes\(\s*port\s*:/);
    }
  });
});
