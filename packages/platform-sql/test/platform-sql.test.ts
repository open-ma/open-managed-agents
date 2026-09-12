import { workspaceContextPort } from "@open-managed-agents/app/capabilities";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { describe, expect, it } from "vitest";

import { createSqlManagedAgentsApp, createSqlPlatform } from "../src/index";

describe("SQL platform composition", () => {
  it("is provider-neutral and resolves one app graph per workspace", () => {
    const resolved: string[] = [];
    const platform = createSqlPlatform({
      sql: ({ workspaceId }) => {
        resolved.push(workspaceId);
        return {} as SqlClient;
      },
    });

    const first = platform.app({ workspaceId: "workspace_a" });
    expect(platform.app({ workspaceId: "workspace_a" })).toBe(first);
    expect(platform.app({ workspaceId: "workspace_b" })).not.toBe(first);
    expect(resolved).toEqual(["workspace_a", "workspace_b"]);
  });

  it("creates uncached request graphs without any Cloudflare capability", () => {
    const first = createSqlManagedAgentsApp({
      workspaceId: "workspace_request",
      sql: {} as SqlClient,
    });
    const second = createSqlManagedAgentsApp({
      workspaceId: "workspace_request",
      sql: {} as SqlClient,
    });

    expect(first).not.toBe(second);
    expect(first.port(workspaceContextPort)).toEqual({ workspaceId: "workspace_request" });
  });
});
