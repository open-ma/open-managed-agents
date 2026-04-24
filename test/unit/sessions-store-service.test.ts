// Unit tests for SessionService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: tenant isolation, list-by-agent semantics,
// archive vs delete, agent-delete cascade, session→resources cascade,
// per-session resource quota (100), per-session memory_store sub-cap (8),
// metadata merge semantics, snapshot JSON round-trip, cross-tenant getById,
// hasActiveByAgent / hasActiveByEnvironment safety checks.
//
// NOTE: imports use relative paths because vitest.config.ts has not yet been
// updated with the @open-managed-agents/sessions-store alias (that's done at
// integration time per packages/sessions-store/INTEGRATION_GUIDE.md). After
// the alias lands, these can be swapped to the package import to match the
// credentials-store test style.

import { describe, it, expect } from "vitest";
import type {
  AgentConfig,
  EnvironmentConfig,
  SessionResource,
} from "@open-managed-agents/shared";
import {
  MAX_MEMORY_STORE_RESOURCES_PER_SESSION,
  MAX_RESOURCES_PER_SESSION,
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
} from "../../packages/sessions-store/src/index";
import {
  ManualClock,
  createInMemorySessionService,
} from "../../packages/sessions-store/src/test-fakes";

const TENANT = "tn_test_sess";
const AGENT = "agent-a";
const ENV_ID = "env-a";

function fileResource(file_id: string, mount_path?: string): Omit<SessionResource, "id" | "session_id" | "created_at"> {
  return { type: "file", file_id, mount_path };
}

function memoryStoreResource(memory_store_id: string): Omit<SessionResource, "id" | "session_id" | "created_at"> {
  return { type: "memory_store", memory_store_id, access: "read_write" };
}

function ghResource(url: string): Omit<SessionResource, "id" | "session_id" | "created_at"> {
  return { type: "github_repository", url, repo_url: url, mount_path: "/workspace" };
}

const SAMPLE_AGENT_SNAPSHOT: AgentConfig = {
  id: AGENT,
  name: "test agent",
  model: "claude-sonnet-4-5",
  system: "you are helpful",
  tools: [],
  version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
};

const SAMPLE_ENV_SNAPSHOT: EnvironmentConfig = {
  id: ENV_ID,
  name: "test env",
  created_at: "2026-01-01T00:00:00.000Z",
} as EnvironmentConfig;

describe("SessionService — create + read", () => {
  it("creates a session and reads it back", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      title: "demo",
    });
    expect(session.id).toMatch(/^sess-/);
    expect(session.tenant_id).toBe(TENANT);
    expect(session.title).toBe("demo");
    expect(session.status).toBe("idle");
    expect(session.archived_at).toBeNull();

    const got = await service.get({ tenantId: TENANT, sessionId: session.id });
    expect(got?.id).toBe(session.id);
  });

  it("isolates sessions by tenant", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    expect(await service.get({ tenantId: "tn_a", sessionId: session.id })).not.toBeNull();
    expect(await service.get({ tenantId: "tn_b", sessionId: session.id })).toBeNull();
  });

  it("getById crosses tenants — replaces sidx: reverse index", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    const got = await service.getById({ sessionId: session.id });
    expect(got?.tenant_id).toBe("tn_a");
  });

  it("returns null when reading a session that doesn't exist", async () => {
    const { service } = createInMemorySessionService();
    expect(await service.get({ tenantId: TENANT, sessionId: "missing" })).toBeNull();
    expect(await service.getById({ sessionId: "missing" })).toBeNull();
  });

  it("round-trips agent_snapshot, environment_snapshot, vault_ids, metadata", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      vaultIds: ["vlt-1", "vlt-2"],
      agentSnapshot: SAMPLE_AGENT_SNAPSHOT,
      environmentSnapshot: SAMPLE_ENV_SNAPSHOT,
      metadata: { linear: { mcp_token: "abc" }, source: "webhook" },
    });
    const got = await service.get({ tenantId: TENANT, sessionId: session.id });
    expect(got?.vault_ids).toEqual(["vlt-1", "vlt-2"]);
    expect(got?.agent_snapshot?.name).toBe("test agent");
    expect(got?.environment_snapshot?.name).toBe("test env");
    expect((got?.metadata as { linear: { mcp_token: string } }).linear.mcp_token).toBe(
      "abc",
    );
  });
});

