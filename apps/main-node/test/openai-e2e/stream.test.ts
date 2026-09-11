import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "openai/resources/beta/agents/agents";
import type { SessionCreateParams } from "openai/resources/beta/agents/sessions/sessions";
import { bootOpenAINode } from "../_helpers/openai-node-process.js";

type Fixture = Awaited<ReturnType<typeof bootOpenAINode>>;
const fixtures: Fixture[] = [];
const subscriptions: AbortController[] = [];

afterEach(async () => {
  for (const controller of subscriptions.splice(0)) controller.abort();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
});

async function boot(reply?: Parameters<typeof bootOpenAINode>[0]) {
  const fixture = await bootOpenAINode(body => JSON.stringify(body.messages?.at(-1)).includes("BOOTSTRAP_STREAM")
    ? { text: "READY_FOR_STREAM" }
    : reply ? reply(body) : { text: "STREAM_COMPLETE" });
  fixtures.push(fixture);
  return fixture;
}

function subscription() {
  const controller = new AbortController();
  subscriptions.push(controller);
  return controller;
}

async function collect(source: AsyncIterable<AgentSessionEvent>) {
  const events: AgentSessionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const agent = { model: "claude-sonnet-4-20250514", instructions: "Follow the user's request." };

async function idleSession(fixture: Fixture, config: SessionCreateParams["agent"] = agent) {
  const session = await fixture.client.beta.agents.sessions.create({
    agent: config, environment: { type: "none" }, input: "BOOTSTRAP_STREAM",
  });
  await vi.waitFor(async () => {
    expect((await fixture.client.beta.agents.sessions.turns.list(session.id)).data).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(await fixture.client.beta.agents.sessions.retrieve(session.id)).toMatchObject({ status: "idle" });
  }, { timeout: 15_000, interval: 50 });
  return session;
}

describe("OpenAI sessions streaming through the production Node process", { timeout: 90_000 }, () => {
  it("completes one turn when the SDK subscribes before input and automatically returns a function result", async () => {
    // A lost first event or a new turn after tool return breaks the public helper.
    const fixture = await boot(body => {
      const messages = JSON.stringify(body.messages);
      return messages.includes('"tool_result"')
        ? { text: messages.includes("42") ? "LOOKUP_42_CONFIRMED" : "TOOL_RESULT_MISSING" }
        : { name: "lookup", input: { key: "answer" } };
    });
    const session = await idleSession(fixture, {
      ...agent,
      tools: [{ type: "function", name: "lookup", description: "Look up a key", parameters: {
        type: "object", properties: { key: { type: "string" } }, required: ["key"],
      } }],
    });
    const handlerInputs: Record<string, unknown>[] = [];
    const events = await collect(fixture.client.beta.agents.sessions.stream(session.id, {
      input: "Look up answer",
      toolHandlers: { lookup: async input => { handlerInputs.push(input); return { answer: 42 }; } },
    }, { signal: subscription().signal }));

    expect(handlerInputs).toEqual([{ key: "answer" }]);
    const created = events.filter(event => event.type === "agent.session.turn.created");
    expect(created, fixture.logs.join("")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.session.turn.completed")).toEqual([
      expect.objectContaining({ turn_id: created[0]!.turn_id }),
    ]);
    expect(events.at(-1)?.type).toBe("agent.session.idle");
    const turns = (await fixture.client.beta.agents.sessions.turns.list(session.id)).data;
    expect(turns).toHaveLength(2);
    expect(turns).toContainEqual(expect.objectContaining({ id: created[0]!.turn_id, status: "completed" }));
    const items = (await fixture.client.beta.agents.sessions.items.list(session.id, { limit: 100 })).data.filter(item => item.turn_id === created[0]!.turn_id);
    expect(items.filter(item => item.type === "function_call")).toHaveLength(1);
    expect(items.filter(item => item.type === "function_call_output")).toHaveLength(1);
    expect(items).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", content: [
      expect.objectContaining({ type: "output_text", text: "LOOKUP_42_CONFIRMED" }),
    ] }));
    expect(new Set(items.map(item => item.turn_id))).toEqual(new Set([created[0]!.turn_id]));
    expect(await fixture.client.beta.agents.sessions.retrieve(session.id)).toMatchObject({ status: "idle", required_actions: [] });
  });

  it("aborts the local subscription and persists a cancelled turn only after explicit API cancellation", async () => {
    // Disconnecting SSE must not cancel execution; the cancellation input must.
    const fixture = await boot(() => null);
    const session = await idleSession(fixture);
    const controller = subscription();
    const outcome = collect(fixture.client.beta.agents.sessions.stream(session.id, { input: "Wait for cancellation" }, {
      signal: controller.signal,
    })).then(events => ({ events, error: undefined }), error => ({ events: undefined, error }));
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(2), { timeout: 15_000, interval: 25 });
    controller.abort(new Error("Consumer disconnected"));
    const stopped = await outcome;
    expect(stopped.error).toBeInstanceOf(Error);
    expect(await fixture.client.beta.agents.sessions.retrieve(session.id)).toMatchObject({ status: "in_progress" });

    const resumed = await fixture.client.beta.agents.sessions.events.stream(session.id, { signal: subscription().signal });
    const cancellation = (async () => {
      const events: AgentSessionEvent[] = [];
      let cancelled = false;
      for await (const event of resumed) {
        events.push(event);
        if (event.type === "agent.session.turn.cancelled") cancelled = true;
        if (cancelled && event.type === "agent.session.idle") break;
      }
      return events;
    })();
    await fixture.client.beta.agents.sessions.events.create(session.id, { events: [{ type: "agent.session.input.cancel" }] });
    const events = await cancellation;
    expect(events.filter(event => event.type === "agent.session.turn.cancelled")).toHaveLength(1);
    const cancelled = events.find(event => event.type === "agent.session.turn.cancelled")!;
    expect(events.some(event => event.type === "agent.session.turn.completed" && event.turn_id === cancelled.turn_id)).toBe(false);
    expect(events.at(-1)?.type).toBe("agent.session.idle");
    const turns = (await fixture.client.beta.agents.sessions.turns.list(session.id)).data;
    expect(turns).toHaveLength(2);
    expect(turns).toContainEqual(expect.objectContaining({ id: cancelled.turn_id, status: "cancelled" }));
    expect(await fixture.client.beta.agents.sessions.retrieve(session.id)).toMatchObject({ status: "idle" });
  });

  it("recovers disconnected history through Items and Turns before subscribing to new live events", async () => {
    // The official event stream is live-only. Missing work comes from durable Items/Turns,
    // not an undocumented SSE after cursor. Replaying old turns would select the wrong SDK turn.
    const fixture = await boot(body => {
      const input = JSON.stringify(body.messages.at(-1));
      return { text: input.includes("LIVE_INPUT") ? "LIVE_OUTPUT" : input.includes("MISSED_INPUT") ? "MISSED_OUTPUT" : "FIRST_OUTPUT" };
    });
    const session = await idleSession(fixture);
    const first = await collect(fixture.client.beta.agents.sessions.stream(session.id, { input: "FIRST_INPUT" }, {
      signal: subscription().signal,
    }));
    await fixture.client.beta.agents.sessions.events.create(session.id, { events: [{
      type: "agent.session.input.message",
      input: [{ role: "user", content: [{ type: "input_text", text: "MISSED_INPUT" }] }],
    }] });
    await vi.waitFor(async () => {
      const turns = (await fixture.client.beta.agents.sessions.turns.list(session.id)).data;
      expect(turns).toHaveLength(3);
      expect(turns.every(turn => turn.status === "completed")).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    const history = (await fixture.client.beta.agents.sessions.items.list(session.id, { limit: 100 })).data;
    expect(history).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "MISSED_OUTPUT" })] }));
    const historicTurnIds = new Set(history.map(item => item.turn_id));
    const stream = await fixture.client.beta.agents.sessions.events.stream(session.id, {
      signal: subscription().signal,
    });
    const receiving = (async () => {
      const events: AgentSessionEvent[] = [];
      let completed = false;
      for await (const event of stream) {
        events.push(event);
        if (event.type === "agent.session.turn.completed") completed = true;
        if (completed && event.type === "agent.session.idle") break;
      }
      return events;
    })();
    await fixture.client.beta.agents.sessions.events.create(session.id, { events: [{
      type: "agent.session.input.message",
      input: [{ role: "user", content: [{ type: "input_text", text: "LIVE_INPUT" }] }],
    }] });
    const resumed = await receiving;
    const firstEventIds = new Set(first.map(event => event.event_id));
    expect(resumed.some(event => firstEventIds.has(event.event_id))).toBe(false);
    expect(new Set(resumed.map(event => event.event_id)).size).toBe(resumed.length);
    const created = resumed.filter(event => event.type === "agent.session.turn.created");
    expect(created).toHaveLength(1);
    expect(historicTurnIds.has(created[0]!.turn_id)).toBe(false);
    expect(resumed.at(-1)?.type).toBe("agent.session.idle");
    const turns = (await fixture.client.beta.agents.sessions.turns.list(session.id)).data;
    expect(turns).toHaveLength(4);
    expect(turns.every(turn => turn.status === "completed")).toBe(true);
    expect((await fixture.client.beta.agents.sessions.items.list(session.id, { limit: 100 })).data).toContainEqual(
      expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "LIVE_OUTPUT" })] }),
    );
  });

  it("keeps the root SDK stream open until the root turn completes after its V1 child", async () => {
    // A child terminal mapped to the root lane would stop the helper before ROOT_STREAM_DONE.
    const fixture = await boot(body => {
      if (JSON.stringify(body.system).includes("STREAM_CHILD_INSTRUCTIONS")) return { text: "CHILD_STREAM_DONE" };
      const blocks = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      const calls = blocks.filter((block: any) => block.type === "tool_use");
      if (calls.length === 0) return { name: "create_subagent", input: {
        name: "Stream worker", instructions: "STREAM_CHILD_INSTRUCTIONS", message: "Finish your assigned task",
      } };
      if (calls.length === 1) {
        const result = blocks.find((block: any) => block.type === "tool_result" && block.tool_use_id === calls[0].id);
        const text = typeof result?.content === "string" ? result.content : result?.content.map((block: any) => block.text ?? "").join("");
        const child = JSON.parse(text);
        return { name: "wait_for_subagents", input: { ids: [child.id], timeout_ms: 5000 } };
      }
      return { text: "ROOT_STREAM_DONE" };
    });
    const session = await idleSession(fixture, { ...agent, multi_agent: { enabled: true, max_concurrent_subagents: 1 } });
    const events = await collect(fixture.client.beta.agents.sessions.stream(session.id, {
      input: "Delegate one task and wait for its result",
    }, { signal: subscription().signal }));
    const created = events.filter(event => event.type === "agent.session.turn.created");
    const root = created.find(event => event.turn.subagent_id === null);
    const child = created.find(event => event.turn.subagent_id !== null);
    expect(root, fixture.logs.join("")).toBeDefined();
    expect(child, fixture.logs.join("")).toBeDefined();
    const childCompleted = events.findIndex(event => event.type === "agent.session.turn.completed" && event.turn_id === child!.turn_id);
    const rootCompleted = events.findIndex(event => event.type === "agent.session.turn.completed" && event.turn_id === root!.turn_id);
    expect(childCompleted).toBeGreaterThanOrEqual(0);
    expect(rootCompleted).toBeGreaterThan(childCompleted);
    expect(events.at(-1)?.type).toBe("agent.session.idle");
    const rootItems = (await fixture.client.beta.agents.sessions.items.list(session.id, { limit: 100 })).data;
    expect(rootItems).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "ROOT_STREAM_DONE" })] }));
    expect(rootItems.some(item => "content" in item && JSON.stringify(item.content).includes("CHILD_STREAM_DONE"))).toBe(false);
    const children = (await fixture.client.beta.agents.sessions.subagents.list(session.id)).data;
    expect(children).toEqual([expect.objectContaining({ id: child!.turn.subagent_id, parent_agent_id: session.agent.id })]);
    const childItems = (await fixture.client.beta.agents.sessions.subagents.items.list(children[0]!.id, { session_id: session.id, limit: 100 })).data;
    expect(childItems).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "CHILD_STREAM_DONE" })] }));
  });
});
