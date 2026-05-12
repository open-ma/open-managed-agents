// Unit tests for EnvironmentService — drives the service against in-memory repo.
// Service-level behavior covered: CRUD, tenant isolation, archive vs delete,
// includeArchived semantics, status transitions, build_error clear semantics,
// description/metadata null handling, sandbox_worker_name updates,
// toEnvironmentConfig conversion.
//
// NOTE: relative imports — the vitest alias for `@open-managed-agents/environments-store`
// gets added by the integrator (see INTEGRATION_GUIDE.md step 2). After that lands,
// these can be flipped to package-name imports for consistency with the
// credentials-store test (cosmetic — not blocking).

import { describe, it, expect } from "vitest";
import {
  EnvironmentNotFoundError,
  toEnvironmentConfig,
} from "../../packages/environments-store/src/index";
import {
  ManualClock,
  createInMemoryEnvironmentService,
} from "../../packages/environments-store/src/test-fakes";

const TENANT = "tn_test_envs";

const baseConfig = { type: "cloud" as const };

describe("EnvironmentService — create + read", () => {
  it("creates an environment with defaults and reads it back", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "primary",
      config: baseConfig,
    });
    expect(env.id).toMatch(/^env-/);
    expect(env.name).toBe("primary");
    expect(env.status).toBe("ready");
    expect(env.description).toBeNull();
    expect(env.sandbox_worker_name).toBeNull();
    expect(env.build_error).toBeNull();
    expect(env.metadata).toBeNull();
    expect(env.archived_at).toBeNull();
    expect(env.updated_at).toBeNull();

    const got = await service.get({ tenantId: TENANT, environmentId: env.id });
    expect(got?.id).toBe(env.id);
    expect(got?.config).toEqual(baseConfig);
  });

  it("creates with explicit status and sandbox_worker_name", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "with-worker",
      description: "running on the shared default worker",
      status: "ready",
      sandboxWorkerName: "sandbox-default",
      config: baseConfig,
      metadata: { source: "test" },
    });
    expect(env.status).toBe("ready");
    expect(env.sandbox_worker_name).toBe("sandbox-default");
    expect(env.description).toBe("running on the shared default worker");
    expect(env.metadata).toEqual({ source: "test" });
  });

  it("creates a 'building' environment for the GitHub-Actions path", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "needs-build",
      status: "building",
      config: { type: "cloud", packages: { pip: ["pandas"] } },
    });
    expect(env.status).toBe("building");
    expect(env.sandbox_worker_name).toBeNull();
    expect(env.build_error).toBeNull();
  });

  it("isolates environments by tenant", async () => {
    const { service } = createInMemoryEnvironmentService();
    const a = await service.create({ tenantId: "tn_a", name: "a", config: baseConfig });
    await service.create({ tenantId: "tn_b", name: "b", config: baseConfig });

    expect((await service.list({ tenantId: "tn_a" })).length).toBe(1);
    expect((await service.list({ tenantId: "tn_b" })).length).toBe(1);

    // Cross-tenant get is null even though id is unique
    expect(
      await service.get({ tenantId: "tn_b", environmentId: a.id }),
    ).toBeNull();
  });

  it("returns null when reading an environment that doesn't exist", async () => {
    const { service } = createInMemoryEnvironmentService();
    expect(
      await service.get({ tenantId: TENANT, environmentId: "missing" }),
    ).toBeNull();
  });
});

describe("EnvironmentService — list + filter", () => {
  it("list defaults to includeArchived=true (matches historical KV)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEnvironmentService({ clock });
    const a = await service.create({ tenantId: TENANT, name: "a", config: baseConfig });
    await service.create({ tenantId: TENANT, name: "b", config: baseConfig });
    clock.set(2000);
    await service.archive({ tenantId: TENANT, environmentId: a.id });

    // Default includes archived (the route layer can opt out)
    expect((await service.list({ tenantId: TENANT })).length).toBe(2);
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: false })).length,
    ).toBe(1);
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: true })).length,
    ).toBe(2);
  });

  it("list orders by created_at ASC", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEnvironmentService({ clock });
    const first = await service.create({
      tenantId: TENANT,
      name: "first",
      config: baseConfig,
    });
    clock.set(2000);
    const second = await service.create({
      tenantId: TENANT,
      name: "second",
      config: baseConfig,
    });
    const list = await service.list({ tenantId: TENANT });
    expect(list.map((v) => v.id)).toEqual([first.id, second.id]);
  });
});

