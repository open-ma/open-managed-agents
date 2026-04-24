// Unit tests for EvalRunService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: tenant isolation, indexed list-by-agent /
// status filter paths, markCompleted terminal state stamping, cross-tenant
// getById + listActive (replaces evalrun_active: KV index), agent-delete
// cascade, hasActiveByAgent / hasActiveByEnvironment safety checks, opaque
// results JSON round-trip + isolation from caller mutation.
//
// NOTE: imports use relative paths because vitest.config.ts has not yet been
// updated with the @open-managed-agents/evals-store alias (that's done at
// integration time per packages/evals-store/INTEGRATION_GUIDE.md). After the
// alias lands, these can be swapped to the package import to match the
// credentials-store test style.

import { describe, it, expect } from "vitest";
import {
  EvalRunNotFoundError,
} from "../../packages/evals-store/src/index";
import {
  ManualClock,
  createInMemoryEvalRunService,
} from "../../packages/evals-store/src/test-fakes";

const TENANT = "tn_test_evals";
const AGENT = "agent-a";
const ENV_ID = "env-a";

describe("EvalRunService — create + read", () => {
  it("creates a run and reads it back", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      results: { tasks: [{ id: "t1", status: "pending" }] },
    });
    expect(run.id).toMatch(/^evrun-/);
    expect(run.tenant_id).toBe(TENANT);
    expect(run.agent_id).toBe(AGENT);
    expect(run.environment_id).toBe(ENV_ID);
    expect(run.status).toBe("pending"); // default when status not provided
    expect(run.completed_at).toBeNull();
    expect(run.score).toBeNull();
    expect(run.error).toBeNull();

    const got = await service.get({ tenantId: TENANT, runId: run.id });
    expect(got?.id).toBe(run.id);
    expect((got?.results as { tasks: unknown[] }).tasks.length).toBe(1);
  });

  it("isolates runs by tenant", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    expect(await service.get({ tenantId: "tn_a", runId: run.id })).not.toBeNull();
    expect(await service.get({ tenantId: "tn_b", runId: run.id })).toBeNull();
  });

  it("getById crosses tenants — replaces evalrun_active KV reverse lookup in cron tick", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    const got = await service.getById({ runId: run.id });
    expect(got?.tenant_id).toBe("tn_a");
  });

  it("returns null when reading a run that doesn't exist", async () => {
    const { service } = createInMemoryEvalRunService();
    expect(await service.get({ tenantId: TENANT, runId: "missing" })).toBeNull();
    expect(await service.getById({ runId: "missing" })).toBeNull();
  });

  it("round-trips opaque results JSON without interpreting it", async () => {
    const { service } = createInMemoryEvalRunService();
    const blob = {
      task_count: 2,
      completed_count: 0,
      failed_count: 0,
      tasks: [
        { id: "t1", status: "running", trials: [{ trial_index: 0, status: "running" }] },
        { id: "t2", status: "pending", trials: [{ trial_index: 0, status: "pending" }] },
      ],
    };
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      results: blob,
    });
    const got = await service.get({ tenantId: TENANT, runId: run.id });
    expect(got?.results).toEqual(blob);
  });

  it("isolates stored results from caller mutation (clones on read + write)", async () => {
    const { service } = createInMemoryEvalRunService();
    const blob: { tasks: { id: string; status: string }[] } = {
      tasks: [{ id: "t1", status: "pending" }],
    };
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      results: blob,
    });
    // Mutate the original after insert — stored copy must not change.
    blob.tasks[0].status = "running";
    blob.tasks.push({ id: "t2", status: "pending" });
    const got = await service.get({ tenantId: TENANT, runId: run.id });
    const stored = got?.results as { tasks: { id: string; status: string }[] };
    expect(stored.tasks.length).toBe(1);
    expect(stored.tasks[0].status).toBe("pending");
  });
});

