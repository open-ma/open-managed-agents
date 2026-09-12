import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import type { AcpRuntime, SessionOptions } from "@open-managed-agents/acp-runtime";
import {
  createNodeManagedAcpSupervisorApp,
  decodeManagedAcpSessionSnapshot,
  type ManagedAcpSessionSnapshot,
} from "../src/node-supervisor";
import type { NodeAcpHarnessStateIo } from "../src/node";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function workSecret(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeAcpRuntime(seen: SessionOptions[], prompts: string[] = []): AcpRuntime {
  return {
    async start(options) {
      seen.push(options);
      return {
        id: "internal_1",
        acpSessionId: "native_1",
        options,
        authMethods: [],
        protocolVersion: null,
        agentInfo: null,
        agentCapabilities: {},
        initializeMeta: null,
        sessionSetupMeta: null,
        configOptions: [],
        modes: null,
        promptCapabilities: {},
        supportsSessionFork: false,
        supportsSessionList: false,
        supportsSessionDelete: false,
        supportsSessionResume: true,
        supportsSessionClose: true,
        supportsAdditionalDirectories: false,
        supportsLogout: false,
        supportsProviders: false,
        supportsNes: false,
        nesCapabilities: null,
        positionEncoding: null,
        supportsSteering: true,
        async *prompt(text: string | readonly unknown[]) {
          prompts.push(String(text));
          yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } };
          yield { type: "promptComplete", response: {} };
        },
        async steer() { return "promptRequired" as const; },
        async cancelCurrentTurn() {},
        drainPendingEvents() { return []; },
        async setConfigOption() { return []; },
        async authenticate() {},
        async setMode() {},
        async listSessions() { return { sessions: [] }; },
        async deleteSession() {},
        async logout() {},
        async listProviders() { return { providers: [] }; },
        async setProvider() {},
        async disableProvider() {},
        async requestExtension() { return {}; },
        async notifyExtension() {},
        async startNes() { return {}; },
        async suggestNes() { return {}; },
        async closeNes() {},
        async didOpenDocument() {},
        async didChangeDocument() {},
        async didCloseDocument() {},
        async didSaveDocument() {},
        async didFocusDocument() {},
        async acceptNes() {},
        async rejectNes() {},
        isAlive() { return true; },
        async dispose() {},
      } as never;
    },
  };
}

function agentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_1",
    version: 1,
    model: { id: "deepseek-chat" },
    mcp_servers: [],
    skills: [],
    system: null,
    tools: [],
    ...overrides,
  };
}

function sessionSnapshot(agent: Record<string, unknown> = agentSnapshot()) {
  return {
    id: scope.sessionId,
    environment_id: scope.environmentId,
    archived_at: null,
    status: "running",
    agent,
  };
}

function productionFetch(input: {
  agent?: Record<string, unknown>;
  archive?: Uint8Array;
}) {
  return vi.fn(async (raw: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(raw, init);
    if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) {
      return json(sessionSnapshot(input.agent));
    }
    if (request.url.includes("/v1/skills/")) {
      return new Response(input.archive ?? new Uint8Array());
    }
    if (request.url.includes(`/v1/sessions/${scope.sessionId}/events`)) {
      return json({
        data: [{
          id: "terminated",
          type: "session.status_terminated",
          processed_at: "2026-09-08T01:00:00.000Z",
        }],
        next_page: null,
      });
    }
    if (request.url.endsWith(`/v1/oma/sessions/${scope.sessionId}/runtime-events`)) {
      return json({ recorded: 1 });
    }
    throw new Error(`unexpected request ${request.url}`);
  });
}

const claimedEnvironment = {
  ANTHROPIC_BASE_URL: "https://api.openma.test",
  ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
  ANTHROPIC_SESSION_ID: scope.sessionId,
  ANTHROPIC_WORK_ID: scope.workId,
  ANTHROPIC_WORK_SECRET: workSecret({
    sessions_token: "scoped-session-token",
    api_base_url: "https://gateway.openma.test",
  }),
};

