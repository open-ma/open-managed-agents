import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "../../managed-agents-api/test/environment-work-fixtures";
import { makeSessionEventsPort } from "../../managed-agents-api/test/session-event-fixtures";
import {
  makeMemoriesPort,
  memoryView,
} from "../../managed-agents-api/test/memory-fixtures";
import {
  makeSessionsPort,
  sessionView,
} from "../../managed-agents-api/test/session-fixtures";
import {
  makeSkillVersionsPort,
  skillVersionView,
} from "../../managed-agents-api/test/skill-fixtures";
import { buildManagedAgentsTestApi } from "../../managed-agents-api/test/test-api";
import { makeFilesPort } from "../../managed-agents-api/test/file-fixtures";
import { createNodeManagedEnvironmentWorker } from "../src/index";

const roots: string[] = [];
const servers: Server[] = [];

function writeTarString(target: Uint8Array, offset: number, length: number, value: string) {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number) {
  writeTarString(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** Minimal ustar archive used to exercise the upstream SDK's real extractor. */
function skillArchive(name: string, content: string): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  const paddedSize = Math.ceil(bytes.byteLength / 512) * 512;
  const archive = new Uint8Array(512 + paddedSize + 1_024);
  writeTarString(archive, 0, 100, name);
  writeTarOctal(archive, 100, 8, 0o644);
  writeTarOctal(archive, 108, 8, 0);
  writeTarOctal(archive, 116, 8, 0);
  writeTarOctal(archive, 124, 12, bytes.byteLength);
  writeTarOctal(archive, 136, 12, 0);
  archive.fill(0x20, 148, 156);
  archive[156] = "0".charCodeAt(0);
  writeTarString(archive, 257, 6, "ustar\0");
  writeTarString(archive, 263, 2, "00");
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(archive, 148, 8, checksum);
  archive.set(bytes, 512);
  return archive;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function serveApi(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ baseUrl: string; sandboxBaseUrl: string; server: Server }> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body: Uint8Array[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      const request = new Request(
        `http://${incoming.headers.host}${incoming.url ?? "/"}`,
        {
          method: incoming.method,
          headers,
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? {}
            : { body: Buffer.concat(body) }),
        },
      );
      const response = await fetch(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (response.body === null) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        outgoing.write(Buffer.from(item.value));
      }
      outgoing.end();
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sandboxBaseUrl: `http://host.docker.internal:${address.port}`,
    server,
  };
}

