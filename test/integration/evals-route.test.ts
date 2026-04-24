// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { tickEvalRuns } from "../../apps/main/src/eval-runner";
import { buildCfServices } from "@open-managed-agents/services";

// Lightweight test harness: emits a single agent.message per turn, then idle.
class EvalTestHarness {
  async run(ctx: any) {
    const text = ctx.userMessage?.content?.[0]?.text || "";
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: `eval-ack: ${text}` }],
    });
  }
}
registerHarness("eval-test", () => new EvalTestHarness());

const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function setupAgentAndEnv() {
  const agentRes = await api("/v1/agents", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "Eval Agent",
      model: "claude-sonnet-4-6",
      system: "you are helpful",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "eval-test",
    }),
  });
  const agent = (await agentRes.json()) as any;
  const envRes = await api("/v1/environments", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name: "eval-test-env", config: { type: "cloud" } }),
  });
  const environment = (await envRes.json()) as any;
  return { agent, environment };
}

describe("POST /v1/evals/runs", () => {
  it("requires auth", async () => {
    const res = await api("/v1/evals/runs", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects missing agent_id", async () => {
    const res = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ environment_id: "env-x", tasks: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty tasks array", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const res = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ agent_id: agent.id, environment_id: environment.id, tasks: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects task missing messages", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const res = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "t1" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown agent", async () => {
    const { environment } = await setupAgentAndEnv();
    const res = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: "agent-ghost",
        environment_id: environment.id,
        tasks: [{ id: "t1", messages: ["hi"] }],
      }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a pending run and returns run_id", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const res = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [
          { id: "t1", messages: ["hello"] },
          { id: "t2", messages: ["world"] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run_id).toMatch(/^evrun-/);
    expect(body.task_count).toBe(2);

    // Fetch via GET — record should exist with status pending
    const getRes = await api(`/v1/evals/runs/${body.run_id}`, { headers: HEADERS });
    expect(getRes.status).toBe(200);
    const run = (await getRes.json()) as any;
    expect(run.status).toBe("pending");
    expect(run.task_count).toBe(2);
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0].status).toBe("pending");
    expect(run.tasks[0].trials).toHaveLength(1);
    expect(run.tasks[0].trial_total).toBe(1);
    expect(run.tasks[0].trials[0].status).toBe("pending");
    expect(run.completed_count).toBe(0);
  });
});

describe("GET /v1/evals/runs", () => {
  it("lists runs for tenant in reverse chronological order", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const r1 = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "t", messages: ["m1"] }],
      }),
    });
    const run1 = (await r1.json()) as any;
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "t", messages: ["m2"] }],
      }),
    });
    const run2 = (await r2.json()) as any;

    const listRes = await api("/v1/evals/runs", { headers: HEADERS });
    const list = (await listRes.json()) as any;
    expect(list.data.length).toBeGreaterThanOrEqual(2);
    const ids = list.data.map((r: any) => r.id);
    expect(ids.indexOf(run2.run_id)).toBeLessThan(ids.indexOf(run1.run_id));
  });
});

