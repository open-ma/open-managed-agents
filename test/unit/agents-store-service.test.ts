// Unit tests for AgentService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: tenant isolation, version bump on update,
// no-op skip when nothing changed, optimistic-concurrency check via
// expectedVersion, history snapshot atomicity, listVersions/getVersion
// (historical only — current row stays in `agents`), archive vs delete
// semantics, hard-delete cascade of history rows, getById cross-tenant
// lookup (for SessionDO fallback), metadata merge with per-key delete on
// null/"".
//
// NOTE: imports use relative paths because vitest.config.ts has not yet been
// updated with the @open-managed-agents/agents-store alias (that's done at
// integration time per packages/agents-store/INTEGRATION_GUIDE.md). After the
// alias lands, these can be swapped to package imports to match the
// credentials-store test style.

import { describe, it, expect } from "vitest";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
} from "../../packages/agents-store/src/index";
import {
  ManualClock,
  createInMemoryAgentService,
} from "../../packages/agents-store/src/test-fakes";

const TENANT = "tn_test_agents";

const SAMPLE_INPUT = {
  name: "test agent",
  model: "claude-sonnet-4-5" as const,
  system: "you are helpful",
};

describe("AgentService — create + read", () => {
  it("creates an agent at version 1 and reads it back", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    expect(a.id).toMatch(/^agent-/);
    expect(a.tenant_id).toBe(TENANT);
    expect(a.name).toBe("test agent");
    expect(a.system).toBe("you are helpful");
    expect(a.version).toBe(1);
    expect(a.archived_at).toBeUndefined();
    // Default tools applied when caller doesn't pass any (mirrors agents.ts:125).
    expect(a.tools).toEqual([{ type: "agent_toolset_20260401" }]);

    const got = await service.get({ tenantId: TENANT, agentId: a.id });
    expect(got?.id).toBe(a.id);
    expect(got?.version).toBe(1);
  });

  it("isolates agents by tenant", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: "tn_a", input: SAMPLE_INPUT });
    expect(await service.get({ tenantId: "tn_a", agentId: a.id })).not.toBeNull();
    expect(await service.get({ tenantId: "tn_b", agentId: a.id })).toBeNull();
  });

  it("returns null on missing agent", async () => {
    const { service } = createInMemoryAgentService();
    expect(await service.get({ tenantId: TENANT, agentId: "missing" })).toBeNull();
  });

  it("getById crosses tenants — replaces SessionDO CONFIG_KV fallback", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    const got = await service.getById({ agentId: a.id });
    expect(got?.id).toBe(a.id);
    expect(got?.tenant_id).toBe(TENANT);
  });

  it("create persists optional fields verbatim (mcp_servers, skills, callable_agents, metadata, aux_model)", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({
      tenantId: TENANT,
      input: {
        ...SAMPLE_INPUT,
        description: "a test agent",
        mcp_servers: [{ name: "fs", type: "url", url: "https://example.com" }],
        skills: [{ skill_id: "code", type: "skill" }],
        callable_agents: [{ type: "agent", id: "agent-other" }],
        metadata: { tag: "demo", priority: 1 },
        aux_model: "claude-haiku-4-5",
        appendable_prompts: ["prompt-a"],
      },
    });
    expect(a.description).toBe("a test agent");
    expect(a.mcp_servers).toEqual([{ name: "fs", type: "url", url: "https://example.com" }]);
    expect(a.skills).toEqual([{ skill_id: "code", type: "skill" }]);
    expect(a.callable_agents).toEqual([{ type: "agent", id: "agent-other" }]);
    expect(a.metadata).toEqual({ tag: "demo", priority: 1 });
    expect(a.aux_model).toBe("claude-haiku-4-5");
    expect(a.appendable_prompts).toEqual(["prompt-a"]);
  });
});

