import { describe, expect, it, vi } from "vitest";
import { resourcesFixture } from "../../../packages/openai-agents-compat/test/helpers/resources";
import { encodeResourceMetadata } from "../../../packages/openai-agents-compat/src/resource-metadata";
import { createNodeOpenAIArtifactPublisher, withReportedArtifactPublication } from "../src/openai-artifact-publication";

async function fixture(mode = "completed", environmentType = "openai_hosted") {
  const resources = resourcesFixture();
  const session: any = { id: "session", environmentId: "native-env", agent: { id: "agent" }, createdAt: new Date(100000).toISOString(), metadata: encodeResourceMetadata({}, "session", { sealed: await resources.secrets.seal(JSON.stringify({ agent: {}, environment: { type: environmentType }, environmentId: "native-env" })) }) };
  const executionId = "execution-current";
  const facts: any[] = [{ event: { id: "input", type: "user.message", content: [{ type: "text", text: "make file" }] } }, { executionId, event: { id: "running", type: "session.status_running" } }];
  if (mode === "cancelled") facts.push({ event: { id: "cancel", type: "user.interrupt" } });
  if (mode === "failed") facts.push({ executionId, event: { id: "failure", type: "session.error", error: { type: "unknown_error", message: "failed", retryStatus: "terminal" } } });
  if (mode === "requires_action") facts.push({ executionId, event: { id: "call", type: "agent.custom_tool_use", name: "lookup", input: {} } });
  facts.push({ executionId, event: { id: "idle", type: "session.status_idle", stopReason: mode === "requires_action" ? { type: "requires_action", eventIds: ["call"] } : { type: "end_turn" } } });
  const bytes = new Uint8Array([0, 1, 127, 255]);
  const sandbox = { setEnvVars: vi.fn(async () => {}), exec: vi.fn(async () => Buffer.from("./outputs/report.bin\0").toString("base64")), readFileBytes: vi.fn(async () => bytes) };
  const history = { loadSessionRuntimeHistory: async () => ({ type: "found" as const, revision: 2, initialEvents: [], events: facts.map(row => row.event), orderedEvents: facts.map((row, index) => ({ ...row, position: { revision: 2, index } })) }) };
  const isFenceActive = vi.fn(async () => true);
  const dependencies = { historyForWorkspace: () => history, filesForWorkspace: () => resources.files, secrets: resources.secrets, isFenceActive, environmentId: () => "oai_env_session" };
  const input: any = { workspaceId: "workspace_a", session, environment: { id: "native-env" }, sandbox, runtimeGeneration: "runtime", executionFence: { workspaceId: "workspace_a", sessionId: "session", executionId } };
  return { ...resources, input, facts, bytes, sandbox, dependencies, isFenceActive, publish: createNodeOpenAIArtifactPublisher(dependencies), async published() { const result = await resources.files.listFiles({ scopeId: "session" }); if (result.type !== "page") throw new Error(result.message); return result.page.files; } };
}

describe("Node OpenAI immutable output publication", () => {
  it("reports failed publication explicitly without rejecting an already committed execution", async () => {
    const f = await fixture();
    const failure = new Error("Immutable output storage unavailable");
    f.sandbox.readFileBytes.mockRejectedValue(failure);
    const report = vi.fn();
    await expect(withReportedArtifactPublication(f.publish, report)(f.input)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure, f.input);
    expect(await f.published()).toEqual([]);
    await expect(f.publish(f.input)).rejects.toBe(failure);
  });

  it("copies completed-turn binary bytes with exact execution provenance and skips repeated hooks after reconstruction", async () => {
    const f = await fixture();
    await f.publish(f.input);
    const [file] = await f.published();
    expect(file).toMatchObject({ origin: { type: "session_output", sessionId: "session", environmentId: "oai_env_session", turnId: "turn_session:root:input", path: "/workspace/outputs/report.bin" }, sizeBytes: 4 });
    f.bytes.fill(42);
    await createNodeOpenAIArtifactPublisher(f.dependencies)(f.input);
    expect(await f.published()).toHaveLength(1);
    expect(await f.files.downloadFile({ fileId: file!.id })).toMatchObject({ type: "found", file: { content: new Uint8Array([0, 1, 127, 255]) } });
    expect(f.sandbox.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "failed", "requires_action"])("publishes nothing for %s even though a native idle fact was committed", async mode => {
    const f = await fixture(mode); await f.publish(f.input);
    expect(await f.published()).toEqual([]); expect(f.sandbox.exec).not.toHaveBeenCalled();
  });

  it.each(["none", "self_hosted"])("does not access an output filesystem for %s", async type => {
    const f = await fixture("completed", type); await f.publish(f.input);
    expect(await f.published()).toEqual([]); expect(f.sandbox.exec).not.toHaveBeenCalled();
  });

  it("does not assign a later completed turn to an older waiting execution", async () => {
    const f = await fixture("requires_action");
    f.facts.push({ event: { id: "result", type: "user.custom_tool_result", customToolUseId: "call", content: [{ type: "text", text: "done" }] } }, { executionId: "later-execution", event: { id: "later-running", type: "session.status_running" } }, { executionId: "later-execution", event: { id: "later-idle", type: "session.status_idle", stopReason: { type: "end_turn" } } });
    await f.publish(f.input);
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.exec).not.toHaveBeenCalled();
  });

  it("rejects publication after loss of execution ownership before writing any bytes", async () => {
    const f = await fixture(); f.isFenceActive.mockResolvedValue(false);
    await expect(f.publish(f.input)).rejects.toThrow(/fence/i);
    expect(await f.published()).toEqual([]);
  });

  it("serializes concurrent hook invocations and persists one immutable snapshot", async () => {
    const f = await fixture();
    await Promise.all([f.publish(f.input), f.publish(f.input)]);
    expect(await f.published()).toHaveLength(1);
    expect(f.sandbox.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects an output manifest escaping the public output directory", async () => {
    const f = await fixture();
    f.sandbox.exec.mockResolvedValue(Buffer.from("./outputs/../private.bin\0").toString("base64"));
    await expect(f.publish(f.input)).rejects.toThrow(/escaped/);
    expect(await f.published()).toEqual([]);
    expect(f.sandbox.readFileBytes).not.toHaveBeenCalled();
  });
});
