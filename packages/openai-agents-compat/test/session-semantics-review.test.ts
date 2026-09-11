import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { buildOpenAIAgentsProtocolApi } from "@open-managed-agents/openai-agents-api";
import { SessionEventsApplicationService } from "@open-managed-agents/managed-agents-application";
import { createSessionsHandler, type SessionSemanticDependencies } from "../src/sessions";
import { normalizeAgentConfig } from "../src/resources";

/** Real native input acceptance with storage and mapping boundary doubles. */
function fixture() {
  const native: any = { id: "session", agent: { id: "agent" }, createdAt: new Date(100000).toISOString(), updatedAt: new Date(101000).toISOString(), metadata: {}, outcomeEvaluations: [] };
  const records = new Map<string, any>([[native.id, native]]);
  const facts: any[] = [];
  const dispatched: any[] = [];
  let revision = 1, sequence = 0;
  let barrier: { remaining: number; ready: Promise<void>; release(): void } | null = null;
  const service = new SessionEventsApplicationService({
    workspaceId: "workspace", clock: { now: () => new Date(102000 + sequence++) },
    ids: { nextEventId: () => `accepted-${sequence++}`, nextOutcomeId: () => `outcome-${sequence++}` },
    sessions: { find: async () => native },
    execution: { find: async () => ({ session: native, environment: {} as any, revision }) },
    stream: { subscribe: () => (async function* () {})() },
    store: {
      list: async (input: any) => facts.filter(event => !input.idPrefix || event.id.startsWith(input.idPrefix)).slice(0, input.limit),
      append: async (input: any) => {
        if (input.expectedRevision !== revision) return { type: "revision_conflict", actualRevision: revision };
        revision++;
        facts.push(...structuredClone(input.events));
        Object.assign(native, input.nextSession);
        return { type: "appended", events: input.events, session: input.nextSession };
      },
    },
    dispatch: { sessionEventsAccepted: async input => { dispatched.push(input); } },
  });
  const deps: SessionSemanticDependencies = {
    workspaceId: "workspace", sessionEvents: service,
    sessions: {
      createSession: async () => ({ type: "created", session: native }),
      retrieveSession: async ({ sessionId }) => records.has(sessionId) ? { type: "found", session: records.get(sessionId) } : { type: "not_found" },
      updateSession: async () => ({ type: "updated", session: native }),
      listSessions: async () => ({ type: "page", page: { sessions: [...records.values()], nextCursor: null, previousCursor: null } }),
      deleteSession: async ({ sessionId }) => ({ type: "deleted", sessionId }),
      archiveSession: async () => ({ type: "not_found" }),
    },
    history: { loadSessionRuntimeHistory: async ({ sessionId }) => {
      if (sessionId === "legacy") return { type: "found", initialEvents: [], events: [{ id: "legacy-message", type: "user.message", content: [{ type: "text", text: "old" }] }] };
      const result: any = { type: "found", revision, initialEvents: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }], events: structuredClone(facts), orderedEvents: facts.map((event, index) => ({ event: structuredClone(event), position: { revision: 1, index } })) };
      const pending = barrier;
      if (pending) { if (--pending.remaining === 0) { barrier = null; pending.release(); } await pending.ready; }
      return result;
    } },
    mapping: {
      prepareCreate: async () => ({ agent: { type: "latest", agentId: "agent" }, environmentId: "environment" }),
      sessionView: async session => {
        const { metadata: _metadata, ...agent } = normalizeAgentConfig({ model: "test" });
        return { id: session.id, object: "agent.session", created_at: 100, last_active_at: 101, agent: { ...agent, id: "agent" }, environment: { type: "none" }, status: "idle", error: null, metadata: {}, required_actions: [], usage: null, vault_ids: [] } as any;
      },
      prepareMetadata: async () => ({}),
    },
  };
  const app = buildOpenAIAgentsProtocolApi(createSessionsHandler(deps));
  const client = new OpenAI({ apiKey: "local", baseURL: "http://localhost/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { client, facts, dispatched, records, native, deps, service,
    synchronizeNextHistories(count: number) { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); barrier = { remaining: count, ready, release }; },
    async pendingResult() {
      facts.push({ id: "call", type: "agent.custom_tool_use", name: "lookup", input: {} }, { id: "wait", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: ["call"] } });
      const session = await client.beta.agents.sessions.retrieve("session");
      const action = session.required_actions[0]!;
      if (action.type !== "function_call") throw new Error("Expected pending function");
      return { type: "agent.session.input.tool_result" as const, call_id: action.call_id, turn_id: action.turn_id, success: true, output: "result" };
    },
  };
}