describe("EvalRunService — list + filters", () => {
  it("filters list by agent_id (verifies indexed path)", async () => {
    const { service } = createInMemoryEvalRunService();
    await service.create({ tenantId: TENANT, agentId: "agent-a", environmentId: ENV_ID });
    await service.create({ tenantId: TENANT, agentId: "agent-a", environmentId: ENV_ID });
    await service.create({ tenantId: TENANT, agentId: "agent-b", environmentId: ENV_ID });

    const allA = await service.list({ tenantId: TENANT, agentId: "agent-a" });
    expect(allA.length).toBe(2);
    expect(allA.every((r) => r.agent_id === "agent-a")).toBe(true);

    const allB = await service.list({ tenantId: TENANT, agentId: "agent-b" });
    expect(allB.length).toBe(1);
  });

  it("filters list by environment_id", async () => {
    const { service } = createInMemoryEvalRunService();
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: "env-a" });
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: "env-b" });
    const list = await service.list({ tenantId: TENANT, environmentId: "env-a" });
    expect(list.length).toBe(1);
    expect(list[0].environment_id).toBe("env-a");
  });

  it("filters list by status", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEvalRunService({ clock });
    const r1 = await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    clock.set(2000);
    await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    await service.markCompleted({
      tenantId: TENANT,
      runId: r1.id,
      status: "completed",
      score: 1.0,
    });

    const completed = await service.list({ tenantId: TENANT, status: "completed" });
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe(r1.id);

    const pending = await service.list({ tenantId: TENANT, status: "pending" });
    expect(pending.length).toBe(1);
  });

  it("orders by started_at DESC by default", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEvalRunService({ clock });
    const r1 = await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    clock.set(2000);
    const r2 = await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    clock.set(3000);
    const r3 = await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });

    const desc = await service.list({ tenantId: TENANT });
    expect(desc.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);

    const asc = await service.list({ tenantId: TENANT, order: "asc" });
    expect(asc.map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
  });

  it("respects limit", async () => {
    const { service } = createInMemoryEvalRunService();
    for (let i = 0; i < 5; i++) {
      await service.create({ tenantId: TENANT, agentId: AGENT, environmentId: ENV_ID });
    }
    const limited = await service.list({ tenantId: TENANT, limit: 3 });
    expect(limited.length).toBe(3);
  });

  it("listByAgent is a thin convenience over list({agentId})", async () => {
    const { service } = createInMemoryEvalRunService();
    await service.create({ tenantId: TENANT, agentId: "agent-a", environmentId: ENV_ID });
    await service.create({ tenantId: TENANT, agentId: "agent-b", environmentId: ENV_ID });
    const out = await service.listByAgent({ tenantId: TENANT, agentId: "agent-a" });
    expect(out.length).toBe(1);
    expect(out[0].agent_id).toBe("agent-a");
  });

  it("listActive returns pending+running runs across tenants (cron-tick path)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEvalRunService({ clock });
    // tn_a: one pending, one running, one completed
    const pending = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    clock.set(2000);
    const runningRun = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
    });
    clock.set(3000);
    const done = await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
    });
    await service.markCompleted({
      tenantId: "tn_a",
      runId: done.id,
      status: "completed",
    });
    // tn_b: one running — cross-tenant scan must include it
    clock.set(4000);
    const runOther = await service.create({
      tenantId: "tn_b",
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
    });

    const active = await service.listActive();
    const ids = active.map((r) => r.id).sort();
    expect(ids).toEqual([pending.id, runningRun.id, runOther.id].sort());
  });
});