describe("SessionService — list", () => {
  it("filters list by agent_id (indexed path)", async () => {
    const { service } = createInMemorySessionService();
    await service.create({ tenantId: TENANT, agentId: "agent-a", environmentId: ENV_ID });
    await service.create({ tenantId: TENANT, agentId: "agent-a", environmentId: ENV_ID });
    await service.create({ tenantId: TENANT, agentId: "agent-b", environmentId: ENV_ID });

    const allA = await service.list({ tenantId: TENANT, agentId: "agent-a" });
    expect(allA.length).toBe(2);
    expect(allA.every((s) => s.agent_id === "agent-a")).toBe(true);

    const allB = await service.list({ tenantId: TENANT, agentId: "agent-b" });
    expect(allB.length).toBe(1);
  });

  it("excludes archived sessions by default and includes them when requested", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemorySessionService({ clock });
    const { session: a } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    clock.set(2000);
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    await service.archive({ tenantId: TENANT, sessionId: a.id });

    const visible = await service.list({ tenantId: TENANT });
    expect(visible.length).toBe(1);
    expect(visible[0].archived_at).toBeNull();

    const all = await service.list({ tenantId: TENANT, includeArchived: true });
    expect(all.length).toBe(2);
  });

  it("respects order option (default desc)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemorySessionService({ clock });
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID, title: "first" });
    clock.set(2000);
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID, title: "second" });

    const desc = await service.list({ tenantId: TENANT });
    expect(desc.map((s) => s.title)).toEqual(["second", "first"]);

    const asc = await service.list({ tenantId: TENANT, order: "asc" });
    expect(asc.map((s) => s.title)).toEqual(["first", "second"]);
  });

  it("respects limit", async () => {
    const { service } = createInMemorySessionService();
    for (let i = 0; i < 5; i++) {
      await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    }
    const got = await service.list({ tenantId: TENANT, limit: 3 });
    expect(got.length).toBe(3);
  });
});

describe("SessionService — update", () => {
  it("merges metadata per-key with null-deletes", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemorySessionService({ clock });
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      metadata: { keep: 1, drop_me: "x" },
    });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      sessionId: session.id,
      metadata: { drop_me: null, added: "y" },
    });
    expect(updated.metadata).toEqual({ keep: 1, added: "y" });
    expect(updated.updated_at).not.toBeNull();
  });

  it("updates title without touching metadata", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      title: "old",
      metadata: { stays: true },
    });
    const updated = await service.update({
      tenantId: TENANT,
      sessionId: session.id,
      title: "new",
    });
    expect(updated.title).toBe("new");
    expect(updated.metadata).toEqual({ stays: true });
  });

  it("throws SessionNotFoundError for missing id", async () => {
    const { service } = createInMemorySessionService();
    await expect(
      service.update({ tenantId: TENANT, sessionId: "missing", title: "x" }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("updateStatus bumps status + updated_at", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemorySessionService({ clock });
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    clock.set(2000);
    const updated = await service.updateStatus({
      tenantId: TENANT,
      sessionId: session.id,
      status: "running",
    });
    expect(updated.status).toBe("running");
    expect(updated.updated_at).not.toBeNull();
  });
});

describe("SessionService — archive vs delete", () => {
  it("archive sets archived_at without removing the row", async () => {
    const clock = new ManualClock(5000);
    const { service } = createInMemorySessionService({ clock });
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    const archived = await service.archive({ tenantId: TENANT, sessionId: session.id });
    expect(archived.archived_at).not.toBeNull();
    // Still visible via includeArchived
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: true })).length,
    ).toBe(1);
    // Hidden by default
    expect((await service.list({ tenantId: TENANT })).length).toBe(0);
  });

  it("delete removes the row entirely", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    await service.delete({ tenantId: TENANT, sessionId: session.id });
    expect(await service.get({ tenantId: TENANT, sessionId: session.id })).toBeNull();
    // Cross-tenant lookup also gone
    expect(await service.getById({ sessionId: session.id })).toBeNull();
  });

  it("delete cascades to session_resources", async () => {
    const { service, repo } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1"), memoryStoreResource("memstore-1")],
    });
    expect((await repo.listResources(session.id)).length).toBe(2);

    await service.delete({ tenantId: TENANT, sessionId: session.id });
    expect((await repo.listResources(session.id)).length).toBe(0);
  });
});