describe("AgentService — list + filter", () => {
  it("list orders by created_at ASC", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryAgentService({ clock });
    const first = await service.create({ tenantId: TENANT, input: { ...SAMPLE_INPUT, name: "first" } });
    clock.set(2000);
    const second = await service.create({ tenantId: TENANT, input: { ...SAMPLE_INPUT, name: "second" } });
    const list = await service.list({ tenantId: TENANT });
    expect(list.map((v) => v.id)).toEqual([first.id, second.id]);
  });

  it("list includes archived by default (matches legacy GET /v1/agents)", async () => {
    // The legacy route returned ALL agents regardless of archived state — only
    // the rendered "archived_at" surfaced the difference. Service mirrors that
    // (includeArchived defaults to true).
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    await service.archive({ tenantId: TENANT, agentId: a.id });
    expect((await service.list({ tenantId: TENANT })).length).toBe(1);
  });

  it("list({ includeArchived: false }) hides archived rows", async () => {
    const { service } = createInMemoryAgentService();
    const keep = await service.create({ tenantId: TENANT, input: { ...SAMPLE_INPUT, name: "keep" } });
    const drop = await service.create({ tenantId: TENANT, input: { ...SAMPLE_INPUT, name: "drop" } });
    await service.archive({ tenantId: TENANT, agentId: drop.id });
    const active = await service.list({ tenantId: TENANT, includeArchived: false });
    expect(active.map((a) => a.id)).toEqual([keep.id]);
  });
});

describe("AgentService — update", () => {
  it("update bumps version + writes prior to history", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryAgentService({ clock });
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    expect(a.version).toBe(1);
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      agentId: a.id,
      input: { name: "renamed" },
    });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("renamed");
    expect(updated.updated_at).toBe(new Date(2000).toISOString());

    // History captures the prior (v1) snapshot.
    const history = await service.listVersions({ tenantId: TENANT, agentId: a.id });
    expect(history.length).toBe(1);
    expect(history[0].version).toBe(1);
    expect(history[0].snapshot.name).toBe("test agent");
  });

  it("update is a no-op when nothing actually changed (no version bump)", async () => {
    // Mirrors agents.ts:236-248 — a PUT with the same fields returns the
    // existing row without rewriting it. Critical because the Console can
    // re-PUT on focus/blur and we don't want phantom version bumps.
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    const same = await service.update({
      tenantId: TENANT,
      agentId: a.id,
      input: { name: "test agent", system: "you are helpful" },
    });
    expect(same.version).toBe(1);
    const history = await service.listVersions({ tenantId: TENANT, agentId: a.id });
    expect(history.length).toBe(0);
  });

  it("update with expectedVersion mismatch throws AgentVersionMismatchError", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    await expect(() =>
      service.update({
        tenantId: TENANT,
        agentId: a.id,
        input: { name: "x" },
        expectedVersion: 99,
      }),
    ).rejects.toBeInstanceOf(AgentVersionMismatchError);
  });

  it("update with matching expectedVersion succeeds + bumps", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    const next = await service.update({
      tenantId: TENANT,
      agentId: a.id,
      input: { name: "x" },
      expectedVersion: 1,
    });
    expect(next.version).toBe(2);
  });

  it("update on missing agent throws AgentNotFoundError", async () => {
    const { service } = createInMemoryAgentService();
    await expect(() =>
      service.update({
        tenantId: TENANT,
        agentId: "missing",
        input: { name: "x" },
      }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("update with explicit null clears system/description to empty string", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({
      tenantId: TENANT,
      input: { ...SAMPLE_INPUT, description: "before" },
    });
    const cleared = await service.update({
      tenantId: TENANT,
      agentId: a.id,
      input: { system: null, description: null },
    });
    expect(cleared.system).toBe("");
    expect(cleared.description).toBe("");
  });

  it("metadata patch merges per key — '' or null deletes; new keys added", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({
      tenantId: TENANT,
      input: { ...SAMPLE_INPUT, metadata: { keep: 1, drop: "bye", clear: 2 } },
    });
    const merged = await service.update({
      tenantId: TENANT,
      agentId: a.id,
      input: { metadata: { drop: "", clear: null, fresh: 3 } },
    });
    expect(merged.metadata).toEqual({ keep: 1, fresh: 3 });
  });

  it("multiple updates write multiple history rows (versions monotonic)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryAgentService({ clock });
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    clock.set(2000);
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v2-name" } });
    clock.set(3000);
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v3-name" } });

    const history = await service.listVersions({ tenantId: TENANT, agentId: a.id });
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history[0].snapshot.name).toBe("test agent");
    expect(history[1].snapshot.name).toBe("v2-name");
  });
});