describe("EvalRunService — update + markCompleted", () => {
  it("update mutates results blob without touching status", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
      results: { tasks: [{ id: "t1", status: "pending" }] },
    });
    const updated = await service.update({
      tenantId: TENANT,
      runId: run.id,
      results: { tasks: [{ id: "t1", status: "running" }] },
    });
    expect(updated.status).toBe("running");
    expect((updated.results as { tasks: { status: string }[] }).tasks[0].status).toBe(
      "running",
    );
    expect(updated.completed_at).toBeNull();
  });

  it("update can transition status without auto-stamping completed_at", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    const updated = await service.update({
      tenantId: TENANT,
      runId: run.id,
      status: "running",
    });
    expect(updated.status).toBe("running");
    // update is intentionally NOT a terminal-state convenience — completed_at
    // stays null even if we passed status="completed". Use markCompleted for
    // the terminal stamp.
    expect(updated.completed_at).toBeNull();
  });

  it("update throws EvalRunNotFoundError for missing id", async () => {
    const { service } = createInMemoryEvalRunService();
    await expect(
      service.update({ tenantId: TENANT, runId: "missing", status: "running" }),
    ).rejects.toBeInstanceOf(EvalRunNotFoundError);
  });

  it("markCompleted sets status, completed_at, results, score", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryEvalRunService({ clock });
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
      results: { tasks: [{ id: "t1", status: "running" }] },
    });
    clock.set(5000);
    const completed = await service.markCompleted({
      tenantId: TENANT,
      runId: run.id,
      status: "completed",
      results: {
        tasks: [{ id: "t1", status: "completed" }],
        completed_count: 1,
        failed_count: 0,
      },
      score: 1.0,
    });
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).not.toBeNull();
    expect(completed.score).toBe(1.0);
    expect((completed.results as { completed_count: number }).completed_count).toBe(1);
  });

  it("markCompleted with status=failed records error", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
    });
    const failed = await service.markCompleted({
      tenantId: TENANT,
      runId: run.id,
      status: "failed",
      error: "sandbox unreachable",
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("sandbox unreachable");
    expect(failed.completed_at).not.toBeNull();
  });
});

describe("EvalRunService — delete + cascade", () => {
  it("delete removes the row entirely", async () => {
    const { service } = createInMemoryEvalRunService();
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    await service.delete({ tenantId: TENANT, runId: run.id });
    expect(await service.get({ tenantId: TENANT, runId: run.id })).toBeNull();
    expect(await service.getById({ runId: run.id })).toBeNull();
  });

  it("delete throws EvalRunNotFoundError for missing id", async () => {
    const { service } = createInMemoryEvalRunService();
    await expect(
      service.delete({ tenantId: TENANT, runId: "missing" }),
    ).rejects.toBeInstanceOf(EvalRunNotFoundError);
  });

  it("deleteByAgent removes every run for an agent in tenant, leaves others", async () => {
    const { service } = createInMemoryEvalRunService();
    const r1 = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    const r2 = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    // Same agent in another tenant — must NOT be touched
    const rOther = await service.create({
      tenantId: "tn_other",
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    // Different agent in same tenant — must NOT be touched
    const rOtherAgent = await service.create({
      tenantId: TENANT,
      agentId: "agent-other",
      environmentId: ENV_ID,
    });

    const deleted = await service.deleteByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(deleted).toBe(2);
    expect(await service.get({ tenantId: TENANT, runId: r1.id })).toBeNull();
    expect(await service.get({ tenantId: TENANT, runId: r2.id })).toBeNull();
    expect(await service.get({ tenantId: "tn_other", runId: rOther.id })).not.toBeNull();
    expect(await service.get({ tenantId: TENANT, runId: rOtherAgent.id })).not.toBeNull();
  });

  it("deleteByAgent returns 0 when no runs match", async () => {
    const { service } = createInMemoryEvalRunService();
    expect(await service.deleteByAgent({ tenantId: TENANT, agentId: "ghost" })).toBe(0);
  });
});

describe("EvalRunService — safety checks (hasActive*)", () => {
  it("hasActiveByAgent returns true for pending/running, false for terminal", async () => {
    const { service } = createInMemoryEvalRunService();
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(false);
    const run = await service.create({
      tenantId: TENANT,
      agentId: AGENT,
      environmentId: ENV_ID,
    });
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(true);
    await service.markCompleted({
      tenantId: TENANT,
      runId: run.id,
      status: "completed",
    });
    expect(await service.hasActiveByAgent({ tenantId: TENANT, agentId: AGENT })).toBe(false);
  });

  it("hasActiveByEnvironment ignores cross-tenant rows", async () => {
    const { service } = createInMemoryEvalRunService();
    await service.create({
      tenantId: "tn_a",
      agentId: AGENT,
      environmentId: ENV_ID,
      status: "running",
    });
    expect(
      await service.hasActiveByEnvironment({ tenantId: "tn_b", environmentId: ENV_ID }),
    ).toBe(false);
    expect(
      await service.hasActiveByEnvironment({ tenantId: "tn_a", environmentId: ENV_ID }),
    ).toBe(true);
  });
});