describe("SessionService — deleteByAgent cascade", () => {
  it("removes every session for an agent in tenant + their resources", async () => {
    const { service, repo } = createInMemorySessionService();
    const { session: s1 } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1")],
    });
    const { session: s2 } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [memoryStoreResource("memstore-2")],
    });
    // Same agent in another tenant — must NOT be touched
    const { session: s3 } = await service.create({
      tenantId: "tn_other",
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-3")],
    });
    // Different agent in same tenant — must NOT be touched
    const { session: s4 } = await service.create({
      tenantId: TENANT,
      agentId: "agent-other",
      environmentId: ENV_ID,
    });

    const deleted = await service.deleteByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(deleted).toBe(2);
    expect(await service.get({ tenantId: TENANT, sessionId: s1.id })).toBeNull();
    expect(await service.get({ tenantId: TENANT, sessionId: s2.id })).toBeNull();
    expect(await service.get({ tenantId: "tn_other", sessionId: s3.id })).not.toBeNull();
    expect(await service.get({ tenantId: TENANT, sessionId: s4.id })).not.toBeNull();
    // Resources for deleted sessions also gone, cross-tenant resource preserved
    expect((await repo.listResources(s1.id)).length).toBe(0);
    expect((await repo.listResources(s2.id)).length).toBe(0);
    expect((await repo.listResources(s3.id)).length).toBe(1);
  });

  it("returns 0 when no sessions for the agent exist", async () => {
    const { service } = createInMemorySessionService();
    expect(await service.deleteByAgent({ tenantId: TENANT, agentId: "ghost" })).toBe(0);
  });
});

describe("SessionService — safety checks (hasActive*)", () => {
  it("hasActiveByAgent returns true while any non-archived session exists", async () => {
    const { service } = createInMemorySessionService();
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(false);
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(true);
    await service.archive({ tenantId: TENANT, sessionId: session.id });
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(false);
  });

  it("hasActiveByEnvironment returns true while any non-archived session exists", async () => {
    const { service } = createInMemorySessionService();
    expect(
      await service.hasActiveByEnvironment({ tenantId: TENANT, environmentId: ENV_ID }),
    ).toBe(false);
    await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    expect(
      await service.hasActiveByEnvironment({ tenantId: TENANT, environmentId: ENV_ID }),
    ).toBe(true);
  });

  it("hasActiveByAgent does not leak cross-tenant", async () => {
    const { service } = createInMemorySessionService();
    await service.create({ tenantId: "tn_a", agentId: AGENT, environmentId: ENV_ID });
    expect(await service.hasActiveByAgent({ tenantId: "tn_b", agentId: AGENT })).toBe(false);
  });
});