describe("AgentService — versions", () => {
  it("getVersion returns specific historical row; null for the current version", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v2" } });
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v3" } });

    const v1 = await service.getVersion({ tenantId: TENANT, agentId: a.id, version: 1 });
    expect(v1?.snapshot.name).toBe("test agent");
    const v2 = await service.getVersion({ tenantId: TENANT, agentId: a.id, version: 2 });
    expect(v2?.snapshot.name).toBe("v2");
    // Current version is NOT in history — consistent with legacy KV layout.
    const current = await service.getVersion({ tenantId: TENANT, agentId: a.id, version: 3 });
    expect(current).toBeNull();
  });

  it("listVersions is empty when agent never updated", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    const versions = await service.listVersions({ tenantId: TENANT, agentId: a.id });
    expect(versions).toEqual([]);
  });

  it("getVersion returns null for wrong tenant", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v2" } });
    const v1Wrong = await service.getVersion({ tenantId: "tn_other", agentId: a.id, version: 1 });
    expect(v1Wrong).toBeNull();
  });
});

describe("AgentService — archive", () => {
  it("archive sets archived_at; agent stays readable + listable with includeArchived", async () => {
    const clock = new ManualClock(5000);
    const { service } = createInMemoryAgentService({ clock });
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    const archived = await service.archive({ tenantId: TENANT, agentId: a.id });
    expect(archived.archived_at).not.toBeUndefined();
    expect(await service.get({ tenantId: TENANT, agentId: a.id })).not.toBeNull();
    // Default list includes archived; explicit includeArchived: false hides it.
    expect((await service.list({ tenantId: TENANT })).length).toBe(1);
    expect(
      (await service.list({ tenantId: TENANT, includeArchived: false })).length,
    ).toBe(0);
  });

  it("archive on missing agent throws AgentNotFoundError", async () => {
    const { service } = createInMemoryAgentService();
    await expect(() =>
      service.archive({ tenantId: TENANT, agentId: "missing" }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});

describe("AgentService — delete", () => {
  it("delete removes the agent AND cascades its history rows", async () => {
    const { service, repo } = createInMemoryAgentService();
    const a = await service.create({ tenantId: TENANT, input: SAMPLE_INPUT });
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v2" } });
    await service.update({ tenantId: TENANT, agentId: a.id, input: { name: "v3" } });
    expect((await service.listVersions({ tenantId: TENANT, agentId: a.id })).length).toBe(2);

    await service.delete({ tenantId: TENANT, agentId: a.id });
    expect(await service.get({ tenantId: TENANT, agentId: a.id })).toBeNull();
    // History rows are also gone — no orphans.
    expect(await repo.listVersions(TENANT, a.id)).toEqual([]);
  });

  it("delete on missing agent throws AgentNotFoundError", async () => {
    const { service } = createInMemoryAgentService();
    await expect(() =>
      service.delete({ tenantId: TENANT, agentId: "missing" }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("delete is tenant-scoped (cross-tenant delete refuses)", async () => {
    const { service } = createInMemoryAgentService();
    const a = await service.create({ tenantId: "tn_a", input: SAMPLE_INPUT });
    await expect(() =>
      service.delete({ tenantId: "tn_b", agentId: a.id }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(await service.get({ tenantId: "tn_a", agentId: a.id })).not.toBeNull();
  });
});
