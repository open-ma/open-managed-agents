// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { HarnessInterface, HarnessContext } from "../../apps/agent/src/harness/interface";
import { CfDoStreamRepo, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/cf-do";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

// ============================================================
// recoverInterruptedState — DO-level integration
// ============================================================
//
// Unit tests in test/unit/recovery.test.ts prove the recovery LOGIC.
// This goes one layer deeper: the SessionDO wrapper actually wires the
// real CfDoStreamRepo + SqliteHistory adapters to the recovery scan,
// the schema DDL matches what the adapters read, and ensureSchema
// triggers the scan on cold start. We can't induce a real Cloudflare
// cold start in workerd, so:
//   1. Reach into a live SessionDO via runInDurableObject,
//   2. Seed orphan state directly into the streams + events tables,
//   3. Reset the in-memory `initialized` guard,
//   4. Trigger any endpoint that calls ensureSchema → recovery fires,
//   5. Read events back via the DO's own GET /events endpoint.

class NoopHarness implements HarnessInterface {
  async run(_ctx: HarnessContext): Promise<void> { /* no LLM */ }
}
registerHarness("noop", () => new NoopHarness());

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: unknown) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}

async function newSession(): Promise<string> {
  const a = await post("/v1/agents", { name: "RecoveryTest", model: "claude-sonnet-4-6", harness: "noop" });
  const agent = await a.json();
  const e = await post("/v1/environments", { name: "rec-env", config: { type: "cloud" } });
  const environment = await e.json();
  const s = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const session = await s.json();
  // Wake the DO so ensureSchema runs once and the streams table exists.
  await post(`/v1/sessions/${session.id}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: "warmup" }] }],
  });
  await new Promise((r) => setTimeout(r, 200));
  return session.id;
}

describe("SessionDO recovery — DO-level", () => {
  it("finalizes streaming row + appends agent.message on next boot", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      await streams.start("msg_dangling", Date.now() - 5000);
      await streams.appendChunk("msg_dangling", "Sure, here is ");
      await streams.appendChunk("msg_dangling", "the answer:");
      // Reach into the private flag — JS lets us; @ts-nocheck silences the warning.
      (instance as { initialized: boolean }).initialized = false;
    });

    // Trigger re-init by hitting any endpoint that calls ensureSchema.
    await stub.fetch(new Request("http://internal/status"));
    // recoverInterruptedState fires async (void this.recoverInterruptedState()).
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const recovered = events.find(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_dangling",
    );
    expect(recovered, "recovery should append agent.message for dangling stream").toBeDefined();
    expect(recovered.data.content[0].text).toBe("Sure, here is the answer:");

    await runInDurableObject(stub, async (_instance, state) => {
      const streams = new CfDoStreamRepo(state.storage.sql);
      const row = await streams.get("msg_dangling");
      expect(row?.status).toBe("interrupted");
    });
  });

  it("injects placeholder tool_result for orphan agent.tool_use", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.tool_use",
        id: "tu_orphan_bash",
        name: "bash",
        input: { command: "ls" },
      });
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const placeholder = events.find(
      (e: { type: string; data: { tool_use_id?: string } }) =>
        e.type === "agent.tool_result" && e.data.tool_use_id === "tu_orphan_bash",
    );
    expect(placeholder, "recovery should inject agent.tool_result").toBeDefined();
    expect(placeholder.data.content).toMatch(/interrupted/);
  });

  it("injects mcp_tool_result with is_error=true for orphan mcp_tool_use", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const history = new SqliteHistory(state.storage.sql);
      history.append({
        type: "agent.mcp_tool_use",
        id: "mtu_orphan",
        name: "search",
        server_label: "linear",
      });
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();

    const placeholder = events.find(
      (e: { type: string; data: { mcp_tool_use_id?: string } }) =>
        e.type === "agent.mcp_tool_result" && e.data.mcp_tool_use_id === "mtu_orphan",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder.data.is_error).toBe(true);
  });

  it("does not re-finalize streams already in terminal state (idempotent)", async () => {
    const sessionId = await newSession();
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      ensureEventLogSchema(state.storage.sql);
      const streams = new CfDoStreamRepo(state.storage.sql);
      await streams.start("msg_already_done", Date.now());
      await streams.appendChunk("msg_already_done", "ok");
      await streams.finalize("msg_already_done", "completed");
      (instance as { initialized: boolean }).initialized = false;
    });

    await stub.fetch(new Request("http://internal/status"));
    await new Promise((r) => setTimeout(r, 100));

    const ev = await stub.fetch(new Request("http://internal/events"));
    const { data: events } = await ev.json();
    const newMessages = events.filter(
      (e: { type: string; data: { message_id?: string } }) =>
        e.type === "agent.message" && e.data.message_id === "msg_already_done",
    );
    expect(newMessages).toHaveLength(0);
  });
});
