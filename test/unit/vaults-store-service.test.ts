// Unit tests for VaultService — drives the service against in-memory repo.
// Service-level behavior covered: CRUD, tenant isolation, archive vs delete,
// includeArchived semantics, exists check.

import { describe, it, expect } from "vitest";
import {
  VaultNotFoundError,
} from "@open-managed-agents/vaults-store";
import {
  ManualClock,
  createInMemoryVaultService,
} from "@open-managed-agents/vaults-store/test-fakes";

const TENANT = "tn_test_vaults";

describe("VaultService — create + read", () => {
  it("creates a vault and reads it back", async () => {
    const { service } = createInMemoryVaultService();
    const v = await service.create({ tenantId: TENANT, name: "primary" });
    expect(v.id).toMatch(/^vlt-/);
    expect(v.name).toBe("primary");
    expect(v.archived_at).toBeNull();
    const got = await service.get({ tenantId: TENANT, vaultId: v.id });
    expect(got?.id).toBe(v.id);
  });

  it("isolates vaults by tenant", async () => {
    const { service } = createInMemoryVaultService();
    await service.create({ tenantId: "tn_a", name: "a" });
    await service.create({ tenantId: "tn_b", name: "b" });
    expect((await service.list({ tenantId: "tn_a" })).length).toBe(1);
    expect((await service.list({ tenantId: "tn_b" })).length).toBe(1);
    expect(
      await service.get({ tenantId: "tn_a", vaultId: "non-existent" }),
    ).toBeNull();
  });

  it("returns null when reading a vault that doesn't exist", async () => {
    const { service } = createInMemoryVaultService();
    expect(
      await service.get({ tenantId: TENANT, vaultId: "missing" }),
    ).toBeNull();
  });

  it("exists() returns true for vaults in tenant, false otherwise", async () => {
    const { service } = createInMemoryVaultService();
    const v = await service.create({ tenantId: TENANT, name: "x" });
    expect(await service.exists({ tenantId: TENANT, vaultId: v.id })).toBe(true);
    expect(
      await service.exists({ tenantId: "wrong-tenant", vaultId: v.id }),
    ).toBe(false);
    expect(
      await service.exists({ tenantId: TENANT, vaultId: "missing" }),
    ).toBe(false);
  });
});

describe("VaultService — list + filter", () => {
  it("list excludes archived by default, includes when asked", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryVaultService({ clock });
    const a = await service.create({ tenantId: TENANT, name: "a" });
    await service.create({ tenantId: TENANT, name: "b" });
    clock.set(2000);
    await service.archive({ tenantId: TENANT, vaultId: a.id });
    expect((await service.list({ tenantId: TENANT })).length).toBe(1);
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: true })).length,
    ).toBe(2);
  });

  it("list orders by created_at ASC", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryVaultService({ clock });
    const first = await service.create({ tenantId: TENANT, name: "first" });
    clock.set(2000);
    const second = await service.create({ tenantId: TENANT, name: "second" });
    const list = await service.list({ tenantId: TENANT });
    expect(list.map((v) => v.id)).toEqual([first.id, second.id]);
  });
});

describe("VaultService — update", () => {
  it("renames a vault and bumps updated_at", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryVaultService({ clock });
    const v = await service.create({ tenantId: TENANT, name: "old" });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      vaultId: v.id,
      name: "new",
    });
    expect(updated.name).toBe("new");
    expect(updated.updated_at).not.toBeNull();
  });

  it("update on missing vault throws VaultNotFoundError", async () => {
    const { service } = createInMemoryVaultService();
    await expect(() =>
      service.update({ tenantId: TENANT, vaultId: "missing", name: "x" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe("VaultService — archive", () => {
  it("archive sets archived_at without removing the row", async () => {
    const clock = new ManualClock(5000);
    const { service } = createInMemoryVaultService({ clock });
    const v = await service.create({ tenantId: TENANT, name: "x" });
    const archived = await service.archive({
      tenantId: TENANT,
      vaultId: v.id,
    });
    expect(archived.archived_at).not.toBeNull();
    // Default list excludes archived; getting by id still works.
    expect(
      await service.get({ tenantId: TENANT, vaultId: v.id }),
    ).not.toBeNull();
    expect((await service.list({ tenantId: TENANT })).length).toBe(0);
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: true })).length,
    ).toBe(1);
  });

  it("archive on missing vault throws VaultNotFoundError", async () => {
    const { service } = createInMemoryVaultService();
    await expect(() =>
      service.archive({ tenantId: TENANT, vaultId: "missing" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe("VaultService — delete", () => {
  it("delete removes the row entirely", async () => {
    const { service } = createInMemoryVaultService();
    const v = await service.create({ tenantId: TENANT, name: "x" });
    await service.delete({ tenantId: TENANT, vaultId: v.id });
    expect(
      await service.get({ tenantId: TENANT, vaultId: v.id }),
    ).toBeNull();
  });

  it("delete on missing vault throws VaultNotFoundError", async () => {
    const { service } = createInMemoryVaultService();
    await expect(() =>
      service.delete({ tenantId: TENANT, vaultId: "missing" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  it("delete is tenant-scoped (cross-tenant delete is no-op silent)", async () => {
    const { service } = createInMemoryVaultService();
    const v = await service.create({ tenantId: "tn_a", name: "a" });
    // delete from wrong tenant must throw NotFound (don't leak existence)
    await expect(() =>
      service.delete({ tenantId: "tn_b", vaultId: v.id }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    // vault still exists for owning tenant
    expect(
      await service.get({ tenantId: "tn_a", vaultId: v.id }),
    ).not.toBeNull();
  });
});
