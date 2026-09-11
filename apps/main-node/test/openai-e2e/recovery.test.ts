import { afterEach, describe, expect, it } from "vitest";
import { bootOpenAINode, type OpenAINodeModel, type OpenAINodeProcess } from "../_helpers/openai-node-process";

const fixtures: OpenAINodeProcess[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose(); });
async function boot(reply?: OpenAINodeModel) {
  const fixture = await bootOpenAINode(reply, { startupTimeoutMs: 60_000 });
  fixtures.push(fixture);
  return fixture;
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let latest: T;
  do {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Recovery state did not settle: ${JSON.stringify(latest!)}`);
}

function hasMessage(items: Array<{ type: string }>, text: string): boolean {
  return items.some(item => item.type === "message" && "content" in item && JSON.stringify(item.content).includes(text));
}

describe("OpenAI Node persistence recovery E2E", () => {
  it("retains a waiting function action across a real process restart and resumes its original Turn once", async () => {
    const fixture = await boot();
    const session = await fixture.client.beta.agents.sessions.create({
      agent: { model: "claude-sonnet-4-20250514", tools: [{ type: "function", name: "lookup", description: "Return a stored answer", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] },
      environment: { type: "none" }, input: "Read the answer",
    });
    const waiting = await until(() => fixture.client.beta.agents.sessions.retrieve(session.id), value => value.status === "requires_action");
    const action = waiting.required_actions[0]!;
    expect(action).toMatchObject({ type: "function_call", name: "lookup", arguments: { key: "answer" } });
    if (action.type !== "function_call") throw new Error("Expected a function action");
    const beforeTurns = (await fixture.client.beta.agents.sessions.turns.list(session.id)).data;
    const beforeItems = (await fixture.client.beta.agents.sessions.items.list(session.id)).data;
    const call = beforeItems.find(item => item.type === "function_call");
    expect(call).toMatchObject({ turn_id: action.turn_id, call_id: action.call_id });
    expect(fixture.requests).toHaveLength(1);

    await fixture.restart();

    const restored = await fixture.client.beta.agents.sessions.retrieve(session.id);
    expect(restored).toMatchObject({ id: session.id, status: "requires_action", required_actions: waiting.required_actions });
    expect((await fixture.client.beta.agents.sessions.turns.list(session.id)).data).toEqual(beforeTurns);
    expect((await fixture.client.beta.agents.sessions.items.list(session.id)).data).toEqual(beforeItems);
    const body = { events: [{ type: "agent.session.input.tool_result" as const,
      turn_id: action.turn_id, call_id: action.call_id, success: true as const, output: "42" }],
      "Idempotency-Key": "function-result-after-process-restart" };
    await fixture.client.beta.agents.sessions.events.create(session.id, body);
    await until(async () => (await fixture.client.beta.agents.sessions.turns.list(session.id)).data.filter(turn => turn.subagent_id === null),
      turns => turns.some(turn => turn.id === action.turn_id && turn.status === "completed"));
    const finished = (await fixture.client.beta.agents.sessions.items.list(session.id)).data;
    expect(hasMessage(finished, "NATIVE_TOOL_RESULT_OK")).toBe(true);
    expect(finished.filter(item => item.type === "function_call")).toEqual([expect.objectContaining({ id: call!.id, turn_id: action.turn_id, status: "completed" })]);
    expect(finished.filter(item => item.type === "function_call_output")).toHaveLength(1);

    await fixture.client.beta.agents.sessions.events.create(session.id, body);
    expect((await fixture.client.beta.agents.sessions.items.list(session.id)).data).toEqual(finished);
    expect((await fixture.client.beta.agents.sessions.turns.list(session.id)).data).toEqual([
      expect.objectContaining({ id: action.turn_id, status: "completed" }),
    ]);
    expect(fixture.requests).toHaveLength(2);
    expect((await fixture.client.beta.agents.sessions.retrieve(session.id)).required_actions).toEqual([]);
  }, 150_000);

  it("restores V1 child identity and history when a new parent Turn resumes and sends after process restart", async () => {
    let restoredChildId: string | undefined;
    const childRequests: Array<Record<string, any>> = [];
    const fixture = await boot(input => {
      if (JSON.stringify(input.system).includes("RECOVERY_CHILD_INSTRUCTIONS")) {
        childRequests.push(input);
        const latest = JSON.stringify(input.messages.at(-1));
        return { text: latest.includes("FINAL_CHILD_INPUT") ? "CHILD_FINAL_ANSWER" : latest.includes("FOLLOWUP_CHILD_INPUT") ? "CHILD_AFTER_RESTART" : "CHILD_BEFORE_RESTART" };
      }
      const blocks = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      const calls = blocks.filter((part: any) => part.type === "tool_use");
      const creation = calls.find((call: any) => call.name === "create_subagent");
      const result = blocks.find((part: any) => part.type === "tool_result" && part.tool_use_id === creation?.id);
      const resultText = result && (typeof result.content === "string" ? result.content : result.content.map((part: any) => part.text ?? "").join(""));
      const childId = restoredChildId ?? (resultText ? JSON.parse(resultText).id : undefined);
      const followup = JSON.stringify(input.messages).includes("CONTINUE_AFTER_RESTART");
      if (!followup) {
        return [
          { name: "create_subagent", input: { name: "Recovery worker", instructions: "RECOVERY_CHILD_INSTRUCTIONS", message: "INITIAL_CHILD_INPUT" } },
          { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
          { name: "close_subagent", input: { id: childId } },
        ][calls.length] ?? { text: "PARENT_BEFORE_RESTART" };
      }
      return [
        { name: "resume_subagent", input: { id: childId, message: "FOLLOWUP_CHILD_INPUT" } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "send_subagent_input", input: { id: childId, message: "FINAL_CHILD_INPUT" } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "close_subagent", input: { id: childId } },
      ][calls.length - 3] ?? { text: "PARENT_AFTER_RESTART" };
    });
    const session = await fixture.client.beta.agents.sessions.create({
      agent: { model: "claude-sonnet-4-20250514", instructions: "Coordinate a child and keep its identity", multi_agent: { enabled: true, max_concurrent_subagents: 1 } },
      environment: { type: "none" }, input: "Start the first delegated task",
    });
    await until(async () => (await fixture.client.beta.agents.sessions.turns.list(session.id)).data.filter(turn => turn.subagent_id === null),
      turns => turns.length === 1 && turns[0]?.status === "completed");
    const parentBefore = (await fixture.client.beta.agents.sessions.items.list(session.id)).data;
    expect(hasMessage(parentBefore, "PARENT_BEFORE_RESTART")).toBe(true);
    const child = (await fixture.client.beta.agents.sessions.subagents.list(session.id)).data[0]!;
    expect(child).toMatchObject({ status: "closed", parent_agent_id: session.agent.id });
    restoredChildId = child.id;
    const childBefore = (await fixture.client.beta.agents.sessions.subagents.items.list(child.id, { session_id: session.id })).data;
    expect(hasMessage(childBefore, "CHILD_BEFORE_RESTART")).toBe(true);

    await fixture.restart();

    expect(await fixture.client.beta.agents.sessions.subagents.retrieve(child.id, { session_id: session.id })).toEqual(child);
    expect((await fixture.client.beta.agents.sessions.subagents.items.list(child.id, { session_id: session.id })).data).toEqual(childBefore);
    await fixture.client.beta.agents.sessions.events.create(session.id, { events: [{
      type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "CONTINUE_AFTER_RESTART" }] }],
    }] });
    const rootTurns = await until(async () => (await fixture.client.beta.agents.sessions.turns.list(session.id)).data.filter(turn => turn.subagent_id === null),
      turns => turns.length === 2 && turns.every(turn => turn.status === "completed"));
    expect(new Set(rootTurns.map(turn => turn.id)).size).toBe(2);
    const childAfter = (await fixture.client.beta.agents.sessions.subagents.items.list(child.id, { session_id: session.id, limit: 100 })).data;
    for (const text of ["CHILD_BEFORE_RESTART", "CHILD_AFTER_RESTART", "CHILD_FINAL_ANSWER"]) expect(hasMessage(childAfter, text)).toBe(true);
    expect(hasMessage(childAfter, "PARENT_AFTER_RESTART")).toBe(false);
    expect((await fixture.client.beta.agents.sessions.subagents.list(session.id)).data).toEqual([
      expect.objectContaining({ id: child.id, status: "closed", parent_agent_id: session.agent.id }),
    ]);
    expect((await fixture.client.beta.agents.sessions.subagents.turns.list(child.id, { session_id: session.id })).data.filter(turn => turn.status === "completed")).toHaveLength(3);
    expect(childRequests).toHaveLength(3);
    expect(JSON.stringify(childRequests[1]!.messages)).toContain("CHILD_BEFORE_RESTART");
    expect(JSON.stringify(childRequests[2]!.messages)).toContain("CHILD_AFTER_RESTART");
    expect(childRequests.every(request => !(request.tools ?? []).some((tool: any) => tool.name === "create_subagent"))).toBe(true);
  }, 150_000);
});
