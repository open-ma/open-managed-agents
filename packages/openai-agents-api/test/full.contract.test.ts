import { describe, expect, it } from "vitest";
import * as api from "../src/index";
import OpenAI from "openai";
// The audit cases are hand-reviewed SDK requests, independent of our router.
// @ts-expect-error The audit deliberately uses plain JavaScript without SDK types.
import { scenarios } from "../../openai-agents-sdk-audit/src/scenarios.mjs";

const beta = { "OpenAI-Beta": "agents=v1", "Content-Type": "application/json" };
const wire = api as unknown as Record<string, any>;
const vault = { id: "vault_a", object: "vault", name: null, metadata: {}, created_at: 1 };
const fixture = (execute: (request: any) => Promise<any>) => wire.buildOpenAIAgentsProtocolApi({ execute });
interface AuditScenario { id: string; mode: string; method: string; expected: Array<{ path: string; httpMethod: string; body: unknown; query: Record<string, string | string[]>; headers: Record<string, string> }> }

describe("complete OpenAI Agents HTTP protocol", () => {
  it.each((scenarios as AuditScenario[]).filter(s => s.mode !== "helper"))("routes the pinned SDK request $id without losing fields", async scenario => {
    expect(wire.buildOpenAIAgentsProtocolApi).toBeTypeOf("function");
    const expected = scenario.expected[0];
    let received: any;
    const app = fixture(async (request) => {
      received = request;
      throw new wire.OpenAIAgentsProtocolError(404, "known missing resource");
    });
    const url = new URL(`http://test${expected.path}`);
    for (const [key, value] of Object.entries(expected.query)) {
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry));
    }
    const response = await app.fetch(new Request(url, { method: expected.httpMethod, headers: { ...expected.headers, ...beta }, ...(expected.body === null ? {} : { body: JSON.stringify(expected.body) }) }));
    expect(response.status).toBe(404);
    expect(received.operation).toBe(scenario.method.replace("beta.agents.", "").replace(/^(create|retrieve|update|list|delete)$/, "agents.$1"));
    expect(received.body).toEqual(expected.body ?? {});
    const query = Object.fromEntries(Object.entries(expected.query).map(([key, value]) => [key === "status[]" ? "status" : key, key === "limit" ? Number(value) : value]));
    expect(received.query).toEqual(query);
    expect(received.headers.get("idempotency-key")).toBe(expected.headers["idempotency-key"] ?? null);
  });

  it("resolves static environment templates before dynamic environment IDs", async () => {
    let routedOperation: string | undefined;
    const app = fixture(async ({ operation }) => { routedOperation = operation; return { body: { data: [], has_more: false } }; });
    const response = await app.request("/v1/agents/environments/templates", { headers: beta });
    expect(response.status).toBe(200);
    expect(routedOperation).toBe("environments.templates.list");
  });

  it.each([
    ["/v1/agents", { model: "test", tools: [{ type: "function", name: "f", description: "", parameters: {}, bad: true }] }, "POST"],
    ["/v1/agents", { model: "test", metadata: { bad: 1 } }, "POST"],
    ["/v1/agents?limit=1&limit=2", null, "GET"],
    ["/v1/agents?limit=1.5", null, "GET"],
    ["/v1/agents?order=backwards", null, "GET"],
    ["/v1/agents?surprise=yes", null, "GET"],
    ["/v1/vaults?status[]=invalid", null, "GET"],
    ["/v1/agents/sessions", { environment: { type: "none" }, agent: {} }, "POST"],
    ["/v1/agents/sessions/s/events", { events: [{ type: "agent.session.input.tool_result", call_id: "c", turn_id: "t", success: "yes" }] }, "POST"],
  ])("rejects invalid requests before execution: %s %j", async (path, body, method) => {
    let executed = false;
    const app = fixture(async () => { executed = true; return { body: vault }; });
    const response = await app.request(path as string, { method: method as string, headers: beta, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(executed).toBe(false);
  });

  it("rejects malformed JSON, absent beta, and unknown routes with OpenAI errors", async () => {
    const app = fixture(async () => ({ body: vault }));
    for (const [path, init, status] of [["/v1/vaults", { method: "POST", headers: beta, body: "{" }, 400], ["/v1/vaults", {}, 400], ["/v1/unknown", { headers: beta }, 404]] as const) {
      const response = await app.request(path, init);
      expect(response.status).toBe(status);
      expect(await response.json()).toHaveProperty("error.message");
    }
  });

  it("validates full responses and never leaks an invalid credential or internal exception", async () => {
    for (const execute of [async () => ({ body: { ...vault, created_at: "bad" } }), async () => { throw new Error("confidential backend detail"); }]) {
      const response = await fixture(execute).request("/v1/vaults/v", { headers: beta });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain("server_error");
      expect(text).not.toContain("confidential");
    }
  });

  it("returns byte-exact artifact contents and an empty event submission response", async () => {
    const app = fixture(async ({ operation }) => operation === "sessions.artifacts.content" ? { binary: new Uint8Array([0, 255, 19]), headers: { "content-type": "application/octet-stream" } } : { status: 204 });
    const content = await app.request("/v1/agents/sessions/s/artifacts/a/content", { headers: beta });
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([0, 255, 19]);
    const accepted = await app.request("/v1/agents/sessions/s/events", { method: "POST", headers: beta, body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }) });
    expect(accepted.status).toBe(204);
    expect(await accepted.text()).toBe("");
  });

  it("preserves nested hosted setup fields and credential OAuth unions", async () => {
    const body = { name: "test", env: { SECRET: "kept" }, setup_commands: [{ command: "echo test" }], network: { access: "restricted", allowed_domains: ["example.test"] }, files: [{ type: "inline", path: "/workspace/a", data: "YQ==" }] };
    let received: unknown;
    const app = fixture(async (request) => { received = request.body; throw new wire.OpenAIAgentsProtocolError(404, "missing"); });
    const response = await app.request("/v1/agents/environments/templates", { method: "POST", headers: beta, body: JSON.stringify(body) });
    expect(response.status).toBe(404);
    expect(received).toEqual(body);
  });

  it("rejects incomplete SDK resource union members", () => {
    expect(wire.validateOpenAIAgentsSchema({ type: "function", name: "f" }, "agents.PersistedAgentToolParam").success).toBe(false);
    expect(wire.validateOpenAIAgentsSchema({ type: "function", name: "f", description: "", parameters: {} }, "agents.PersistedAgentToolParam").success).toBe(true);
    expect(wire.validateOpenAIAgentsSchema({ type: "none" }, "agents.EnvironmentParam").success).toBe(true);
    expect(wire.validateOpenAIAgentsSchema({ type: "openai_hosted", plugins: [{ type: "inline" }] }, "agents.EnvironmentParam").success).toBe(false);
  });

  it("streams SDK-readable event IDs and errors while preserving the original event fields", async () => {
    const event = { type: "agent.session.turn.output_text.delta", event_id: "e_one", session_id: "s", turn_id: "t", item_id: "i", output_index: 0, content_index: 0, delta: "Hello" };
    const app = fixture(async () => ({ stream: (async function* () { yield event; throw new Error("secret diagnostic"); })() }));
    const sdk = new OpenAI({ apiKey: "test", baseURL: "http://test/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
    const stream = await sdk.beta.agents.sessions.events.stream("s");
    const events: unknown[] = [];
    await expect((async () => { for await (const item of stream) events.push(item); })()).rejects.toMatchObject({ message: "Application event stream failed" });
    expect(events).toEqual([event]);
  });

  it("rejects malformed stream events without publishing invalid content", async () => {
    const app = fixture(async () => ({ stream: (async function* () { yield { type: "agent.session.turn.output_text.delta", event_id: "e", delta: "invalid secret body" }; })() }));
    const response = await app.request("/v1/agents/sessions/s/events", { headers: beta });
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"session_id":"s"');
    expect(text).not.toContain("invalid secret body");
  });

  it("propagates transport cancellation to the subscription without submitting a cancel input", async () => {
    const requestAbort = new AbortController();
    let subscriptionSignal: AbortSignal | undefined;
    const operations: string[] = [];
    const app = fixture(async ({ signal, operation }) => {
      subscriptionSignal = signal;
      operations.push(operation);
      return { stream: (async function* () {
        yield { type: "agent.session.turn.output_text.delta", event_id: "e", session_id: "s", turn_id: "t", item_id: "i", output_index: 0, content_index: 0, delta: "Hello" };
        await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      })() };
    });
    const response = await app.fetch(new Request("http://test/v1/agents/sessions/s/events", { headers: beta, signal: requestAbort.signal }));
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    requestAbort.abort();
    expect(subscriptionSignal?.aborted).toBe(true);
    expect((await reader.read()).done).toBe(true);
    expect(operations).toEqual(["sessions.events.stream"]);
  });

  it("uses opaque file-page cursors in official SDK auto-pagination", async () => {
    const app = fixture(async ({ query }) => ({ body: query.page ? { data: [{ object: "agent.environment.file", environment_id: "env", path: "/workspace/b", size_bytes: 1 }], has_more: false, next: null } : { data: [{ object: "agent.environment.file", environment_id: "env", path: "/workspace/a", size_bytes: 1 }], has_more: true, next: "opaque-next" } }));
    const sdk = new OpenAI({ apiKey: "test", baseURL: "http://test/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
    const paths: string[] = [];
    for await (const file of sdk.beta.agents.environments.files.list("env", { limit: 1 })) paths.push(file.path);
    expect(paths).toEqual(["/workspace/a", "/workspace/b"]);
  });

  it.each([
    ["/v1/vaults", { data: [], has_more: true }],
    ["/v1/agents/environments/env/files", { data: [], has_more: false }],
    ["/v1/agents/environments/env/files", { data: [], has_more: true, next: null }],
  ])("rejects malformed pagination instead of silently ending SDK iteration: %s", async (path, body) => {
    const response = await fixture(async () => ({ body })).request(path as string, { headers: beta });
    expect(response.status).toBe(500);
  });
});