describe("EnvironmentService — update", () => {
  it("renames an environment and bumps updated_at", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEnvironmentService({ clock });
    const env = await service.create({
      tenantId: TENANT,
      name: "old",
      config: baseConfig,
    });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      name: "new",
    });
    expect(updated.name).toBe("new");
    expect(updated.updated_at).not.toBeNull();
  });

  it("updates status and sandbox_worker_name (build-complete flow)", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "builds",
      status: "building",
      config: baseConfig,
    });
    const updated = await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      status: "ready",
      sandboxWorkerName: `sandbox-${env.id}`,
    });
    expect(updated.status).toBe("ready");
    expect(updated.sandbox_worker_name).toBe(`sandbox-${env.id}`);
    expect(updated.build_error).toBeNull();
  });

  it("clears build_error explicitly when passed null (re-build path)", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "fail-then-rebuild",
      status: "error",
      config: baseConfig,
    });
    // First mark with an error
    await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      buildError: "build failed: missing pkg",
    });
    let row = await service.get({ tenantId: TENANT, environmentId: env.id });
    expect(row?.build_error).toBe("build failed: missing pkg");

    // PUT mutates config — route flips status back to "building" + clears worker + error.
    await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      status: "building",
      sandboxWorkerName: null,
      buildError: null,
    });
    row = await service.get({ tenantId: TENANT, environmentId: env.id });
    expect(row?.status).toBe("building");
    expect(row?.sandbox_worker_name).toBeNull();
    expect(row?.build_error).toBeNull();
  });

  it("updates config networking field", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "net-tweak",
      config: {
        type: "cloud",
        networking: { type: "limited", allowed_hosts: ["api.example.com"] },
      },
    });
    const updated = await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      config: {
        type: "cloud",
        networking: { type: "unrestricted", allow_mcp_servers: true },
      },
    });
    expect(updated.config.networking?.type).toBe("unrestricted");
    expect(updated.config.networking?.allow_mcp_servers).toBe(true);
    expect(updated.config.networking?.allowed_hosts).toBeUndefined();
  });

  it("update on missing environment throws EnvironmentNotFoundError", async () => {
    const { service } = createInMemoryEnvironmentService();
    await expect(() =>
      service.update({
        tenantId: TENANT,
        environmentId: "missing",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
  });

  it("update leaves untouched fields when omitted (undefined)", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "keep-fields",
      description: "original desc",
      sandboxWorkerName: "sandbox-keepme",
      config: baseConfig,
      metadata: { src: "test" },
    });
    const updated = await service.update({
      tenantId: TENANT,
      environmentId: env.id,
      name: "renamed",
    });
    expect(updated.name).toBe("renamed");
    expect(updated.description).toBe("original desc");
    expect(updated.sandbox_worker_name).toBe("sandbox-keepme");
    expect(updated.metadata).toEqual({ src: "test" });
  });
});

describe("EnvironmentService — archive", () => {
  it("archive sets archived_at without removing the row", async () => {
    const clock = new ManualClock(5000);
    const { service } = createInMemoryEnvironmentService({ clock });
    const env = await service.create({
      tenantId: TENANT,
      name: "x",
      config: baseConfig,
    });
    const archived = await service.archive({
      tenantId: TENANT,
      environmentId: env.id,
    });
    expect(archived.archived_at).not.toBeNull();
    // Get still works on archived rows (matches historical KV)
    expect(
      await service.get({ tenantId: TENANT, environmentId: env.id }),
    ).not.toBeNull();
    // Default list returns everything
    expect((await service.list({ tenantId: TENANT })).length).toBe(1);
    // Filtered list hides archived
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: false })).length,
    ).toBe(0);
  });

  it("archive on missing environment throws EnvironmentNotFoundError", async () => {
    const { service } = createInMemoryEnvironmentService();
    await expect(() =>
      service.archive({ tenantId: TENANT, environmentId: "missing" }),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
  });
});

describe("EnvironmentService — delete", () => {
  it("delete removes the row entirely", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: TENANT,
      name: "x",
      config: baseConfig,
    });
    await service.delete({ tenantId: TENANT, environmentId: env.id });
    expect(
      await service.get({ tenantId: TENANT, environmentId: env.id }),
    ).toBeNull();
  });

  it("delete on missing environment throws EnvironmentNotFoundError", async () => {
    const { service } = createInMemoryEnvironmentService();
    await expect(() =>
      service.delete({ tenantId: TENANT, environmentId: "missing" }),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
  });

  it("delete is tenant-scoped (cross-tenant delete throws NotFound)", async () => {
    const { service } = createInMemoryEnvironmentService();
    const env = await service.create({
      tenantId: "tn_a",
      name: "a",
      config: baseConfig,
    });
    // delete from wrong tenant must throw NotFound (don't leak existence)
    await expect(() =>
      service.delete({ tenantId: "tn_b", environmentId: env.id }),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
    // env still exists for owning tenant
    expect(
      await service.get({ tenantId: "tn_a", environmentId: env.id }),
    ).not.toBeNull();
  });
});

describe("toEnvironmentConfig — API shape conversion", () => {
  it("strips tenant_id and elides null fields to match historical KV shape", async () => {
    const { service } = createInMemoryEnvironmentService();
    const row = await service.create({
      tenantId: TENANT,
      name: "snap",
      config: baseConfig,
    });
    const cfg = toEnvironmentConfig(row);
    expect((cfg as Record<string, unknown>).tenant_id).toBeUndefined();
    expect(cfg.id).toBe(row.id);
    expect(cfg.name).toBe("snap");
    // Null columns become absent — never `null` in the API shape
    expect("description" in cfg).toBe(false);
    expect("sandbox_worker_name" in cfg).toBe(false);
    expect("build_error" in cfg).toBe(false);
    expect("metadata" in cfg).toBe(false);
    expect("updated_at" in cfg).toBe(false);
    expect("archived_at" in cfg).toBe(false);
  });

  it("preserves all populated fields", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEnvironmentService({ clock });
    const created = await service.create({
      tenantId: TENANT,
      name: "full",
      description: "desc",
      sandboxWorkerName: "sandbox-x",
      config: baseConfig,
      metadata: { src: "test" },
    });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      environmentId: created.id,
      buildError: "boom",
    });
    const cfg = toEnvironmentConfig(updated);
    expect(cfg.description).toBe("desc");
    // sandbox_worker_name + build_error were dropped from the public API
    // shape by the AMA wire alignment (PR #55) — toEnvironmentConfig now
    // only surfaces the fields Anthropic's BetaEnvironment exposes.
    expect(cfg.metadata).toEqual({ src: "test" });
    expect(cfg.updated_at).not.toBeUndefined();
  });
});
