import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAIAgentsApi } from "../src/index";
import type { SessionEvent, SessionView, SessionsApplicationPort, TurnView } from "../src/ports";

const session: SessionView = {
  id: "sess_one",
  agent: { id: "agent_one", name: null, model: "gpt-5.4", instructions: "Help", reasoning: { effort: "medium", summary: null }, serviceTier: "auto", multiAgent: { enabled: false, maxConcurrentSubagents: null }, text: { format: { type: "text" }, verbosity: "medium" }, tools: [] },
  createdAt: 1800000000, lastActiveAt: 1800000001, environment: { type: "none" }, error: null,
  metadata: { project: "one" }, requiredActions: [], status: "idle", usage: null, vaultIds: [],
};
const turn: TurnView = { id: "turn_one", agentId: "agent_one", sessionId: "sess_one", subagentId: null, createdAt: 1800000002, startedAt: 1800000003, completedAt: 1800000004, status: "completed", error: null, usage: null };

function fixture(overrides: Partial<SessionsApplicationPort> = {}) {
  const ports: SessionsApplicationPort = {
    createSession: vi.fn(async () => ({ type: "success" as const, value: structuredClone(session) })),
    retrieveSession: vi.fn(async () => ({ type: "success" as const, value: structuredClone(session) })),
    updateSession: vi.fn(async () => ({ type: "success" as const, value: structuredClone(session) })),
    listSessions: vi.fn(async () => ({ type: "success" as const, value: { data: [structuredClone(session)], hasMore: false } })),
    deleteSession: vi.fn(async () => ({ type: "success" as const, value: { sessionId: "sess_one" } })),
    ...overrides,
  };
  const app = buildOpenAIAgentsApi({ sessions: ports });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => app.fetch(new Request(input, init));
  const client = new OpenAI({ apiKey: "test-key", baseURL: "http://openma.test/v1", fetch, maxRetries: 0 });
  return { ports, app, client };
}

