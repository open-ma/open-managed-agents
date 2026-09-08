import { describe, expect, it } from "vitest";

const adapterSources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("Managed Agents SQL adapter boundary", () => {
  it("depends only on inner Ports and the runtime-neutral SQL client", () => {
    expect(Object.keys(adapterSources).sort()).toEqual([
      "../src/agents-sql-persistence.ts",
      "../src/credential-document-cipher.ts",
      "../src/credential-vault-sql-source.ts",
      "../src/credentials-sql-persistence.ts",
      "../src/deployment-agent-sql-source.ts",
      "../src/deployment-resource-secret-cipher.ts",
      "../src/deployment-runs-sql-persistence.ts",
      "../src/deployment-vault-sql-source.ts",
      "../src/deployments-sql-persistence.ts",
      "../src/dreams-sql-persistence.ts",
      "../src/environment-work-secret-cipher.ts",
      "../src/environment-work-sql-persistence.ts",
      "../src/environments-sql-persistence.ts",
      "../src/files-sql-persistence.ts",
      "../src/index.ts",
      "../src/managed-sessions-composition.ts",
      "../src/memories-sql-persistence.ts",
      "../src/memory-store-sql-source.ts",
      "../src/memory-stores-sql-persistence.ts",
      "../src/session-environment-sql-source.ts",
      "../src/session-event-polling-stream.ts",
      "../src/session-events-sql-persistence.ts",
      "../src/session-execution-context-sql-source.ts",
      "../src/session-resource-secret-sealer.ts",
      "../src/session-resources-sql-persistence.ts",
      "../src/session-runtime-history-sql-source.ts",
      "../src/session-runtime-projection-sql-persistence.ts",
      "../src/session-sql-source.ts",
      "../src/session-thread-context-sql-source.ts",
      "../src/session-thread-events-sql-persistence.ts",
      "../src/session-threads-sql-persistence.ts",
      "../src/sessions-sql-persistence.ts",
      "../src/skills-sql-persistence.ts",
      "../src/tunnels-sql-persistence.ts",
      "../src/user-profiles-sql-persistence.ts",
      "../src/vaults-sql-persistence.ts",
    ]);

    for (const source of Object.values(adapterSources)) {
      expect(source).not.toMatch(/@open-managed-agents\/managed-agents-api/);
      expect(source).not.toMatch(/@anthropic-ai\/sdk/);
      expect(source).not.toMatch(/from ["'](?:hono|zod)["']/);
      expect(source).not.toMatch(/from ["']drizzle-orm(?:\/[^"']*)?["']/);
      expect(source).not.toMatch(/@open-managed-agents\/db-schema/);
      expect(source).not.toMatch(/from ["'](?:better-sqlite3|postgres)["']/);
      expect(source).not.toMatch(/@cloudflare\/workers-types/);
    }
  });
});