describe("SessionService — resources", () => {
  it("creates session with initial resources atomically", async () => {
    const { service, repo } = createInMemorySessionService();
    const { session, resources } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1"), ghResource("https://github.com/o/r")],
    });
    expect(resources.length).toBe(2);
    expect(resources[0].session_id).toBe(session.id);
    expect(resources[0].resource.session_id).toBe(session.id);
    expect((await repo.listResources(session.id)).length).toBe(2);
  });

  it("addResource enforces per-session 100-resource cap", async () => {
    const { service, repo } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    // Backfill via repo to avoid the loop overhead in service.addResource
    for (let i = 0; i < MAX_RESOURCES_PER_SESSION; i++) {
      await repo.insertResource({
        id: `sesrsc-pre-${i}`,
        sessionId: session.id,
        createdAt: i,
        resource: {
          id: `sesrsc-pre-${i}`,
          session_id: session.id,
          type: "file",
          file_id: `file-${i}`,
          created_at: new Date(i).toISOString(),
        },
      });
    }
    await expect(
      service.addResource({
        tenantId: TENANT,
        sessionId: session.id,
        resource: fileResource("file-overflow"),
      }),
    ).rejects.toBeInstanceOf(SessionResourceMaxExceededError);
  });

  it("addResource enforces memory_store sub-cap (8)", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    for (let i = 0; i < MAX_MEMORY_STORE_RESOURCES_PER_SESSION; i++) {
      await service.addResource({
        tenantId: TENANT,
        sessionId: session.id,
        resource: memoryStoreResource(`memstore-${i}`),
      });
    }
    await expect(
      service.addResource({
        tenantId: TENANT,
        sessionId: session.id,
        resource: memoryStoreResource("memstore-overflow"),
      }),
    ).rejects.toBeInstanceOf(SessionMemoryStoreMaxExceededError);
    // file resources still allowed
    const file = await service.addResource({
      tenantId: TENANT,
      sessionId: session.id,
      resource: fileResource("file-after-mem-cap"),
    });
    expect(file.type).toBe("file");
  });

  it("create rejects if initial memory_store count exceeds sub-cap", async () => {
    const { service } = createInMemorySessionService();
    const tooMany = Array.from({ length: MAX_MEMORY_STORE_RESOURCES_PER_SESSION + 1 }, (_, i) =>
      memoryStoreResource(`memstore-${i}`),
    );
    await expect(
      service.create({
        tenantId: TENANT,
        agentId: AGENT,
        environmentId: ENV_ID,
        resources: tooMany,
      }),
    ).rejects.toBeInstanceOf(SessionMemoryStoreMaxExceededError);
  });

  it("addResource refuses against archived sessions", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    await service.archive({ tenantId: TENANT, sessionId: session.id });
    await expect(
      service.addResource({
        tenantId: TENANT,
        sessionId: session.id,
        resource: fileResource("file-1"),
      }),
    ).rejects.toBeInstanceOf(SessionArchivedError);
  });

  it("countActiveResources returns the indexed count for the quota check", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1"), fileResource("file-2"), memoryStoreResource("memstore-1")],
    });
    expect(await service.countActiveResources({ sessionId: session.id })).toBe(3);
  });

  it("listResourcesBySession reads without a tenant round-trip (SessionDO path)", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1"), memoryStoreResource("memstore-1")],
    });
    const out = await service.listResourcesBySession({ sessionId: session.id });
    expect(out.length).toBe(2);
    // Order is created_at ASC
    expect(out[0].type).toBe("file");
    expect(out[1].type).toBe("memory_store");
  });

  it("getResource verifies tenant ownership", async () => {
    const { service } = createInMemorySessionService();
    const { session, resources } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1")],
    });
    const r = await service.getResource({
      tenantId: TENANT,
      sessionId: session.id,
      resourceId: resources[0].id,
    });
    expect(r?.id).toBe(resources[0].id);
    // Cross-tenant access should fail at the session lookup
    await expect(
      service.getResource({
        tenantId: "tn_other",
        sessionId: session.id,
        resourceId: resources[0].id,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("deleteResource throws when resource doesn't exist", async () => {
    const { service } = createInMemorySessionService();
    const { session } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    await expect(
      service.deleteResource({
        tenantId: TENANT,
        sessionId: session.id,
        resourceId: "missing",
      }),
    ).rejects.toBeInstanceOf(SessionResourceNotFoundError);
  });

  it("deleteResource removes a single row, leaving siblings", async () => {
    const { service } = createInMemorySessionService();
    const { session, resources } = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      resources: [fileResource("file-1"), fileResource("file-2"), fileResource("file-3")],
    });
    await service.deleteResource({
      tenantId: TENANT,
      sessionId: session.id,
      resourceId: resources[1].id,
    });
    const left = await service.listResources({ tenantId: TENANT, sessionId: session.id });
    expect(left.length).toBe(2);
    expect(left.map((r) => r.id)).toEqual([resources[0].id, resources[2].id]);
  });
});
