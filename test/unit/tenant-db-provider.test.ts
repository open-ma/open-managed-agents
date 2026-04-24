// Unit tests for CfSharedAuthDbProvider — the killswitch fallback.
//
// MetaTableTenantDbProvider tests live in tenant-dbs-store-services.test.ts
// alongside the directory service it depends on.

import { describe, it, expect } from "vitest";
import { CfSharedAuthDbProvider } from "@open-managed-agents/tenant-db";

const fakeDb = (label: string) => ({ __label: label }) as unknown as D1Database;

describe("CfSharedAuthDbProvider (killswitch fallback)", () => {
  it("returns the shared AUTH_DB for any tenant id", async () => {
    const auth = fakeDb("AUTH_DB");
    const provider = new CfSharedAuthDbProvider(auth);
    expect(await provider.resolve("tenant_a")).toBe(auth);
    expect(await provider.resolve("tenant_b")).toBe(auth);
    expect(await provider.resolve("")).toBe(auth);
  });
});
