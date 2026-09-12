import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { buildOpenAIAgentsProtocolApi, OpenAIAgentsProtocolError } from "../../openai-agents-api/src/index";
import { resourcesFixture } from "./helpers/resources";
import { createArtifactsHandler, publishSessionArtifact } from "../src/artifacts";

function fixture() {
  const resources = resourcesFixture();
  const handler = createArtifactsHandler({ files: resources.files, requireSession: async (id: string) => { if (id !== "session_a" && id !== "session_b") throw new OpenAIAgentsProtocolError(404, "Session not found"); } });
  const app = buildOpenAIAgentsProtocolApi({ execute: handler });
  const api = new OpenAI({ apiKey: "offline-artifacts", baseURL: "http://openma.test/v1", maxRetries: 0, fetch: async (request, init) => app.fetch(new Request(request, init)) }).beta.agents.sessions.artifacts;
  const completedTurns = new Set(["turn_completed", "exact_completed_turn", "turn_1", "turn_2", "turn_3"]);
  const publication = { files: resources.files, requireCompletedTurn: async (origin: {sessionId:string;turnId:string}) => { if (origin.sessionId !== "session_a" || !completedTurns.has(origin.turnId)) throw new OpenAIAgentsProtocolError(409, "Turn has not completed"); } };
  return { ...resources, handler, api, publication };
}

describe("durable session artifacts use native immutable File records", () => {
  it("persists explicit completed-turn provenance with the bytes snapshot, without altering the original uploaded file", async () => {
    const f = fixture();
    const input = await f.files.uploadFile({ filename: "report.bin", mimeType: "application/octet-stream", content: new Uint8Array([0, 255, 254]) });
    if (input.type !== "uploaded") throw new Error("Input upload failed");
    const download = await f.files.downloadFile({ fileId: input.file.id });
    if (download.type !== "found") throw new Error("Input download failed");
    const artifact = await publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "environment_original", turnId: "turn_completed", path: "/workspace/report.bin", mimeType: "application/octet-stream", content: download.file.content });
    download.file.content.fill(1);
    expect(await f.files.retrieveFileMetadata({ fileId: artifact.id })).toMatchObject({ type: "found", file: { scope: { type: "session", id: "session_a" }, origin: { type: "session_output", sessionId: "session_a", environmentId: "environment_original", turnId: "turn_completed", path: "/workspace/report.bin" } } });
    expect(await f.api.retrieve(artifact.id, { session_id: "session_a" })).toEqual(artifact);
    expect(artifact).toMatchObject({ object: "agent.session.artifact", session_id: "session_a", environment_id: "environment_original", turn_id: "turn_completed", path: "/workspace/report.bin", size_bytes: 3 });
    expect([...new Uint8Array(await (await f.api.content(artifact.id, { session_id: "session_a" })).arrayBuffer())]).toEqual([0, 255, 254]);
    await f.api.delete(artifact.id, { session_id: "session_a" });
    await expect(f.api.content(artifact.id, { session_id: "session_a" })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect(await f.files.downloadFile({ fileId: input.file.id })).toMatchObject({ type: "found", file: { content: new Uint8Array([0, 255, 254]) } });
  });

  it("never promotes ordinary uploaded files or guesses turn ownership from timestamps", async () => {
    const f = fixture();
    const ordinary = await f.files.uploadFile({ filename: "/workspace/no-provenance.txt", mimeType: "text/plain", content: new TextEncoder().encode("not an artifact") });
    if (ordinary.type !== "uploaded") throw new Error("Input upload failed");
    expect((await f.api.list("session_a")).data).toEqual([]);
    await expect(f.api.retrieve(ordinary.file.id, { session_id: "session_a" })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    const artifact = await publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_1", turnId: "exact_completed_turn", path: "/workspace/result.txt", mimeType: "text/plain", content: new TextEncoder().encode("immutable") });
    await expect(f.api.retrieve(artifact.id, { session_id: "session_b" })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(f.api.delete(artifact.id, { session_id: "session_b" })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(f.api.list("unknown_session")).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect((await f.api.retrieve(artifact.id, { session_id: "session_a" })).turn_id).toBe("exact_completed_turn");
  });

  it("lists and filters snapshots across environments with official SDK cursor pagination", async () => {
    const f = fixture();
    const first = await publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_1", turnId: "turn_1", path: "/workspace/first.txt", mimeType: "text/plain", content: new Uint8Array([1]) });
    const second = await publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_2", turnId: "turn_2", path: "/workspace/second.txt", mimeType: "text/plain", content: new Uint8Array([2]) });
    const third = await publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_1", turnId: "turn_3", path: "/workspace/third.txt", mimeType: "text/plain", content: new Uint8Array([3]) });
    const all: string[] = [];
    for await (const artifact of f.api.list("session_a", { limit: 1, order: "asc" })) all.push(artifact.id);
    expect(all).toEqual([first.id, second.id, third.id]);
    expect((await f.api.list("session_a", { environment_id: "env_1", order: "desc" })).data.map(artifact => artifact.id)).toEqual([third.id, first.id]);
    await expect(f.api.list("session_b", { after: first.id })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });

  it("rejects incomplete provenance before persisting a file", async () => {
    const f = fixture();
    await expect(publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_1", turnId: "", path: "/workspace/file.txt", mimeType: "text/plain", content: new Uint8Array([1]) })).rejects.toMatchObject({ status: 400 });
    await expect(publishSessionArtifact(f.publication, { sessionId: "session_a", environmentId: "env_1", turnId: "turn_still_running", path: "/workspace/file.txt", mimeType: "text/plain", content: new Uint8Array([1]) })).rejects.toMatchObject({ status: 409 });
    expect(await f.files.listFiles({ scopeId: "session_a" })).toMatchObject({ page: { files: [] } });
  });

  it("validates native publication provenance before writing bytes or metadata", async () => {
    const f = fixture();
    expect(await f.files.uploadFile({ filename: "file.txt", mimeType: "text/plain", content: new Uint8Array([1]), origin: { type: "session_output", sessionId: "session_a", environmentId: "env", turnId: "turn", path: "/workspace/../escape.txt" } })).toMatchObject({ type: "invalid_request" });
    expect(await f.files.listFiles({})).toMatchObject({ page: { files: [] } });
  });
});
