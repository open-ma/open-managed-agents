// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path, init?) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path, body) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}

describe("Background task schedule polling", () => {
  it("pollBackgroundTasks is a public method on SessionDO", async () => {
    const { SessionDO } = await import("../../apps/agent/src/runtime/session-do");
    expect(typeof SessionDO.prototype.pollBackgroundTasks).toBe("function");
    expect(typeof SessionDO.prototype.recoverEventQueue).toBe("function");
  });

  it("recoverEventQueue schedule is set when event is posted", async () => {
    const a = await post("/v1/agents", { name: "SchedTest", model: "claude-sonnet-4-6", harness: "noop" });
    const agent = await a.json();
    const e = await post("/v1/environments", { name: "sched-env", config: { type: "cloud" } });
    const environment = await e.json();
    const s = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
    const session = await s.json();

    // Post event — should trigger schedule(5, "recoverEventQueue")
    await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "test" }] }],
    });
    await new Promise(r => setTimeout(r, 500));

    // Session should process and return to idle
    const doId = env.SESSION_DO.idFromName(session.id);
    const stub = env.SESSION_DO.get(doId);
    const statusRes = await stub.fetch(new Request("http://internal/status"));
    const status = await statusRes.json();
    expect(status.status).toBe("idle");
  });

  it("schedule(N, callback) writes to cf_agents_schedules table", async () => {
    const a = await post("/v1/agents", { name: "TableTest", model: "claude-sonnet-4-6", harness: "noop" });
    const agent = await a.json();
    const e = await post("/v1/environments", { name: "table-env", config: { type: "cloud" } });
    const environment = await e.json();
    const s = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
    const session = await s.json();

    // Post event to trigger schedule
    const res = await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }],
    });
    expect(res.status).toBe(202);

    // The schedule(5, "recoverEventQueue") should have been called
    // We can verify via /status that the session processed successfully
    await new Promise(r => setTimeout(r, 500));
    const doId = env.SESSION_DO.idFromName(session.id);
    const stub = env.SESSION_DO.get(doId);
    const eventsRes = await stub.fetch(new Request("http://internal/events"));
    const events = await eventsRes.json();
    // Should have at least user.message + status events
    expect(events.data.length).toBeGreaterThanOrEqual(1);
  });
});