describe("official EnvironmentWorker in Docker", () => {
  it("runs the unmodified Anthropic SDK through the real HTTP API boundary", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const rootDir = await mkdtemp(join(tmpdir(), "oma-official-worker-docker-"));
    roots.push(rootDir);

    const environmentId = "env_docker_official_01";
    const environmentKey = "sk-ant-environment-docker";
    const sessionsToken = "sk-ant-session-docker";
    let polled = false;
    let acceptToolResult!: () => void;
    let receivedToolResult: unknown = null;
    const toolResultAccepted = new Promise<void>((resolve) => {
      acceptToolResult = resolve;
    });
    const skillMarkdown = "---\nname: repository-guide\ndescription: Docker resource contract\n---\nUse the attached project memory.\n";
    const skillBytes = skillArchive(
      "repository-guide/SKILL.md",
      skillMarkdown,
    );
    const memoryStoreId = "memstore_docker_official_01";
    const memoryMountPath = "/workspace/session-memory";
    let memoryContent = "memory before tool";
    const operations: string[] = [];
    const activeWork = {
      ...environmentWorkView,
      id: "work_docker_official_01",
      environmentId,
      data: { type: "session" as const, id: sessionView.id },
      secret: { sessionsToken, apiBaseUrl: "http://set-after-listen" },
    };
    const api = buildManagedAgentsTestApi({
      environmentWork: makeEnvironmentWorkPort({
        pollEnvironmentWork: async () => {
          operations.push("poll");
          if (polled) return { type: "empty" };
          polled = true;
          return { type: "work", work: activeWork };
        },
        acknowledgeEnvironmentWork: async () => {
          operations.push("ack");
          return { type: "acknowledged", work: activeWork };
        },
        heartbeatEnvironmentWork: async () => {
          operations.push("heartbeat");
          return {
            type: "recorded",
            heartbeat: {
              lastHeartbeat: "2026-09-03T12:00:00.000Z",
              leaseExtended: true,
              state: "active",
              ttlSeconds: 30,
            },
          };
        },
        stopEnvironmentWork: async () => {
          operations.push("stop");
          return {
            type: "stopped",
            work: {
              ...activeWork,
              state: "stopped",
              stoppedAt: "2026-09-03T12:00:01.000Z",
            },
          };
        },
      }),
      sessions: makeSessionsPort({
        retrieveSession: async () => {
          operations.push("retrieve_session");
          return {
            type: "found",
            session: {
              ...sessionView,
              environmentId,
              agent: {
                ...sessionView.agent,
                skills: [{
                  type: "custom",
                  skillId: skillVersionView.skillId,
                  version: "latest",
                }],
              },
              resources: [{
                type: "memory_store",
                memoryStoreId,
                access: "read_write",
                description: "Docker worker memory",
                instructions: "Read and update the attached note.",
                mountPath: memoryMountPath,
                name: "session-memory",
              }, {
                id: "sesrsc_file_docker_01",
                createdAt: "2026-09-03T12:00:00.000Z",
                fileId: "file_docker_01",
                mountPath: "/mnt/session/uploads/input.bin",
                type: "file",
                updatedAt: "2026-09-03T12:00:00.000Z",
              }],
            },
          };
        },
      }),
      files: makeFilesPort({
        downloadFile: async (query) => {
          operations.push("download_file");
          expect(query).toEqual({ fileId: "file_docker_01" });
          return {
            type: "found",
            file: {
              content: new Uint8Array([0, 255, 1]),
              filename: "input.bin",
              mimeType: "application/octet-stream",
            },
          };
        },
      }),
      skillVersions: makeSkillVersionsPort({
        listSkillVersions: async (query) => {
          operations.push("list_skill_versions");
          expect(query).toMatchObject({ skillId: skillVersionView.skillId });
          return {
            type: "page",
            page: { versions: [skillVersionView], nextCursor: null },
          };
        },
        retrieveSkillVersion: async (query) => {
          operations.push("retrieve_skill_version");
          expect(query).toEqual({
            skillId: skillVersionView.skillId,
            version: skillVersionView.version,
          });
          return { type: "found", version: skillVersionView };
        },
        downloadSkillVersion: async (query) => {
          operations.push("download_skill_version");
          expect(query).toEqual({
            skillId: skillVersionView.skillId,
            version: skillVersionView.version,
          });
          return {
            type: "found",
            file: {
              content: skillBytes,
              mimeType: "application/x-tar",
              filename: "repository-guide.tar",
            },
          };
        },
      }),
      memories: makeMemoriesPort({
        listMemories: async (query) => {
          operations.push(`list_memories_${query.projection ?? "basic"}`);
          expect(query.memoryStoreId).toBe(memoryStoreId);
          return {
            type: "page",
            page: {
              items: [{
                ...memoryView,
                memoryStoreId,
                content: query.projection === "full" ? memoryContent : undefined,
                contentSha256: sha256(memoryContent),
                contentSizeBytes: Buffer.byteLength(memoryContent),
              }],
              nextCursor: null,
            },
          };
        },
        updateMemory: async (command) => {
          operations.push("update_memory");
          expect(command).toMatchObject({
            memoryStoreId,
            memoryId: memoryView.id,
            content: "memory after tool",
            contentPrecondition: { expectedSha256: sha256("memory before tool") },
          });
          memoryContent = command.content ?? "";
          return {
            type: "updated",
            memory: {
              ...memoryView,
              memoryStoreId,
              content: memoryContent,
              contentSha256: sha256(memoryContent),
              contentSizeBytes: Buffer.byteLength(memoryContent),
            },
          };
        },
      }),
      sessionEvents: makeSessionEventsPort({
        streamSessionEvents: async () => ({
          type: "stream",
          events: (async function* () {
            operations.push("stream_events");
            yield {
              id: "tool_use_docker",
              type: "agent.tool_use" as const,
              name: "echo_contract",
              input: { value: "docker" },
              evaluatedPermission: "allow" as const,
              processedAt: "2026-09-03T12:00:00.100Z",
            };
            await toolResultAccepted;
            yield {
              id: "event_terminated_docker",
              type: "session.status_terminated" as const,
              processedAt: "2026-09-03T12:00:00.300Z",
            };
          })(),
        }),
        listSessionEvents: async () => {
          operations.push("list_events");
          return { type: "page", page: { events: [], nextCursor: null } };
        },
        sendSessionEvents: async (input) => {
          operations.push("send_events");
          receivedToolResult = input.events;
          acceptToolResult();
          return {
            type: "accepted",
            events: [{
              id: "tool_result_docker",
              type: "user.tool_result",
              toolUseId: "tool_use_docker",
              content: [{ type: "text", text: "resources:ready" }],
              isError: false,
              processedAt: "2026-09-03T12:00:00.200Z",
            }],
          };
        },
      }),
    });
    const served = await serveApi((request) => api.fetch(request));
    servers.push(served.server);
    // The claimant runs on the host, while the claimed runtime runs inside
    // Docker. The Work secret must remain reachable by the claimant; the
    // sandbox-specific route is injected separately via sandboxApiBaseUrl.
    activeWork.secret.apiBaseUrl = served.baseUrl;

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const script = `
      import Anthropic from "/opt/openma/node_modules/@anthropic-ai/sdk/index.mjs";
      import { betaZodTool } from "/opt/openma/node_modules/@anthropic-ai/sdk/helpers/beta/zod.mjs";
      import { z } from "/opt/openma/node_modules/zod/index.js";
      import { readFile, writeFile } from "node:fs/promises";
      let handled = false;
      const client = new Anthropic({
        apiKey: null,
        authToken: process.env.ANTHROPIC_ENVIRONMENT_KEY,
        baseURL: process.env.ANTHROPIC_BASE_URL,
        maxRetries: 0,
      });
      await client.beta.environments.work.worker({
        maxIdleMs: 10,
        tools: [betaZodTool({
          name: "echo_contract",
          description: "Echo a Docker contract value",
          inputSchema: z.object({ value: z.string() }),
          run: async ({ value }) => {
            const skill = await readFile("/workspace/skills/repository-guide/SKILL.md", "utf8");
            const memory = await readFile("${memoryMountPath}/notes/one.md", "utf8");
            const input = await readFile("/mnt/session/uploads/input.bin");
            if (!skill.includes("Docker resource contract")) {
              throw new Error("official worker did not materialize the skill");
            }
            if (memory !== "memory before tool") {
              throw new Error("official worker did not materialize the memory store: " + memory);
            }
            if (input.length !== 3 || input[0] !== 0 || input[1] !== 255 || input[2] !== 1) {
              throw new Error("OpenMA did not materialize the binary Session file");
            }
            await writeFile("${memoryMountPath}/notes/one.md", "memory after tool");
            handled = true;
            return value === "docker" ? "resources:ready" : "resources:wrong-input";
          },
        })],
        workdir: "/workspace",
      }).handleItem();
      if (!handled) throw new Error("official worker did not execute the tool");
    `;
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const cluster = await createNodeManagedEnvironmentWorker({
      runtime: {
        rootDir,
        sql,
        initializeFenceSchema: true,
        ownerId: "official-worker-docker-host",
        leaseTtlMs: 20_000,
        heartbeatIntervalMs: 1_000,
        image: process.env.OMA_RUNTIME_NODE_IMAGE ?? "node:24-alpine",
        additionalMounts: [{
          source: repositoryRoot,
          destination: "/opt/openma",
          readOnly: true,
        }],
        extraHosts: [{ hostname: "host.docker.internal", address: "host-gateway" }],
      },
      worker: {
        client: new Anthropic({
          apiKey: "parent-key-must-not-leak",
          baseURL: served.baseUrl,
          maxRetries: 0,
        }),
        environmentId,
        environmentKey,
        workspaceId: "workspace_docker_official",
        workerId: "worker_docker_launcher_01",
        sandboxApiBaseUrl: served.sandboxBaseUrl,
        onError: async (error) => { throw error; },
        onRunResult: async (_work, result) => {
          if (result.type !== "completed") {
            throw new Error(JSON.stringify({
              result: "error" in result ? String(result.error) : result.type,
              operations,
            }));
          }
        },
        profileFor: async () => ({
          workspace: { requirement: "ephemeral" },
          outputs: { requirement: "disabled" },
          runtimeCheckpoint: "disabled",
          driver: {
            type: "ama_worker",
            process: {
              command: "/usr/local/bin/node",
              args: ["--input-type=module", "--eval", script],
            },
          },
        }),
      },
    });

    await expect(cluster.environmentWorker.drain()).resolves.toBeUndefined();

    // The official worker performs heartbeat and session retrieval from
    // independent loops. Their relative order after acknowledgement is not
    // part of the protocol (and can legitimately race), while the lifecycle
    // boundaries below are. Assert those protocol invariants instead of
    // freezing one scheduler interleaving.
    expect(operations[0]).toBe("poll");
    expect(operations[1]).toBe("ack");
    const indexOf = (operation: string) => operations.indexOf(operation);
    expect(indexOf("heartbeat")).toBeGreaterThan(indexOf("ack"));
    expect(indexOf("retrieve_session")).toBeGreaterThan(indexOf("ack"));
    expect(indexOf("download_file")).toBeGreaterThan(indexOf("retrieve_session"));
    expect(indexOf("download_file")).toBeLessThan(indexOf("stream_events"));
    expect(indexOf("list_skill_versions")).toBeGreaterThan(indexOf("retrieve_session"));
    expect(indexOf("retrieve_skill_version")).toBeGreaterThan(indexOf("list_skill_versions"));
    expect(indexOf("download_skill_version")).toBeGreaterThan(indexOf("retrieve_skill_version"));
    expect(indexOf("list_memories_full")).toBeGreaterThan(indexOf("retrieve_session"));
    expect(indexOf("stream_events")).toBeGreaterThan(indexOf("retrieve_session"));
    expect(indexOf("list_events")).toBeGreaterThan(indexOf("stream_events"));
    expect(indexOf("send_events")).toBeGreaterThan(indexOf("list_events"));
    expect(indexOf("list_memories_basic")).toBeGreaterThan(indexOf("send_events"));
    expect(indexOf("update_memory")).toBeGreaterThan(indexOf("list_memories_basic"));
    expect(indexOf("stop")).toBeGreaterThan(indexOf("send_events"));
    expect(indexOf("heartbeat")).toBeLessThan(indexOf("stop"));
    expect(operations.at(-1)).toBe("poll");
    expect(operations.lastIndexOf("poll")).toBeGreaterThan(indexOf("stop"));
    expect(memoryContent).toBe("memory after tool");
    expect(receivedToolResult).toEqual([expect.objectContaining({
      type: "user.tool_result",
      toolUseId: "tool_use_docker",
      content: [{ type: "text", text: "resources:ready" }],
      isError: false,
    })]);
  });
});
