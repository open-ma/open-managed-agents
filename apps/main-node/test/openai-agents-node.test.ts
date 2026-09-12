import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootOpenAINode, type OpenAINodeModel, type OpenAINodeProcess } from "./_helpers/openai-node-process";

const fixtures: OpenAINodeProcess[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose(); });
async function boot(reply?: OpenAINodeModel) {
  const fixture = await bootOpenAINode(reply);
  fixtures.push(fixture);
  return fixture;
}

describe("production Node OpenAI mount", { timeout: 90_000 }, () => {
  it("executes the subagent lifecycle through native threads and exposes isolated SDK histories", async () => {
    let heldChild = false;
    const childRequests: Array<Record<string, any>> = [];
    const f = await boot(async input => {
      if (JSON.stringify(input.system).includes("CHILD_SUBAGENT_TEST")) {
        childRequests.push(input);
        const lastInput = JSON.stringify(input.messages.at(-1));
        if (lastInput.includes("HOLD_CHILD")) { heldChild = true; return null; }
        return { text: lastInput.includes("THIRD_CHILD") ? "CHILD_THIRD_OK" : lastInput.includes("SECOND_CHILD") ? "CHILD_SECOND_OK" : "CHILD_FIRST_OK" };
      }
      const blocks = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      const calls = blocks.filter((part: any) => part.type === "tool_use");
      const creation = calls.find((call: any) => call.name === "create_subagent");
      const result = blocks.find((part: any) => part.type === "tool_result" && part.tool_use_id === creation?.id);
      let childId = "missing-child";
      if (result) {
        const text = typeof result.content === "string" ? result.content : result.content.map((part: any) => part.text ?? "").join("");
        try { const parsed = JSON.parse(text); childId = parsed.id ?? parsed.thread_id ?? parsed.threadId; } catch { /* Assertion below reports the production failure. */ }
      }
      const steps = [
        { name: "create_subagent", input: { name: "Worker", instructions: "CHILD_SUBAGENT_TEST", message: "FIRST_CHILD" } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "send_subagent_input", input: { id: childId, message: "SECOND_CHILD" } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "close_subagent", input: { id: childId } },
        { name: "resume_subagent", input: { id: childId, message: "THIRD_CHILD" } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "send_subagent_input", input: { id: childId, message: "HOLD_CHILD" } },
        { name: "interrupt_subagent", input: { id: childId } },
        { name: "wait_for_subagents", input: { ids: [childId], timeout_ms: 5000 } },
        { name: "close_subagent", input: { id: childId } },
      ];
      if (calls.length === 8) {
        for (let attempt = 0; attempt < 100 && !heldChild; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      }
      return steps[calls.length] ?? { text: "ROOT_SUBAGENTS_DONE" };
    });
    const session = await f.client.beta.agents.sessions.create({ agent: { model: "claude-sonnet-4-20250514", instructions: "ROOT_SUBAGENT_TEST", multi_agent: { enabled: true, max_concurrent_subagents: 2 }, tools: [{ type: "function", name: "root_only_function", description: "Available to the main agent only", parameters: { type: "object" } }] }, environment: { type: "none" }, input: "Coordinate independent work" });
    let items: any[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      items = (await f.client.beta.agents.sessions.items.list(session.id, { limit: 100 })).data;
      if (items.some(item => item.content?.some((part: any) => part.text === "ROOT_SUBAGENTS_DONE"))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(items, f.logs.join("")).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "ROOT_SUBAGENTS_DONE" })] }));
    for (const type of ["create_subagent_call", "send_subagent_input_call", "wait_for_subagents_call", "interrupt_subagent_call", "close_subagent_call", "resume_subagent_call"]) {
      expect(items).toContainEqual(expect.objectContaining({ type, status: "completed" }));
    }
    const children = (await f.client.beta.agents.sessions.subagents.list(session.id)).data;
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child).toMatchObject({ parent_agent_id: session.agent.id, status: "closed" });
    expect(await f.client.beta.agents.sessions.subagents.retrieve(child.id, { session_id: session.id })).toEqual(child);
    const childItems = (await f.client.beta.agents.sessions.subagents.items.list(child.id, { session_id: session.id, limit: 100 })).data;
    for (const text of ["CHILD_FIRST_OK", "CHILD_SECOND_OK", "CHILD_THIRD_OK"]) {
      expect(childItems).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text })] }));
    }
    expect(childItems.some(item => "content" in item && JSON.stringify(item.content).includes("ROOT_SUBAGENTS_DONE"))).toBe(false);
    const turns = (await f.client.beta.agents.sessions.subagents.turns.list(child.id, { session_id: session.id })).data;
    expect(turns.filter(turn => turn.status === "completed")).toHaveLength(3);
    expect(turns).toContainEqual(expect.objectContaining({ subagent_id: child.id, status: "cancelled" }));
    expect(heldChild).toBe(true);
    expect(childRequests).toHaveLength(4);
    const subagentControls = new Set(["create_subagent", "send_subagent_input", "wait_for_subagents", "interrupt_subagent", "close_subagent", "resume_subagent"]);
    const parentRequests = f.requests.filter(request => !childRequests.includes(request));
    expect(parentRequests.some(request => (request.tools ?? []).some((tool: any) => tool.name === "create_subagent"))).toBe(true);
    expect(childRequests.every(request => !(request.tools ?? []).some((tool: any) => subagentControls.has(tool.name)))).toBe(true);
    expect(childRequests.every(request => !(request.tools ?? []).some((tool: any) => tool.name === "root_only_function"))).toBe(true);
    expect(JSON.stringify(childRequests[0]!.messages)).not.toContain("Coordinate independent work");
    expect(JSON.stringify(childRequests[1]!.messages)).toContain("CHILD_FIRST_OK");
  });
  it("runs a none session through the real native runtime, SQL history and official SDK without allocating a sandbox", async () => {
    const f = await boot();
    const agent = await f.client.beta.agents.create({ model: "claude-sonnet-4-20250514", name: "SDK native" });
    const session = await f.client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: "none" }, input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }, { role: "user", content: [{ type: "input_text", text: "Answer both inputs together" }] }], metadata: { proof: "same native session" } });
    expect(session.environment).toEqual({ type: "none" });
    let items: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      items = (await f.client.beta.agents.sessions.items.list(session.id)).data;
      if (items.some(item => item.content?.some((part: any) => part.text === "NATIVE_NONE_OK"))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(items, f.logs.join("")).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "NATIVE_NONE_OK" })] }));
    expect(items.filter(item => item.type === "message" && item.role === "user")).toHaveLength(2);
    expect(new Set(items.map(item => item.turn_id)).size).toBe(1);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests[0]!.tools ?? []).toEqual([]);
    await expect(stat(join(f.directory, "sandboxes", session.id))).rejects.toMatchObject({ code: "ENOENT" });
    const native = await fetch(`${f.baseURL}/v1/sessions/${session.id}`, { headers: { "x-api-key": "test", "anthropic-beta": "managed-agents-2026-04-01" } });
    expect(native.status).toBe(200);
    expect(await native.json()).toMatchObject({ id: session.id });
    expect((await f.client.beta.agents.sessions.turns.list(session.id)).data).toContainEqual(expect.objectContaining({ status: "completed" }));
    await expect(f.client.beta.agents.environments.retrieve(`oai_env_${session.id}`)).rejects.toMatchObject({ status: 404 });
  });
  it("continues the same real turn after an official function result and deduplicates a retry", async () => {
    const f = await boot();
    const created = await f.client.beta.agents.sessions.create({ agent: { model: "claude-sonnet-4-20250514", tools: [{ type: "function", name: "lookup", description: "Lookup a key", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] }, environment: { type: "none" }, input: "Look up answer" });
    let waiting = created;
    for (let attempt = 0; attempt < 100 && waiting.required_actions.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waiting = await f.client.beta.agents.sessions.retrieve(created.id);
    }
    expect(waiting.status, f.logs.join("")).toBe("requires_action");
    const action = waiting.required_actions[0]!;
    expect(action).toMatchObject({ type: "function_call", name: "lookup", arguments: { key: "answer" } });
    if (action.type !== "function_call") throw new Error("Expected a function request");
    const body = { events: [{ type: "agent.session.input.tool_result" as const, turn_id: action.turn_id, call_id: action.call_id, success: true as const, output: "42" }], "Idempotency-Key": "node-tool-result" };
    await f.client.beta.agents.sessions.events.create(created.id, body);
    let items: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      items = (await f.client.beta.agents.sessions.items.list(created.id)).data;
      if (items.some(item => item.content?.some((part: any) => part.text === "NATIVE_TOOL_RESULT_OK"))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(items, f.logs.join("")).toContainEqual(expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "NATIVE_TOOL_RESULT_OK" })] }));
    await f.client.beta.agents.sessions.events.create(created.id, body);
    expect((await f.client.beta.agents.sessions.turns.list(created.id)).data).toEqual([expect.objectContaining({ id: action.turn_id, status: "completed" })]);
    expect(items.filter(item => item.type === "function_call")).toHaveLength(1);
    expect(items.filter(item => item.type === "function_call_output")).toHaveLength(1);
    expect(new Set(items.map(item => item.turn_id))).toEqual(new Set([action.turn_id]));
    expect(f.requests).toHaveLength(2);
    expect((await f.client.beta.agents.sessions.retrieve(created.id)).required_actions).toEqual([]);
  });
});
