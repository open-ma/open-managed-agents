// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { toAnthropicMessages } from "@open-managed-agents/shared";

// Test harness that emits a tool_use → tool_result → message sequence so we can
// validate trajectory builder + anthropic projection on a non-trivial event stream.
class TrajectoryHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    ctx.runtime.broadcast({
      type: "agent.tool_use",
      id: "tu-test-1",
      name: "bash",
      input: { command: "echo hi" },
    });
    ctx.runtime.broadcast({
      type: "agent.tool_result",
      tool_use_id: "tu-test-1",
      content: "hi\nexit=0",
    });
    ctx.runtime.broadcast({
      type: "agent.message",
      content: [{ type: "text", text: "hello from trajectory test" }],
    });
  }
}
registerHarness("trajectory-test", () => new TrajectoryHarness());

const HEADERS = {
  "x-api-key": "test-key",
  "Content-Type": "application/json",
};

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function setup() {
  const agentRes = await api("/v1/agents", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "Trajectory Test Agent",
      model: "claude-sonnet-4-6",
      system: "you are helpful",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "trajectory-test",
    }),
  });
  const agent = (await agentRes.json()) as any;

  const envRes = await api("/v1/environments", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name: "test-env", config: { type: "cloud" } }),
  });
  const environment = (await envRes.json()) as any;

  const sessRes = await api("/v1/sessions", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ agent: agent.id, environment_id: environment.id, title: "trajectory test" }),
  });
  const session = (await sessRes.json()) as any;

  return { agent, environment, session };
}

async function postMessageAndWait(sessionId: string, text: string): Promise<void> {
  await api(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  // The TestHarness completes synchronously inside the DO via broadcast — after
  // POST returns, events should be in the SQLite log already. Wait briefly to
  // let any async draining settle.
  await new Promise((r) => setTimeout(r, 200));
}

async function getTrajectory(sessionId: string): Promise<Response> {
  return api(`/v1/sessions/${sessionId}/trajectory`, { headers: HEADERS });
}

describe("GET /v1/sessions/:id/trajectory", () => {
  it("returns 404 for unknown session", async () => {
    const res = await api("/v1/sessions/sess-ghost/trajectory", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await api("/v1/sessions/sess-x/trajectory");
    expect(res.status).toBe(401);
  });

  it("returns a v1 envelope after a real session run", async () => {
    const { session } = await setup();
    await postMessageAndWait(session.id, "hi");

    const res = await getTrajectory(session.id);
    expect(res.status).toBe(200);
    const t = (await res.json()) as any;

    expect(t.schema_version).toBe("oma.trajectory.v1");
    expect(t.session_id).toBe(session.id);
    expect(t.trajectory_id).toMatch(/^tr-/);
    expect(t.agent_config?.id).toMatch(/^agent-/);
    expect(t.environment_config?.id).toMatch(/^env-/);
    expect(Array.isArray(t.events)).toBe(true);
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.summary).toBeDefined();
    expect(t.summary.num_events).toBe(t.events.length);
  });

  it("counts tool_use, tool_result, and turn correctly in summary", async () => {
    const { session } = await setup();
    await postMessageAndWait(session.id, "go");

    const res = await getTrajectory(session.id);
    const t = (await res.json()) as any;

    // TrajectoryHarness emits exactly: tool_use, tool_result, agent.message
    expect(t.summary.num_tool_calls).toBeGreaterThanOrEqual(1);
    expect(t.summary.num_turns).toBeGreaterThanOrEqual(1);
    expect(t.summary.num_tool_errors).toBe(0);
  });

  it("snapshots agent_config and environment_config at session create", async () => {
    const { agent, environment, session } = await setup();
    await postMessageAndWait(session.id, "snap");

    const res = await getTrajectory(session.id);
    const t = (await res.json()) as any;

    expect(t.agent_config.id).toBe(agent.id);
    expect(t.agent_config.name).toBe("Trajectory Test Agent");
    expect(t.environment_config.id).toBe(environment.id);
  });

  it("anthropic-messages projection round-trips a real trajectory", async () => {
    const { session } = await setup();
    await postMessageAndWait(session.id, "project me");

    const res = await getTrajectory(session.id);
    const t = (await res.json()) as any;
    const messages = toAnthropicMessages(t);

    // We expect at least: user msg → assistant (tool_use) → user (tool_result) → assistant (text)
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("user");

    // Find the assistant turn with tool_use
    const toolUseMsg = messages.find(
      (m) => m.role === "assistant" && (m.content as any[]).some((b) => b.type === "tool_use")
    );
    expect(toolUseMsg).toBeDefined();

    // Find the user turn with tool_result
    const toolResultMsg = messages.find(
      (m) => m.role === "user" && (m.content as any[]).some((b) => b.type === "tool_result")
    );
    expect(toolResultMsg).toBeDefined();
  });

  it("derives outcome from terminal event", async () => {
    const { session } = await setup();
    await postMessageAndWait(session.id, "outcome check");

    const res = await getTrajectory(session.id);
    const t = (await res.json()) as any;

    // Test harness emits messages then status_idle is set by runtime — outcome should be success
    expect(["success", "running"]).toContain(t.outcome);
  });
});