describe("preinstalled Node managed ACP supervisor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("projects the real Session Agent into ACP without exposing Work credentials", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openma-node-supervisor-"));
    roots.push(workspace);
    const seenOptions: SessionOptions[] = [];
    const loaded: ManagedAcpSessionSnapshot[] = [];
    let eventPoll = 0;
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) {
        return json({
          id: scope.sessionId,
          environment_id: scope.environmentId,
          archived_at: null,
          status: "running",
          agent: {
            id: "agent_managed_1",
            version: 9,
            model: { id: "deepseek-chat", speed: "fast", effort: "low" },
            mcp_servers: [{ type: "url", name: "github", url: "https://upstream.invalid" }],
            skills: [{ type: "custom", skill_id: "skill_1", version: "4" }],
            system: "Inspect the repository before editing.",
            tools: [{ type: "custom", name: "deploy", description: "Deploy", input_schema: { type: "object" } }],
          },
        });
      }
      if (request.url.endsWith("/v1/skills/skill_1/versions/4/content")) {
        return new Response(zipSync({
          "repository-guide/SKILL.md": new TextEncoder().encode(
            "---\nname: repository-guide\ndescription: Inspect repositories\n---\nUse rg first.\n",
          ),
          "repository-guide/assets/logo.bin": Uint8Array.of(0, 255, 1),
        }), { headers: { "content-type": "application/zip" } });
      }
      if (request.url.includes(`/v1/sessions/${scope.sessionId}/events`)) {
        eventPoll += 1;
        return eventPoll === 1
          ? json({
              data: [
                {
                  id: "turn_1",
                  type: "user.message",
                  processed_at: "2026-09-08T01:00:00.000Z",
                  content: [{ type: "text", text: "continue" }],
                },
                {
                  id: "terminated_1",
                  type: "session.status_terminated",
                  processed_at: "2026-09-08T01:00:01.000Z",
                },
              ],
              next_page: null,
            })
          : json({ data: [], next_page: null });
      }
      if (request.url.endsWith(`/v1/oma/sessions/${scope.sessionId}/runtime-events`)) {
        return json({ recorded: 1 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const app = createNodeManagedAcpSupervisorApp({
      environment: {
        ANTHROPIC_BASE_URL: "https://api.openma.test",
        ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
        ANTHROPIC_ENVIRONMENT_KEY: "environment-standing-secret",
        ANTHROPIC_SESSION_ID: scope.sessionId,
        ANTHROPIC_WORK_ID: scope.workId,
        ANTHROPIC_WORK_SECRET: workSecret({
          sessions_token: "scoped-session-token",
          api_base_url: "https://gateway.openma.test/base",
        }),
      },
      workspacePath: workspace,
      acpRuntime: fakeAcpRuntime(seenOptions),
      fetch,
      control: {
        pollIntervalMs: 1,
        scheduler: { sleep: async () => {} },
      },
      resolveAgent: async ({ session }) => {
        loaded.push(session);
        return {
          id: "codex-acp",
          command: "codex-acp",
          env: {
            KEEP_ME: "yes",
            ANTHROPIC_WORK_SECRET: "must-be-removed",
          },
        };
      },
    });
    const harness = await app.resolveHarness({ id: "acp", version: "1" });
    expect(harness).not.toBeNull();
    const run = await harness!.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: "/mnt/session/outputs",
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });

    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.agent.model).toEqual({
      id: "deepseek-chat",
      speed: "fast",
      effort: "low",
    });
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).toMatchObject({
      agent: {
        command: "codex-acp",
        cwd: "/workspace",
        env: {
          KEEP_ME: "yes",
          ANTHROPIC_WORK_SECRET: undefined,
          ANTHROPIC_ENVIRONMENT_KEY: undefined,
          OUTPUT_PATH: "/mnt/session/outputs",
        },
      },
      mcpServers: [{
        type: "http",
        name: "github",
        url: `https://gateway.openma.test/v1/oma/mcp-proxy/${scope.sessionId}/github`,
        headers: [{ name: "Authorization", value: "Bearer scoped-session-token" }],
      }],
      sessionRequestMeta: {
        openma: {
          session_id: scope.sessionId,
          agent_id: "agent_managed_1",
          agent_version: 9,
          model: { id: "deepseek-chat", speed: "fast", effort: "low" },
          skills: [{ type: "custom", skill_id: "skill_1", version: "4" }],
          tools: [{ type: "custom", name: "deploy", description: "Deploy", input_schema: { type: "object" } }],
        },
      },
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8"))
      .resolves.toBe(
        "Inspect the repository before editing.\n\n"
        + "## OpenMA skills\n\n"
        + "- skill_1@4: /workspace/.openma/skills/skill_1/4/repository-guide/SKILL.md\n",
      );
    await expect(readFile(
      join(workspace, ".openma/skills/skill_1/4/repository-guide/SKILL.md"),
      "utf8",
    )).resolves.toContain("Use rg first.");
    await expect(readFile(
      join(workspace, ".openma/skills/skill_1/4/repository-guide/assets/logo.bin"),
    )).resolves.toEqual(Buffer.from([0, 255, 1]));
    const runtimePosts = fetch.mock.calls.map(([input, init]) => new Request(input, init))
      .filter((request) => request.url.includes("/runtime-events"));
    expect(runtimePosts.length).toBeGreaterThan(0);
    expect(runtimePosts.every((request) =>
      request.headers.get("authorization") === "Bearer scoped-session-token"
    )).toBe(true);
  });

  it("fails closed when the supervisor scope is not the claimed Work scope", async () => {
    const app = createNodeManagedAcpSupervisorApp({
      environment: {
        ANTHROPIC_BASE_URL: "https://api.openma.test",
        ANTHROPIC_ENVIRONMENT_ID: scope.environmentId,
        ANTHROPIC_SESSION_ID: "session_other",
        ANTHROPIC_WORK_ID: scope.workId,
        ANTHROPIC_WORK_SECRET: workSecret({ sessions_token: "token" }),
      },
      fetch: vi.fn(),
    });
    const harness = await app.resolveHarness({ id: "pi-acp", version: "1" });
    await expect(harness!.start({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow("does not match the claimed Work scope");
  });

  it("rejects unsupported supervisor protocol versions", async () => {
    const app = createNodeManagedAcpSupervisorApp({ environment: {} });
    await expect(app.resolveHarness({ id: "acp", version: "2" })).resolves.toBeNull();
  });

  it("uses the built-in installed-agent registry with safe defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openma-node-supervisor-default-"));
    roots.push(workspace);
    const seen: SessionOptions[] = [];
    const app = createNodeManagedAcpSupervisorApp({
      environment: claimedEnvironment,
      workspacePath: workspace,
      acpRuntime: fakeAcpRuntime(seen),
      fetch: productionFetch({}),
    });
    const harness = await app.resolveHarness({ id: "codex-acp", version: "1" });
    const run = await harness!.start({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();
    expect(seen[0]).toMatchObject({
      agent: {
        command: "codex-acp",
        cwd: "/workspace",
        env: { OUTPUT_PATH: undefined },
      },
      mcpServers: [],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [{ agentId: "codex-acp" }, "generic-acp", "codex"],
    [{}, "pi-acp", "pi"],
  ] as const)(
    "assigns a stable agent id when a custom resolver omits it %#",
    async (identity, harnessId, expectedAdapter) => {
      const workspace = await mkdtemp(join(tmpdir(), "openma-node-supervisor-identity-"));
      roots.push(workspace);
      const seen: SessionOptions[] = [];
      let binding = "";
      const stateIo: NodeAcpHarnessStateIo = {
        async readFile() { throw new Error("no checkpoint"); },
        async writeFile(path, content) {
          if (path.endsWith("session-binding.json")) binding = content;
        },
        async writeFileBytes() {},
        async exec() { return ""; },
      };
      const app = createNodeManagedAcpSupervisorApp({
        environment: claimedEnvironment,
        workspacePath: workspace,
        stateIo,
        acpRuntime: fakeAcpRuntime(seen),
        fetch: productionFetch({}),
        ...identity,
        resolveAgent: async () => ({ command: "custom-acp" }),
      });
      const harness = await app.resolveHarness({ id: harnessId, version: "1" });
      const run = await harness!.start({
        scope,
        harness: { id: harnessId, version: "1" },
        workspacePath: "/workspace",
        outputPath: null,
        checkpoint: async () => {},
        signal: new AbortController().signal,
      });

      await expect(run.completed).resolves.toEqual({ exitCode: 0 });
      await run.drain();
      expect(JSON.parse(binding)).toMatchObject({ adapter_id: expectedAdapter });
    },
  );

  it("falls back from a missing native checkpoint to bounded Managed Events history", async () => {
    const prompts: string[] = [];
    const seen: SessionOptions[] = [];
    const writes: string[] = [];
    const stateIo: NodeAcpHarnessStateIo = {
      async readFile() {
        return JSON.stringify({
          version: 1,
          adapter_id: "codex",
          acp_session_id: "native_missing",
        });
      },
      async writeFile(path) { writes.push(path); },
      async writeFileBytes(path) { writes.push(path); },
      async exec(command) {
        return command.startsWith("if [ -d ") ? "missing" : "";
      },
    };
    let eventRequest = 0;
    const fetch = vi.fn(async (raw: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(raw, init);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) {
        return json(sessionSnapshot());
      }
      if (request.url.includes(`/v1/sessions/${scope.sessionId}/events`)) {
        eventRequest += 1;
        if (eventRequest === 1) {
          return json({
            data: [
              {
                id: "turn_recover",
                type: "user.message",
                processed_at: "2026-09-08T01:00:00.000Z",
                content: [{ type: "text", text: "continue after crash" }],
              },
              {
                id: "terminated_recover",
                type: "session.status_terminated",
                processed_at: "2026-09-08T01:00:01.000Z",
              },
            ],
            next_page: null,
          });
        }
        return json({
          data: [{
            id: "history_1",
            type: "agent.message",
            processed_at: "2026-09-07T23:59:59.000Z",
            content: [{ type: "text", text: "The repository was inspected." }],
          }],
          next_page: null,
        });
      }
      if (request.url.endsWith(`/v1/oma/sessions/${scope.sessionId}/runtime-events`)) {
        return json({ recorded: 1 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const app = createNodeManagedAcpSupervisorApp({
      environment: claimedEnvironment,
      stateIo,
      acpRuntime: fakeAcpRuntime(seen, prompts),
      fetch,
      recovery: { maxCharacters: 1_024 },
      lifecycle: {
        drainDeadlineMs: 100,
        drainPollIntervalMs: 1,
        abortGraceMs: 0,
      },
      control: {
        pollIntervalMs: 1,
        retry: { maxAttempts: 1 },
        scheduler: { sleep: async () => {} },
      },
      resolveAgent: async () => ({ id: "codex-acp", command: "codex-acp" }),
    });
    const harness = await app.resolveHarness({ id: "acp", version: "1" });
    const run = await harness!.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });

    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();
    expect(seen[0]?.resumeAcpSessionId).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("The repository was inspected.");
    expect(prompts[0]).toContain("continue after crash");
    expect(eventRequest).toBe(2);
    expect(writes.some((path) => path.endsWith("session-binding.json"))).toBe(true);
  });

  it("fails closed for an unknown installed agent and an invalid Work secret", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openma-node-supervisor-invalid-"));
    roots.push(workspace);
    const unknown = createNodeManagedAcpSupervisorApp({
      environment: claimedEnvironment,
      workspacePath: workspace,
      acpRuntime: fakeAcpRuntime([]),
      fetch: productionFetch({}),
    });
    const unknownHarness = await unknown.resolveHarness({ id: "missing-acp-agent", version: "1" });
    const unknownRun = await unknownHarness!.start({
      scope,
      harness: { id: "missing-acp-agent", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await expect(unknownRun.completed).rejects.toThrow("No installed ACP agent");
    await unknownRun.stop("failed");

    const invalidSecret = createNodeManagedAcpSupervisorApp({
      environment: { ...claimedEnvironment, ANTHROPIC_WORK_SECRET: "not-base64-json" },
      fetch: vi.fn(),
    });
    const invalidHarness = await invalidSecret.resolveHarness({ id: "codex-acp", version: "1" });
    await expect(invalidHarness!.start({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow("valid scoped ANTHROPIC_WORK_SECRET");
  });

  it.each([
    [zipSync({ "directory/": new Uint8Array() }), "has no SKILL.md"],
    [zipSync({ "README.md": new TextEncoder().encode("missing") }), "has no SKILL.md"],
    [zipSync({ "../escape/SKILL.md": new TextEncoder().encode("unsafe") }), "Unsafe Managed Skill archive path"],
    [zipSync({ "/absolute/SKILL.md": new TextEncoder().encode("unsafe") }), "Unsafe Managed Skill archive path"],
    [zipSync({ ".": new TextEncoder().encode("unsafe") }), "Unsafe Managed Skill archive path"],
  ] as const)("rejects an unsafe or incomplete Managed Skill archive %#", async (archive, message) => {
    const workspace = await mkdtemp(join(tmpdir(), "openma-node-supervisor-skill-"));
    roots.push(workspace);
    const agent = agentSnapshot({
      skills: [{ type: "custom", skill_id: "skill_1", version: "1" }],
    });
    const app = createNodeManagedAcpSupervisorApp({
      environment: claimedEnvironment,
      workspacePath: workspace,
      acpRuntime: fakeAcpRuntime([]),
      fetch: productionFetch({ agent, archive }),
      resolveAgent: async () => ({ command: "custom-acp" }),
    });
    const harness = await app.resolveHarness({ id: "custom", version: "1" });
    const run = await harness!.start({
      scope,
      harness: { id: "custom", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await expect(run.completed).rejects.toThrow(message);
    await run.stop("failed");
  });

  it("serves the production JSONL composition and forwards supervisor scheduling", async () => {
    const encoder = new TextEncoder();
    let output = "";
    const app = createNodeManagedAcpSupervisorApp({
      environment: {},
      heartbeatIntervalMs: 17,
      supervisorScheduler: { sleep: async () => {} },
    });
    await expect(app.serve({
      input: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "start",
            scope,
            harness: { id: "codex-acp", version: "2" },
            workspacePath: "/workspace",
            outputPath: null,
          })}\n`));
          controller.close();
        },
      }),
      output: new WritableStream({
        write(chunk) { output += new TextDecoder().decode(chunk); },
      }),
    })).rejects.toThrow("is not registered");
    expect(output).toContain('"type":"error"');
    expect(createNodeManagedAcpSupervisorApp()).toBeDefined();
  });

  it.each([
    [null, "agent"],
    [[], "agent"],
    [agentSnapshot({ model: null }), "agent.model"],
    [agentSnapshot({ model: { id: "" } }), "agent.model"],
    [agentSnapshot({ id: "" }), "agent.id"],
    [agentSnapshot({ version: 0 }), "agent.version"],
    [agentSnapshot({ version: 1.5 }), "agent.version"],
    [agentSnapshot({ system: undefined }), "agent.system"],
    [agentSnapshot({ mcp_servers: null }), "agent.mcp_servers"],
    [agentSnapshot({ mcp_servers: [null] }), "agent.mcp_servers[0]"],
    [agentSnapshot({ mcp_servers: [{ type: "stdio", name: "x", url: "https://x" }] }), "agent.mcp_servers[0]"],
    [agentSnapshot({ mcp_servers: [{ type: "url", name: "", url: "https://x" }] }), "agent.mcp_servers[0]"],
    [agentSnapshot({ mcp_servers: [{ type: "url", name: "x", url: "" }] }), "agent.mcp_servers[0]"],
    [agentSnapshot({ skills: null }), "agent.skills"],
    [agentSnapshot({ skills: [null] }), "agent.skills"],
    [agentSnapshot({ skills: [{ type: "", skill_id: "x", version: "1" }] }), "agent.skills[0]"],
    [agentSnapshot({ skills: [{ type: "custom", skill_id: "", version: "1" }] }), "agent.skills[0]"],
    [agentSnapshot({ skills: [{ type: "custom", skill_id: "x", version: "" }] }), "agent.skills[0]"],
    [agentSnapshot({ tools: null }), "agent.tools"],
    [agentSnapshot({ tools: [null] }), "agent.tools"],
  ] as const)("validates the official Session Agent snapshot %#", (agent, path) => {
    expect(() => decodeManagedAcpSessionSnapshot(sessionSnapshot(agent as never)))
      .toThrow(`Managed Session ${path} is invalid`);
  });
});
