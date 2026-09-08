import { describe, expect, it, vi } from "vitest";

import {
  createManagedHarnessHttpRecoveryHistory,
  createManagedHarnessHttpControlChannel,
  createManagedHarnessHttpSkillSource,
  ManagedHarnessHttpError,
} from "../src/http-control";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function session(status = "running") {
  return {
    id: scope.sessionId,
    environment_id: scope.environmentId,
    archived_at: null,
    status,
  };
}

describe("Managed harness HTTP control channel", () => {
  it("starts the selected sandbox agent and consumes only inputs after the last completed turn", async () => {
    let eventRequest = 0;
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) {
        return json(session());
      }
      if (request.url.includes(`/v1/sessions/${scope.sessionId}/events`)) {
        eventRequest += 1;
        if (eventRequest === 1) {
          return json({
            data: [
              {
                id: "old_prompt",
                type: "user.message",
                processed_at: "2026-09-08T01:00:00.000Z",
                content: [{ type: "text", text: "already done" }],
              },
              {
                id: "old_idle",
                type: "session.status_idle",
                processed_at: "2026-09-08T01:00:01.000Z",
                stop_reason: { type: "end_turn" },
              },
              {
                id: "new_prompt",
                type: "user.message",
                processed_at: "2026-09-08T01:00:02.000Z",
                content: [
                  { type: "text", text: "inspect" },
                  { type: "image", source: { type: "file", file_id: "file_1" } },
                ],
              },
            ],
            next_page: null,
          });
        }
        return json({
          data: [{
            id: "terminated",
            type: "session.status_terminated",
            processed_at: "2026-09-08T01:00:03.000Z",
          }],
          next_page: null,
        });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test/",
      sessionsToken: "session-token",
      fetch,
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
      eventIds: { next: () => "unused" },
      clock: { now: () => new Date("2026-09-08T01:00:00.000Z") },
    });

    const commands = [];
    for await (const command of channel.commands(new AbortController().signal)) {
      commands.push(command);
    }

    expect(commands).toEqual([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "pi-acp",
        runtime: "cloud",
        cwd: "/workspace",
        canonicalCompletedTurnId: "old_prompt",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "new_prompt",
        text: "inspect\n[image file: file_1]",
      },
      { type: "session.dispose", sessionId: scope.sessionId },
      { type: "control.complete", workId: scope.workId },
    ]);
    expect(requests.every((request) =>
      request.headers.get("authorization") === "Bearer session-token"
      && request.headers.get("anthropic-beta") === "managed-agents-2026-04-01"
    )).toBe(true);
    expect(requests[2]?.url).toContain("created_at%5Bgte%5D=2026-09-08T01%3A00%3A02.000Z");
  });

  it("prepares the retrieved Session snapshot before exposing session.start", async () => {
    const prepared: string[] = [];
    const snapshot = {
      ...session(),
      agent: {
        id: "agent_1",
        version: 7,
        model: { id: "deepseek-chat", speed: "fast" },
        mcp_servers: [{ type: "url", name: "docs", url: "https://mcp.test" }],
        skills: [{ type: "custom", skill_id: "skill_1", version: "3" }],
        system: "Work carefully",
        tools: [],
      },
    };
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(snapshot);
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
      throw new Error(`unexpected request ${request.url}`);
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
      onSessionLoaded: async (loaded) => {
        await Promise.resolve();
        expect(loaded).toEqual(snapshot);
        prepared.push("session");
      },
    });

    const iterator = channel.commands(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: "session.start" }),
    });
    expect(prepared).toEqual(["session"]);
    await channel.close();
  });

  it("polls concurrently so an interrupt can cancel an active prompt", async () => {
    let eventRequest = 0;
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(session());
      eventRequest += 1;
      return eventRequest === 1
        ? json({ data: [{
            id: "turn_1",
            type: "user.message",
            processed_at: "2026-09-08T01:00:00.000Z",
            content: [{ type: "text", text: "wait" }],
          }], next_page: null })
        : eventRequest === 2
          ? json({ data: [{
              id: "interrupt_1",
              type: "user.interrupt",
              processed_at: "2026-09-08T01:00:01.000Z",
            }], next_page: null })
          : json({ data: [{
              id: "terminated",
              type: "session.status_terminated",
              processed_at: "2026-09-08T01:00:02.000Z",
            }], next_page: null });
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
      eventIds: { next: () => "unused" },
      clock: { now: () => new Date("2026-09-08T01:00:00.000Z") },
    });
    const iterator = channel.commands(new AbortController().signal)[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_1",
        text: "wait",
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "session.cancel",
        sessionId: scope.sessionId,
        turnId: "turn_1",
      },
    });
    await channel.close();
  });

  it("retries transient publication with the same canonical event ids", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(await request.text());
      calls += 1;
      return calls === 1 ? json({ error: "busy" }, 503) : json({ recorded: 2 });
    });
    let id = 0;
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      retry: { maxAttempts: 2 },
      scheduler: { sleep: async () => {} },
      eventIds: { next: () => `event_${++id}` },
      clock: { now: () => new Date("2026-09-08T01:00:00.000Z") },
    });

    await channel.publish({
      type: "session.complete",
      sessionId: scope.sessionId,
      turnId: "turn_1",
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toEqual({
      events: [
        expect.objectContaining({ type: "session.status_running", id: "event_1" }),
        expect.objectContaining({ type: "span.model_request_start", id: "event_2" }),
        expect.objectContaining({ type: "span.model_request_end", id: "event_3" }),
        expect.objectContaining({ type: "session.status_idle", id: "event_4" }),
      ],
    });
  });

  it("publishes a canonical warning when native-state recovery is lossy", async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      bodies.push(await new Request(input, init).text());
      return json({ recorded: 1 });
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      eventIds: { next: () => "warning_1" },
      clock: { now: () => new Date("2026-09-08T01:00:00.000Z") },
    });

    await channel.publish({
      type: "session.warning",
      sessionId: scope.sessionId,
      source: "acp_semantic_recovery",
      message: "Agent-native session state was unavailable; continued from canonical OpenMA history.",
      details: { reason: "native-state-stale" },
    });

    expect(JSON.parse(bodies[0]!)).toEqual({
      events: [{
        id: "warning_1",
        type: "session.warning",
        processed_at: "2026-09-08T01:00:00.000Z",
        source: "acp_semantic_recovery",
        message: "Agent-native session state was unavailable; continued from canonical OpenMA history.",
        details: { reason: "native-state-stale" },
      }],
    });
  });

  it("fails closed without retrying an authoritative stale-token response", async () => {
    const fetch = vi.fn(async () => json({ error: "stale claim" }, 401));
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "stale-token",
      fetch,
      retry: { maxAttempts: 5 },
      scheduler: { sleep: async () => {} },
      eventIds: { next: () => "event_1" },
      clock: { now: () => new Date("2026-09-08T01:00:00.000Z") },
    });

    await expect(channel.publish({
      type: "session.disposed",
      sessionId: scope.sessionId,
    })).rejects.toMatchObject({ status: 401 } satisfies Partial<ManagedHarnessHttpError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads paginated canonical history for semantic recovery", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.includes("page=next_1")
        ? json({
            data: [
              {
                id: "message_2",
                type: "agent.message",
                processed_at: "2026-09-08T01:00:01.000Z",
                content: [{ type: "text", text: "done" }],
              },
              {
                id: "idle_1",
                type: "session.status_idle",
                processed_at: "2026-09-08T01:00:02.000Z",
              },
            ],
            next_page: null,
          })
        : json({
            data: [{
              id: "message_1",
              type: "user.message",
              processed_at: "2026-09-08T01:00:00.000Z",
              content: [{ type: "text", text: "repair" }],
            }],
            next_page: "next_1",
          });
    });
    const history = createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test/",
      sessionsToken: "session-token",
      fetch,
    });

    await expect(history.list(scope.sessionId)).resolves.toEqual([
      expect.objectContaining({ type: "user.message" }),
      expect.objectContaining({ type: "agent.message" }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("order=asc");
    expect(requests[1]?.url).toContain("page=next_1");
    expect(requests.every((request) =>
      request.headers.get("authorization") === "Bearer session-token"
    )).toBe(true);
  });

  it("downloads a concrete skill version as bytes with encoded path segments", async () => {
    const fetch = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: RequestInit,
    ) => new Response(Uint8Array.of(0, 255, 1)));
    const source = createManagedHarnessHttpSkillSource({
      apiBaseUrl: "https://api.openma.test/",
      sessionsToken: "session-token",
      fetch,
    });
    await expect(source.download({ skillId: "skill/a", version: "v 1" }))
      .resolves.toEqual(Uint8Array.of(0, 255, 1));
    const request = new Request(fetch.mock.calls[0]![0], fetch.mock.calls[0]![1]);
    expect(request.url).toBe("https://api.openma.test/v1/skills/skill%2Fa/versions/v%201/content");
    expect(request.headers.get("authorization")).toBe("Bearer session-token");
  });

  it("maps every canonical user input shape and ignores an idle interrupt", async () => {
    let eventRequest = 0;
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(session());
      eventRequest += 1;
      return eventRequest === 1
        ? json({
            data: [
              { id: "idle", type: "session.status_idle", processed_at: "2026-09-08T01:00:00.000Z" },
              { id: "interrupt", type: "user.interrupt", processed_at: "2026-09-08T01:00:01.000Z" },
              { id: "system", type: "system.message", processed_at: "2026-09-08T01:00:02.000Z", content: null },
              {
                id: "tool",
                type: "user.tool_result",
                processed_at: "2026-09-08T01:00:03.000Z",
                content: [{ type: "redacted" }],
              },
              {
                id: "custom",
                type: "user.custom_tool_result",
                processed_at: "2026-09-08T01:00:04.000Z",
                custom_tool_use_id: "custom_1",
                content: [{ type: "image", title: "chart", source: { url: "https://image.test" } }],
              },
              {
                id: "custom_unknown",
                type: "user.custom_tool_result",
                processed_at: "2026-09-08T01:00:04.500Z",
                content: [{ type: "image", source: null }],
              },
              {
                id: "confirmation",
                type: "user.tool_confirmation",
                processed_at: "2026-09-08T01:00:05.000Z",
              },
              {
                id: "outcome",
                type: "user.define_outcome",
                processed_at: "2026-09-08T01:00:06.000Z",
              },
              {
                id: "attachments",
                type: "user.message",
                processed_at: "2026-09-08T01:00:07.000Z",
                content: [
                  null,
                  { type: "audio" },
                  { type: "image", source: {} },
                  { type: "document", title: "spec", source: { file_id: "file_2" } },
                ],
              },
              { id: "telemetry", type: "span.other", processed_at: "2026-09-08T01:00:08.000Z" },
              { id: "terminated", type: "session.deleted", processed_at: "2026-09-08T01:00:09.000Z" },
            ],
            next_page: null,
          })
        : json({ data: [], next_page: null });
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });
    const commands = [];
    for await (const command of channel.commands(new AbortController().signal)) {
      commands.push(command);
    }
    expect(commands.filter((command) => command.type === "session.cancel")).toEqual([]);
    expect(commands.filter((command) => command.type === "session.prompt")).toEqual([
      expect.objectContaining({ turnId: "system", text: "" }),
      expect.objectContaining({ turnId: "tool", text: "Tool result for unknown:\n[redacted]" }),
      expect.objectContaining({
        turnId: "custom",
        text: "Custom tool result for custom_1:\n[image chart url: https://image.test]",
      }),
      expect.objectContaining({
        turnId: "custom_unknown",
        text: "Custom tool result for unknown:\n[image inline]",
      }),
      expect.objectContaining({
        turnId: "confirmation",
        text: "Tool unknown was answered.",
      }),
      expect.objectContaining({ turnId: "outcome", text: "Outcome requested: " }),
      expect.objectContaining({
        turnId: "attachments",
        text: "[image inline]\n[document spec file: file_2]",
      }),
    ]);
    expect(commands.at(-2)).toEqual({ type: "session.dispose", sessionId: scope.sessionId });
  });

  it.each([
    [null, "Session events response is invalid"],
    [{ data: "bad", next_page: null }, "Session events response is invalid"],
    [{ data: [null], next_page: null }, "Session event is invalid"],
    [{ data: [{ id: "", type: "user.message", processed_at: "now" }], next_page: null }, "Session event is invalid"],
    [{ data: [{ id: "x", type: 1, processed_at: "now" }], next_page: null }, "Session event is invalid"],
    [{ data: [{ id: "x", type: "user.message", processed_at: 1 }], next_page: null }, "Session event is invalid"],
    [{ data: [], next_page: 7 }, "next_page is invalid"],
  ] as const)("rejects malformed event page %#", async (page, message) => {
    const history = createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => json(page)),
    });
    await expect(history.list(scope.sessionId)).rejects.toThrow(message);
  });

  it("fails a waiting command iterator when Session retrieval fails", async () => {
    const failure = new Error("control plane unavailable");
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => { throw failure; }),
      retry: { maxAttempts: 1 },
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });
    const iterator = channel.commands(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(failure);
    await expect(iterator.next()).rejects.toBe(failure);
    await channel.close();
  });

  it("paginates live input, deduplicates overlap, and clears the active turn on idle", async () => {
    let eventRequest = 0;
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(session());
      eventRequest += 1;
      if (eventRequest === 1) {
        return json({
          data: [{
            id: "turn_newer",
            type: "user.message",
            processed_at: "2026-09-08T01:00:02.000Z",
            content: [{ type: "text", text: "newer" }],
          }],
          next_page: "page_2",
        });
      }
      if (eventRequest === 2) {
        return json({
          data: [
            {
              id: "turn_newer",
              type: "user.message",
              processed_at: "2026-09-08T01:00:02.000Z",
              content: [{ type: "text", text: "duplicate" }],
            },
            {
              id: "turn_older",
              type: "user.message",
              processed_at: "2026-09-08T01:00:01.000Z",
              content: [{ type: "text", text: "older page" }],
            },
          ],
          next_page: null,
        });
      }
      return json({
        data: [
          {
            id: "idle_live",
            type: "session.status_idle",
            processed_at: "2026-09-08T01:00:03.000Z",
          },
          {
            id: "interrupt_after_idle",
            type: "user.interrupt",
            processed_at: "2026-09-08T01:00:04.000Z",
          },
          {
            id: "terminated_live",
            type: "session.status_terminated",
            processed_at: "2026-09-08T01:00:05.000Z",
          },
        ],
        next_page: null,
      });
    });
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch,
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });

    const commands = [];
    for await (const command of channel.commands(new AbortController().signal)) {
      commands.push(command);
    }

    expect(commands.filter((command) => command.type === "session.prompt"))
      .toEqual([
        expect.objectContaining({ turnId: "turn_newer", text: "newer" }),
        expect.objectContaining({ turnId: "turn_older", text: "older page" }),
      ]);
    expect(commands.some((command) => command.type === "session.cancel")).toBe(false);
    expect(requests.some((request) => request.url.includes("page=page_2"))).toBe(true);
  });

  it("normalizes unreadable error bodies and preserves injected transport errors", async () => {
    const unreadable = createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => { throw new Error("body stream failed"); },
      }) as unknown as Response),
      retry: { maxAttempts: 1 },
    });
    await expect(unreadable.list(scope.sessionId)).rejects.toMatchObject({
      status: 400,
      message: expect.not.stringContaining("body stream failed"),
    });

    const injected = new ManagedHarnessHttpError("injected failure", null);
    const history = createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => { throw injected; }),
      retry: { maxAttempts: 2 },
      scheduler: { sleep: async () => {} },
    });
    await expect(history.list(scope.sessionId)).rejects.toBe(injected);
  });

  it("closes cleanly when the caller aborts during an in-flight request", async () => {
    const controller = new AbortController();
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "codex-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => {
        controller.abort(new Error("claim fenced"));
        throw new Error("socket closed");
      }),
      retry: { maxAttempts: 1 },
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });

    const iterator = channel.commands(controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await channel.close();
  });

  it("rejects construction when no global or injected fetch exists", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => createManagedHarnessHttpRecoveryHistory({
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "token",
      })).toThrow("A fetch implementation is required");
      expect(() => createManagedHarnessHttpSkillSource({
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "token",
      })).toThrow("A fetch implementation is required");
      expect(() => createManagedHarnessHttpControlChannel({
        scope,
        harness: { id: "pi-acp", version: "1" },
        workspacePath: "/workspace",
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "token",
      })).toThrow("A fetch implementation is required");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects mismatched Sessions and completes already archived Sessions", async () => {
    const mismatch = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(async () => json({ id: "wrong", environment_id: scope.environmentId })),
      retry: { maxAttempts: 1 },
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });
    await expect(
      mismatch.commands(new AbortController().signal)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("does not match the Work scope");

    for (const archived of [{ ...session(), archived_at: "2026-09-08" }, session("terminated")]) {
      const channel = createManagedHarnessHttpControlChannel({
        scope,
        harness: { id: "pi-acp", version: "1" },
        workspacePath: "/workspace",
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "session-token",
        fetch: vi.fn(async () => json(archived)),
        pollIntervalMs: 1,
        scheduler: { sleep: async () => {} },
      });
      const commands = [];
      for await (const command of channel.commands(new AbortController().signal)) commands.push(command);
      expect(commands).toEqual([{ type: "control.complete", workId: scope.workId }]);
    }
  });

  it("enforces single consumption, same-session publication, and close-before-start", async () => {
    const channel = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(),
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });
    const signal = new AbortController().signal;
    channel.commands(signal);
    expect(() => channel.commands(signal)).toThrow("only be consumed once");
    await expect(channel.publish({
      type: "session.disposed",
      sessionId: "session_other",
    })).rejects.toThrow("cross-session publication");
    await channel.close();

    const idle = createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "session-token",
      fetch: vi.fn(),
      pollIntervalMs: 1,
      scheduler: { sleep: async () => {} },
    });
    await idle.publish({
      type: "session.ready",
      sessionId: scope.sessionId,
      acpSessionId: "acp_1",
    });
    await idle.close();
  });

  it("uses the default timer for polling and aborts it without leaking handles", async () => {
    vi.useFakeTimers();
    try {
      let eventRequest = 0;
      const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(session());
        eventRequest += 1;
        return eventRequest === 1
          ? json({ data: [], next_page: null })
          : json({ data: [{
              id: "terminated",
              type: "session.status_terminated",
              processed_at: "2026-09-08T01:00:00.000Z",
            }], next_page: null });
      });
      const channel = createManagedHarnessHttpControlChannel({
        scope,
        harness: { id: "pi-acp", version: "1" },
        workspacePath: "/workspace",
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "session-token",
        fetch,
      });
      const iterator = channel.commands(new AbortController().signal)[Symbol.asyncIterator]();
      await iterator.next();
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(500);
      await expect(next).resolves.toMatchObject({ value: { type: "session.dispose" } });
      await channel.close();

      const controller = new AbortController();
      let polls = 0;
      const aborted = createManagedHarnessHttpControlChannel({
        scope,
        harness: { id: "pi-acp", version: "1" },
        workspacePath: "/workspace",
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "session-token",
        fetch: vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.url.endsWith(`/v1/sessions/${scope.sessionId}`)) return json(session());
          polls += 1;
          return json({ data: [], next_page: null });
        }),
      });
      const abortedIterator = aborted.commands(controller.signal)[Symbol.asyncIterator]();
      await abortedIterator.next();
      const waiting = abortedIterator.next();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      controller.abort(new Error("claim stopped"));
      await expect(waiting).resolves.toEqual({ done: true, value: undefined });
      expect(polls).toBe(1);
      await aborted.close();
      expect(vi.getTimerCount()).toBe(0);

      const alreadyAbortedController = new AbortController();
      alreadyAbortedController.abort(new Error("already fenced"));
      const alreadyAborted = createManagedHarnessHttpControlChannel({
        scope,
        harness: { id: "pi-acp", version: "1" },
        workspacePath: "/workspace",
        apiBaseUrl: "https://api.openma.test",
        sessionsToken: "session-token",
        fetch: vi.fn(),
      });
      await expect(
        alreadyAborted.commands(alreadyAbortedController.signal)[Symbol.asyncIterator]().next(),
      ).resolves.toEqual({ done: true, value: undefined });
      await alreadyAborted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates transport configuration and normalizes exhausted non-Error failures", async () => {
    expect(() => createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "",
      sessionsToken: "token",
    })).toThrow("apiBaseUrl and sessionsToken are required");
    expect(() => createManagedHarnessHttpSkillSource({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "",
    })).toThrow("apiBaseUrl and sessionsToken are required");
    expect(() => createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "token",
      retry: { maxAttempts: 0 },
    })).toThrow("retry.maxAttempts must be a positive integer");
    expect(() => createManagedHarnessHttpControlChannel({
      scope,
      harness: { id: "pi-acp", version: "1" },
      workspacePath: "/workspace",
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "token",
      pollIntervalMs: 0,
    })).toThrow("pollIntervalMs must be a positive integer");

    const history = createManagedHarnessHttpRecoveryHistory({
      apiBaseUrl: "https://api.openma.test",
      sessionsToken: "token",
      fetch: vi.fn(async () => { throw "offline"; }),
      retry: { maxAttempts: 2 },
      scheduler: { sleep: async () => {} },
    });
    await expect(history.list(scope.sessionId)).rejects.toThrow("Harness control request failed");
  });
});