describe("official OpenAI 7.15.0 session contract", () => {
  it("maps official create fields without losing explicit nulls or model overrides", async () => {
    const { client, ports } = fixture();
    const actual = await client.beta.agents.sessions.create({
      environment: { type: "none" }, agent_id: "agent_saved",
      agent: { model: "gpt-5.4", instructions: null, reasoning: { effort: "high", summary: null }, tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" }, defer_loading: true }] },
      metadata: null, vault_ids: ["vault_one"], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }, { type: "input_image", image_url: "https://example.com/image.png" }] }],
    });
    expect(ports.createSession).toHaveBeenCalledWith({ environment: { type: "none" }, agentId: "agent_saved", agent: { model: "gpt-5.4", instructions: null, reasoning: { effort: "high", summary: null }, tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" }, deferLoading: true }] }, metadata: null, vaultIds: ["vault_one"], input: [{ role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", imageUrl: "https://example.com/image.png" }] }] });
    expect(actual).toMatchObject({ id: "sess_one", object: "agent.session", created_at: 1800000000, last_active_at: 1800000001, status: "idle", agent: { id: "agent_one", multi_agent: { enabled: false, max_concurrent_subagents: null }, service_tier: "auto" }, usage: null, required_actions: [], vault_ids: [] });
  });

  it("lets the SDK paginate with the last session ID rather than a Claude page token", async () => {
    const listSessions = vi.fn<SessionsApplicationPort["listSessions"]>(async ({ after }) => ({ type: "success", value: after ? { data: [{ ...session, id: "sess_two" }], hasMore: false } : { data: [session], hasMore: true } }));
    const { client } = fixture({ listSessions });
    const ids = [];
    for await (const value of client.beta.agents.sessions.list({ agent_id: "agent_one", order: "asc", limit: 1 })) ids.push(value.id);
    expect(ids).toEqual(["sess_one", "sess_two"]);
    expect(listSessions.mock.calls).toEqual([[{ agentId: "agent_one", order: "asc", limit: 1 }], [{ agentId: "agent_one", order: "asc", limit: 1, after: "sess_one" }]]);
  });

  it("retrieves, clears metadata, and emits the OpenAI deletion discriminator", async () => {
    const { client, ports } = fixture();
    expect((await client.beta.agents.sessions.retrieve("sess_one")).id).toBe("sess_one");
    await client.beta.agents.sessions.update("sess_one", { metadata: null });
    expect(ports.updateSession).toHaveBeenCalledWith({ sessionId: "sess_one", metadata: null });
    expect(await client.beta.agents.sessions.delete("sess_one")).toEqual({ id: "sess_one", deleted: true, object: "agent.session.deleted" });
  });

  it("submits a tool result with its turn ID and idempotency header and returns no content", async () => {
    const sendEvents = vi.fn<NonNullable<SessionsApplicationPort["sendEvents"]>>(async () => ({ type: "success", value: undefined }));
    const { client } = fixture({ sendEvents });
    const { response, data } = await client.beta.agents.sessions.events.create("sess_one", { "Idempotency-Key": "retry-one", events: [{ type: "agent.session.input.tool_result", call_id: "call_one", turn_id: "turn_one", success: false, error: "Unavailable", output: null }] }).withResponse();
    expect(response.status).toBe(204);
    expect(data).toBeNull();
    expect(sendEvents).toHaveBeenCalledWith({ sessionId: "sess_one", idempotencyKey: "retry-one", events: [{ type: "toolResult", callId: "call_one", turnId: "turn_one", success: false, error: "Unavailable", output: null }] });
  });

  it("streams creation and completion as distinct session and turn events the SDK can consume", async () => {
    async function* events(): AsyncIterable<SessionEvent> {
      yield { type: "created", eventId: "evt_one", session };
      yield { type: "outputTextDelta", eventId: "evt_two", sessionId: "sess_one", turnId: "turn_one", itemId: "item_one", contentIndex: 0, outputIndex: 0, delta: "Hello" };
      yield { type: "turnCompleted", eventId: "evt_three", sessionId: "sess_one", turnId: "turn_one", turn, usage: null };
      yield { type: "idle", eventId: "evt_four", session };
    }
    const createSessionStream = vi.fn<NonNullable<SessionsApplicationPort["createSessionStream"]>>(async () => ({ type: "success", value: events() }));
    const streamEvents = vi.fn<NonNullable<SessionsApplicationPort["streamEvents"]>>(async () => ({ type: "success", value: events() }));
    const { client } = fixture({ createSessionStream, streamEvents });
    const created = await client.beta.agents.sessions.create({ environment: { type: "none" }, agent: { model: "gpt-5.4" }, input: "Hello", stream: true });
    const output = [];
    for await (const event of created) output.push(event);
    expect(output.map((event) => event.type)).toEqual(["agent.session.created", "agent.session.turn.output_text.delta", "agent.session.turn.completed", "agent.session.idle"]);
    expect(output[1]).toEqual({ type: "agent.session.turn.output_text.delta", event_id: "evt_two", session_id: "sess_one", turn_id: "turn_one", item_id: "item_one", content_index: 0, output_index: 0, delta: "Hello" });
    expect(output[2]).toMatchObject({ turn: { id: "turn_one", object: "agent.session.turn", status: "completed", completed_at: 1800000004 } });
    const live = await client.beta.agents.sessions.events.stream("sess_one");
    const liveTypes = [];
    for await (const event of live) liveTypes.push(event.type);
    expect(liveTypes).toEqual(output.map((event) => event.type));
  });

  it("passes cursor scope into item and turn reads and preserves nullable message IDs", async () => {
    const listItems = vi.fn<NonNullable<SessionsApplicationPort["listItems"]>>(async () => ({ type: "success", value: { hasMore: false, data: [{ type: "message", id: null, turnId: "turn_one", role: "user", content: [{ type: "text", text: "Hello" }], phase: null, status: "completed" }] } }));
    const listTurns = vi.fn<NonNullable<SessionsApplicationPort["listTurns"]>>(async () => ({ type: "success", value: { hasMore: false, data: [turn] } }));
    const retrieveTurn = vi.fn<NonNullable<SessionsApplicationPort["retrieveTurn"]>>(async () => ({ type: "success", value: turn }));
    const { client } = fixture({ listItems, listTurns, retrieveTurn });
    expect((await client.beta.agents.sessions.items.list("sess_one", { order: "asc", after: "item_zero" })).data).toEqual([{ type: "message", id: null, turn_id: "turn_one", role: "user", content: [{ type: "input_text", text: "Hello" }], phase: null, status: "completed" }]);
    expect(listItems).toHaveBeenCalledWith({ sessionId: "sess_one", order: "asc", after: "item_zero" });
    expect((await client.beta.agents.sessions.turns.list("sess_one")).data[0].status).toBe("completed");
    expect((await client.beta.agents.sessions.turns.retrieve("turn_one", { session_id: "sess_one" })).session_id).toBe("sess_one");
    expect(retrieveTurn).toHaveBeenCalledWith({ sessionId: "sess_one", turnId: "turn_one" });
  });

  it("preserves final text when the official stream omits text deltas", async () => {
    const { client } = fixture({ streamEvents: async () => ({ type: "success", value: (async function* (): AsyncIterable<SessionEvent> {
      yield { type: "outputTextDone", eventId: "evt_final", sessionId: "sess_one", turnId: "turn_one", itemId: "item_one", contentIndex: 0, outputIndex: 0, text: "Complete answer" };
    })() }) });
    const output = [];
    for await (const event of await client.beta.agents.sessions.events.stream("sess_one")) output.push(event);
    expect(output).toEqual([{ type: "agent.session.turn.output_text.done", event_id: "evt_final", session_id: "sess_one", turn_id: "turn_one", item_id: "item_one", content_index: 0, output_index: 0, text: "Complete answer" }]);
  });

  it("rejects hosted creation before side effects when its response contract is not implemented", async () => {
    const { client, ports } = fixture();
    await expect(client.beta.agents.sessions.create({ environment: { type: "openai_hosted", environment_template_id: "env_one" }, agent: { model: "gpt-5.4" } })).rejects.toMatchObject({ status: 501, error: { code: "unsupported_feature", param: "environment.type" } });
    expect(ports.createSession).not.toHaveBeenCalled();
  });

  it("requires initial input for environment none, as required by the guide beyond SDK types", async () => {
    const { client, ports } = fixture();
    await expect(client.beta.agents.sessions.create({ environment: { type: "none" }, agent: { model: "gpt-5.4" } })).rejects.toMatchObject({ status: 400, error: { param: "input" } });
    expect(ports.createSession).not.toHaveBeenCalled();
  });

  it("returns SDK-classified errors instead of swallowing unsupported capabilities or conflicts", async () => {
    const { client } = fixture({ retrieveSession: async () => ({ type: "notFound", message: "Session missing" }), updateSession: async () => ({ type: "conflict", message: "Session changed" }) });
    await expect(client.beta.agents.sessions.retrieve("missing")).rejects.toMatchObject({ status: 404, error: { code: "resource_not_found", type: "invalid_request_error", message: "Session missing" } });
    await expect(client.beta.agents.sessions.update("sess_one")).rejects.toMatchObject({ status: 409 });
    await expect(client.beta.agents.sessions.events.create("sess_one", { events: [{ type: "agent.session.input.cancel" }] })).rejects.toMatchObject({ status: 501, error: { code: "unsupported_feature" } });
  });

  it.each([
    { environment: { type: "none" } },
    { environment: { type: "none" }, agent: { model: "gpt-5.4" }, surprise: true },
    { environment: { type: "none" }, agent: { model: "gpt-5.4", text: { format: { type: "json_schema", name: "output", schema: {} } } } },
    { environment: { type: "none" }, agent: { model: "gpt-5.4" }, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"])) },
  ])("rejects invalid or unsupported request fields before any application mutation: %j", async (body) => {
    const { app, ports } = fixture();
    const response = await app.request("/v1/agents/sessions", { method: "POST", headers: { "OpenAI-Beta": "agents=v1", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("invalid_request_error");
    expect(ports.createSession).not.toHaveBeenCalled();
  });

  it("requires the exact agents beta token, validates query strings, and rejects malformed JSON", async () => {
    const { app, ports } = fixture();
    expect((await app.request("/v1/agents/sessions", { headers: { "OpenAI-Beta": "not-agents=v1" } })).status).toBe(400);
    expect((await app.request("/v1/agents/sessions?limit=0", { headers: { "OpenAI-Beta": "other=v1, agents=v1" } })).status).toBe(400);
    expect((await app.request("/v1/agents/sessions?unrecognized=true", { headers: { "OpenAI-Beta": "agents=v1" } })).status).toBe(400);
    expect((await app.request("/v1/agents/sessions", { method: "POST", headers: { "OpenAI-Beta": "agents=v1", "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect(ports.listSessions).not.toHaveBeenCalled();
    expect(ports.createSession).not.toHaveBeenCalled();
  });

  it("validates serialized responses independently of the SDK's permissive deserializer", async () => {
    const { client } = fixture({ retrieveSession: async () => ({ type: "success", value: { ...session, createdAt: -1 } }) });
    await expect(client.beta.agents.sessions.retrieve("sess_one")).rejects.toMatchObject({ status: 500, error: { type: "server_error", code: "invalid_application_response" } });
  });

  it("rejects unknown application resource variants instead of relabeling them as supported ones", async () => {
    const { client } = fixture({
      retrieveSession: async () => ({ type: "success", value: { ...session, environment: { type: "future_environment", id: "env_one", workspaceDirectory: "/workspace", capabilityDirectories: [], remoteUrl: "wss://example.com" } as unknown as SessionView["environment"] } }),
      listItems: async () => ({ type: "success", value: { hasMore: false, data: [{ type: "future_item" as "message", id: "item_one", turnId: "turn_one", role: "user", content: [{ type: "text", text: "Hello" }], phase: null, status: "completed" }] } }),
    });
    await expect(client.beta.agents.sessions.retrieve("sess_one")).rejects.toMatchObject({ status: 500 });
    await expect(client.beta.agents.sessions.items.list("sess_one")).rejects.toMatchObject({ status: 500 });
  });

  it("does not expose internal exceptions or falsely turn an invalid stream into success", async () => {
    const { client } = fixture({ retrieveSession: async () => { throw new Error("SECRET_DATABASE_URL"); }, streamEvents: async () => ({ type: "success", value: (async function* () { yield { type: "idle", eventId: "bad", session: { ...session, status: "terminated" as SessionView["status"] } }; })() }) });
    await expect(client.beta.agents.sessions.retrieve("sess_one")).rejects.toMatchObject({ status: 500, message: expect.not.stringContaining("SECRET_DATABASE_URL") });
    const events = await client.beta.agents.sessions.events.stream("sess_one");
    await expect((async () => { for await (const _event of events) { /* consume */ } })()).rejects.toThrow();
  });

  it("serializes stream failures with the official session error envelope", async () => {
    const { app } = fixture({ streamEvents: async () => ({ type: "success", value: (async function* (): AsyncIterable<SessionEvent> { throw new Error("SECRET_DATABASE_URL"); })() }) });
    const response = await app.request("/v1/agents/sessions/sess_one/events", { headers: { "OpenAI-Beta": "agents=v1" } });
    const text = await response.text();
    const payload = JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(payload).toEqual({ type: "error", event_id: expect.any(String), session_id: "sess_one", error: { type: "server_error", code: "invalid_application_response", message: "Application event stream failed", param: null } });
    expect(text).not.toContain("SECRET_DATABASE_URL");
  });

  it("passes an already cancelled subscription signal and releases the request listener on port failure", async () => {
    let subscription: AbortSignal | undefined;
    const { app } = fixture({ streamEvents: async (_query, signal) => { subscription = signal; return { type: "notFound", message: "Missing" }; } });
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://openma.test/v1/agents/sessions/missing/events", { headers: { "OpenAI-Beta": "agents=v1" }, signal: controller.signal });
    const removed = vi.spyOn(request.signal, "removeEventListener");
    const response = await app.fetch(request);
    expect(response.status).toBe(404);
    expect(subscription?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("releases the subscription without submitting a turn cancellation when the stream ends", async () => {
    let subscription: AbortSignal | undefined;
    const sendEvents = vi.fn<NonNullable<SessionsApplicationPort["sendEvents"]>>(async () => ({ type: "success", value: undefined }));
    const { client } = fixture({ sendEvents, streamEvents: async (_query, signal) => { subscription = signal; return { type: "success", value: (async function* (): AsyncIterable<SessionEvent> { yield { type: "idle", eventId: "evt_idle", session }; })() }; } });
    const stream = await client.beta.agents.sessions.events.stream("sess_one");
    for await (const _event of stream) { /* consume */ }
    expect(subscription?.aborted).toBe(true);
    expect(sendEvents).not.toHaveBeenCalled();
  });
});