describe("tickEvalRuns advances state", () => {
  it("advances pending → running → completed for a single-message task", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const createRes = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "single", messages: ["hello world"] }],
      }),
    });
    const { run_id } = (await createRes.json()) as any;

    // Initially pending
    let runRes = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
    let run = (await runRes.json()) as any;
    expect(run.status).toBe("pending");

    // Tick 1: pending → running, creates session, sends first message
    await tickEvalRuns(env);
    runRes = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
    run = (await runRes.json()) as any;
    expect(run.status).toBe("running");
    expect(run.tasks[0].status).toBe("running");
    expect(run.tasks[0].trials[0].status).toBe("running");
    expect(run.tasks[0].trials[0].session_id).toMatch(/^sess-/);

    // Wait for harness to complete + go idle
    await new Promise((r) => setTimeout(r, 500));

    // Tick 2: session is idle, only one message → build trajectory + finalize
    await tickEvalRuns(env);
    runRes = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
    run = (await runRes.json()) as any;
    expect(run.status).toBe("completed");
    expect(run.tasks[0].status).toBe("completed");
    expect(run.tasks[0].trials[0].trajectory_id).toMatch(/^tr-/);
    expect(run.tasks[0].trial_pass_count).toBe(1);
    expect(run.completed_count).toBe(1);
    expect(run.failed_count).toBe(0);
    expect(run.ended_at).toBeDefined();
  });

  it("multi-task run completes all tasks across multiple ticks", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const createRes = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [
          { id: "ta", messages: ["one"] },
          { id: "tb", messages: ["two"] },
          { id: "tc", messages: ["three"] },
        ],
      }),
    });
    const { run_id } = (await createRes.json()) as any;

    // Tick + wait loop
    for (let i = 0; i < 6; i++) {
      await tickEvalRuns(env);
      await new Promise((r) => setTimeout(r, 400));
      const r = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
      const body = (await r.json()) as any;
      if (body.status === "completed" || body.status === "failed") break;
    }

    const finalRes = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
    const final = (await finalRes.json()) as any;
    expect(final.status).toBe("completed");
    expect(final.completed_count).toBe(3);
    for (const task of final.tasks) {
      expect(task.status).toBe("completed");
      expect(task.trials[0].trajectory_id).toMatch(/^tr-/);
    }
  });

  it("multi-message task sends each message in turn", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const createRes = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "multi", messages: ["msg-A", "msg-B", "msg-C"] }],
      }),
    });
    const { run_id } = (await createRes.json()) as any;

    for (let i = 0; i < 8; i++) {
      await tickEvalRuns(env);
      await new Promise((r) => setTimeout(r, 400));
      const r = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
      const body = (await r.json()) as any;
      if (body.status === "completed" || body.status === "failed") break;
    }

    const finalRes = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
    const final = (await finalRes.json()) as any;
    expect(final.status).toBe("completed");
    expect(final.tasks[0].trials[0].trajectory_id).toMatch(/^tr-/);

    // The trajectory should record exactly 3 user messages (one per spec.messages)
    // Fetch trajectory via session GET
    const sessionId = final.tasks[0].trials[0].session_id;
    const trajRes = await api(`/v1/sessions/${sessionId}/trajectory`, { headers: HEADERS });
    const traj = (await trajRes.json()) as any;
    const userMsgs = traj.events.filter((e: any) => e.type === "user.message");
    expect(userMsgs.length).toBe(3);
  });

  it("removes run from active index on completion", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const createRes = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "x", messages: ["hi"] }],
      }),
    });
    const { run_id } = (await createRes.json()) as any;

    // Active list (status-driven via services.evals.listActive) should
    // contain the new run.
    const services = buildCfServices(env);
    const activeBefore = await services.evals.listActive();
    expect(activeBefore.some((r: any) => r.id === run_id)).toBe(true);

    // Drive to completion
    for (let i = 0; i < 5; i++) {
      await tickEvalRuns(env);
      await new Promise((r) => setTimeout(r, 400));
      const r = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
      const body = (await r.json()) as any;
      if (body.status === "completed" || body.status === "failed") break;
    }

    // Active list should no longer include the run (status flipped to terminal).
    const activeAfter = await services.evals.listActive();
    expect(activeAfter.some((r: any) => r.id === run_id)).toBe(false);
  });

  it("trials > 1: spawns N independent sessions per task and stores N trajectories", async () => {
    const { agent, environment } = await setupAgentAndEnv();
    const createRes = await api("/v1/evals/runs", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        agent_id: agent.id,
        environment_id: environment.id,
        tasks: [{ id: "trial-task", messages: ["hello"], trials: 3 }],
      }),
    });
    const { run_id } = (await createRes.json()) as any;

    // Initial state: 3 pending trials, no session_ids yet
    let initial = (await (await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS })).json()) as any;
    expect(initial.tasks[0].trials).toHaveLength(3);
    expect(initial.tasks[0].trial_total).toBe(3);
    expect(initial.tasks[0].trials.every((t: any) => t.status === "pending")).toBe(true);

    // Drive to completion
    for (let i = 0; i < 8; i++) {
      await tickEvalRuns(env);
      await new Promise((r) => setTimeout(r, 400));
      const r = await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS });
      const body = (await r.json()) as any;
      if (body.status === "completed" || body.status === "failed") break;
    }

    const final = (await (await api(`/v1/evals/runs/${run_id}`, { headers: HEADERS })).json()) as any;
    expect(final.status).toBe("completed");
    expect(final.tasks[0].status).toBe("completed");
    expect(final.tasks[0].trials).toHaveLength(3);
    expect(final.tasks[0].trial_pass_count).toBe(3);

    // Each trial got its own session and its own trajectory
    const sessionIds = final.tasks[0].trials.map((t: any) => t.session_id);
    const trajectoryIds = final.tasks[0].trials.map((t: any) => t.trajectory_id);
    expect(new Set(sessionIds).size).toBe(3); // all unique
    expect(new Set(trajectoryIds).size).toBe(3); // all unique
    expect(sessionIds.every((s: string) => s.startsWith("sess-"))).toBe(true);
    expect(trajectoryIds.every((t: string) => t.startsWith("tr-"))).toBe(true);
  });
});