describe("Session semantic review regressions", () => {
  it("pages subagents by their opening time, independently of their IDs", async () => {
    const f = fixture();
    f.facts.push({ id: "opened-first", type: "session.thread_created", sessionThreadId: "z-first", processedAt: new Date(103000).toISOString() }, { id: "opened-second", type: "session.thread_created", sessionThreadId: "a-second", processedAt: new Date(104000).toISOString() });
    const first = await f.client.beta.agents.sessions.subagents.list("session", { order: "asc", limit: 1 });
    expect(first.data.map(agent => agent.id)).toEqual(["z-first"]);
    expect(first.has_more).toBe(true);
    expect((await first.getNextPage()).data.map(agent => agent.id)).toEqual(["a-second"]);
  });

  it("excludes ambiguous legacy history from the collection while direct inspection explains the limitation", async () => {
    const f = fixture();
    f.records.set("legacy", { ...f.native, id: "legacy" });
    f.records.set("z-session", { ...f.native, id: "z-session" });
    const first = await f.client.beta.agents.sessions.list({ order: "asc", limit: 1 });
    expect(first.data.map(session => session.id)).toEqual(["session"]);
    expect(first.has_more).toBe(true);
    const next = await first.getNextPage();
    expect(next.data.map(session => session.id)).toEqual(["z-session"]);
    expect(next.has_more).toBe(false);
    await expect(f.client.beta.agents.sessions.retrieve("legacy")).rejects.toMatchObject({ status: 409, code: "history_order_unavailable" });
  });

  it("rejects a result for the turn cancelled earlier in the same batch without committing either event", async () => {
    const f = fixture(), result = await f.pendingResult();
    await expect(f.client.beta.agents.sessions.events.create("session", { events: [{ type: "agent.session.input.cancel" }, result] })).rejects.toMatchObject({ status: 400 });
    expect(f.dispatched).toHaveLength(0);
    expect(f.facts.filter(event => event.type.startsWith("user."))).toHaveLength(0);
  });

  it("preserves an authorized cancel then message batch in one native acceptance", async () => {
    const f = fixture(); await f.pendingResult();
    await f.client.beta.agents.sessions.events.create("session", { events: [{ type: "agent.session.input.cancel" }, { type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "next" }] }] }] });
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0].events.map((event: any) => event.type)).toEqual(["user.interrupt", "user.message"]);
  });

  it("accepts at most one concurrent result for the same pending call with distinct request keys", async () => {
    const f = fixture(), result = await f.pendingResult();
    f.synchronizeNextHistories(2);
    const attempts = await Promise.allSettled(["first", "second"].map(key => f.client.beta.agents.sessions.events.create("session", { events: [result], "Idempotency-Key": key })));
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(attempt => attempt.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(f.facts.filter(event => event.type === "user.custom_tool_result")).toHaveLength(1);
    expect(f.dispatched).toHaveLength(1);
  });

  it("replays an identical result key after the original acceptance consumed the action", async () => {
    const f = fixture(), result = await f.pendingResult();
    const request = { events: [result], "Idempotency-Key": "retry-result" };
    await f.client.beta.agents.sessions.events.create("session", request);
    await f.client.beta.agents.sessions.events.create("session", request);
    expect(f.dispatched).toHaveLength(1);
    expect(f.facts.filter(event => event.type === "user.custom_tool_result")).toHaveLength(1);
  });

  it("returns an original idempotent acceptance before checking its now-stale native revision", async () => {
    const f = fixture();
    const command = { sessionId: "session", expectedRevision: 1, idempotencyKey: "accepted", events: [{ type: "user.message" as const, content: [{ type: "text" as const, text: "once" }] }] };
    const accepted = await f.service.sendSessionEvents(command);
    expect(await f.service.sendSessionEvents(command)).toEqual(accepted);
    expect(await f.service.sendSessionEvents({ ...command, idempotencyKey: "distinct" })).toMatchObject({ type: "version_conflict" });
    expect(f.dispatched).toHaveLength(1);
    expect(f.facts).toHaveLength(1);
  });

  it("does not accept state-dependent results from a history source without a matching revision", async () => {
    const f = fixture(), result = await f.pendingResult();
    const load = f.deps.history.loadSessionRuntimeHistory;
    f.deps.history.loadSessionRuntimeHistory = async input => {
      const found = await load(input);
      if (found.type === "not_found") return found;
      const { revision: _revision, ...withoutRevision } = found;
      return withoutRevision;
    };
    await expect(f.client.beta.agents.sessions.events.create("session", { events: [result] })).rejects.toMatchObject({ status: 409, code: "history_revision_unavailable" });
    expect(f.dispatched).toHaveLength(0);
  });
});
