import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionView } from "@open-managed-agents/managed-agents-application/ports/sessions";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { createManagedSessionMapping } from "@open-managed-agents/openai-agents-compat";
import { resourcesFixture } from "../../../packages/openai-agents-compat/test/helpers/resources";
import { createNodeOpenAIAgentsRuntime } from "../src/openai-managed-runtime";
import { createNoEnvironmentSandbox } from "../src/openai-no-environment";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const f = resourcesFixture();
  const root = await mkdtemp(join(tmpdir(), "openma-openai-runtime-")); roots.push(root);
  const sandbox = new LocalSubprocessSandbox({ workdir: root });
  let connected: typeof sandbox | ReturnType<typeof createNoEnvironmentSandbox> | null = null;
  const sessions = new Map<string, SessionView>();
  const runtime = createNodeOpenAIAgentsRuntime({ environments: f.environments, secrets: f.secrets, sessions: { retrieveSession: async ({ sessionId }) => sessions.has(sessionId) ? { type: "found", session: sessions.get(sessionId)! } : { type: "not_found" } }, connectedSandbox: sessionId => sessions.has(sessionId) ? connected : null });
  const mapping = createManagedSessionMapping({ ...f, resources: f.handler, runtime: runtime.mapping });
  async function create(environment: Record<string, unknown>) {
    const command = await mapping.prepareCreate({ agent: { model: "test" }, environment, input: "hello" });
    const agent = await f.agents.retrieveAgent({ agentId: command.agent.agentId });
    if (agent.type !== "found") throw new Error("Missing native agent");
    const session = { id: "session_a", agent: { ...agent.agent, multiagent: null }, environmentId: command.environmentId, metadata: command.metadata ?? {}, status: "running", createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z", vaultIds: [], archivedAt: null, budget: null, outcomeEvaluations: [], resources: [], stats: {}, title: null, usage: {} } as SessionView;
    sessions.set(session.id, session);
    return session;
  }
  return { ...f, runtime, mapping, root, sandbox, create, connect: () => { connected = sandbox; }, disconnect: () => { connected = null; }, connectNone: () => { connected = createNoEnvironmentSandbox(); } };
}

describe("Node OpenAI semantic runtime boundary", () => {
  it("accepts dynamic subagents while retaining the native session configuration", async () => {
    const f = await fixture();
    const command = await f.mapping.prepareCreate({ agent: { model: "test", multi_agent: { enabled: true, max_concurrent_subagents: 2 } }, environment: { type: "none" }, input: "Delegate a task" });
    expect(command.initialEvents).toEqual([{ type: "user.message", content: [{ type: "text", text: "Delegate a task" }] }]);
    expect(command.agent.model).toMatchObject({ id: "test" });
  });
  it("maps none to native configuration without exposing a file environment", async () => {
    const f = await fixture(); const session = await f.create({ type: "none" }); f.connectNone();
    expect((await f.mapping.sessionView(session)).environment).toEqual({ type: "none" });
    expect(await f.runtime.files.getEnvironment("oai_env_session_a")).toBeNull();
    await expect(f.runtime.files.writeFile("oai_env_session_a", "/workspace/private", new Uint8Array([1]))).rejects.toMatchObject({ status: 404 });
    expect(await f.run("environments.templates.list")).toMatchObject({ data: [] });
    await expect(f.run("environments.templates.retrieve", {}, { environment_template_id: session.environmentId })).rejects.toMatchObject({ status: 404 });
  });
  it("rejects tools requiring a sandbox when none would disable their execution", async () => {
    const f = await fixture();
    await expect(f.mapping.prepareCreate({ agent: { model: "test", tools: [{ type: "web_search" }] }, environment: { type: "none" }, input: "Search" })).rejects.toMatchObject({ status: 501, param: "agent.tools[0]", code: "unsupported_feature" });
  });
  it.each([
    [{ reasoning: { effort: "high" } }, "agent.reasoning.effort"],
    [{ service_tier: "fast" }, "agent.service_tier"],
  ])("rejects stored model options the default harness does not send: %j", async (options, param) => {
    const f = await fixture();
    await expect(f.mapping.prepareCreate({ agent: { model: "test", ...options }, environment: { type: "none" }, input: "Hello" })).rejects.toMatchObject({ status: 501, param, code: "unsupported_feature" });
  });
  it("uses connected native sandbox bytes and directory metadata, including unusual filenames", async () => {
    const f = await fixture(); const session = await f.create({ type: "openai_hosted" });
    expect((await f.mapping.sessionView(session)).environment).toMatchObject({ id: "oai_env_session_a", type: "openai_hosted", network: { access: "enabled" }, packages: { npm: [], python: [], system: [] } });
    expect(await f.runtime.files.getEnvironment("oai_env_session_a")).toMatchObject({ status: "pending" });
    await expect(f.runtime.files.writeFile("oai_env_session_a", "/workspace/a.bin", new Uint8Array([1]))).rejects.toMatchObject({ status: 409 });
    f.connect();
    const bytes = new Uint8Array([0, 255, 0, 128]);
    await f.runtime.files.writeFile("oai_env_session_a", "/workspace/nested/a ' \n.bin", bytes);
    expect(new Uint8Array(await readFile(join(f.root, "nested/a ' \n.bin")))).toEqual(bytes);
    expect(await f.runtime.files.listFiles("oai_env_session_a", "/workspace/nested")).toEqual([{ path: "/workspace/nested/a ' \n.bin", size_bytes: 4 }]);
    expect(await f.runtime.files.getEnvironment("oai_env_session_a")).toMatchObject({ status: "connected" });
    expect(await f.runtime.files.getEnvironment("oai_env_foreign")).toBeNull();
    await expect(f.runtime.files.listFiles("oai_env_session_a", "/workspace/../secret")).rejects.toMatchObject({ status: 400 });
    f.disconnect(); await expect(f.runtime.files.listFiles("oai_env_session_a")).rejects.toMatchObject({ status: 409 });
  });
  it.each([
    [{ type: "self_hosted" }, "environment.type"],
    [{ type: "openai_hosted", network: { access: "disabled" } }, "environment.network"],
    [{ type: "openai_hosted", packages: { npm: ["left-pad"] } }, "environment.packages"],
    [{ type: "openai_hosted", env: { KEY: "secret" } }, "environment.env"],
    [{ type: "openai_hosted", setup_commands: ["true"] }, "environment.setup_commands"],
  ])("rejects capabilities the configured Node runtime cannot enact: %j", async (configuration, param) => {
    const f = await fixture(); await expect(f.create(configuration as Record<string, unknown>)).rejects.toMatchObject({ status: 501, param, code: "unsupported_feature" });
    expect(await f.environments.listEnvironments({})).toMatchObject({ type: "page", page: { environments: [] } });
  });
});
