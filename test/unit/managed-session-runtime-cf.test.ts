import { describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { CfManagedSessionRuntimeAdapter } from "../../apps/main/src/lib/cf-managed-session-runtime";

const runtimeAdapterSources = import.meta.glob(
  "../../apps/main/src/lib/cf-managed-session-runtime.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: "Runtime snapshot",
    mcpServers: [{ type: "url", name: "docs", url: "https://mcp.test" }],
    model: { id: "claude-opus-5", effort: "high", speed: "fast" },
    multiagent: null,
    name: "Coding agent",
    skills: [{ type: "anthropic", skillId: "pdf", version: "latest" }],
    system: "Work carefully",
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [],
        defaultConfig: {
          enabled: true,
          permissionPolicy: { type: "always_allow" },
        },
      },
    ],
    version: 3,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T01:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "Ship runtime",
  updatedAt: "2026-08-26T01:00:00.000Z",
  usage: {},
  vaultIds: ["vault_01"],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: {
    type: "cloud",
    networking: {
      type: "limited",
      allowMcpServers: true,
      allowPackageManagers: false,
      allowedHosts: ["api.example.com"],
    },
    packages: {
      apt: ["git"],
      cargo: [],
      gem: [],
      go: [],
      npm: ["tsx"],
      pip: ["httpx"],
    },
  },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: "Cloud sandbox",
  metadata: { owner: "runtime" },
  name: "Default cloud",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

describe("CfManagedSessionRuntimeAdapter", () => {
  it("routes lifecycle and accepted events entirely from application snapshots", async () => {
    const requests: Request[] = [];
    const fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input, init);
        requests.push(request);
        return new Response(null, { status: 204 });
      },
    };
    const adapter = new CfManagedSessionRuntimeAdapter(fetcher);

    await adapter.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [
        { type: "user.message", content: [{ type: "text", text: "Start" }] },
      ],
    });
    await adapter.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [
        {
          id: "event_01",
          type: "user.tool_confirmation",
          result: "deny",
          toolUseId: "toolu_01",
          denyMessage: "Not allowed",
          sessionThreadId: "thread_01",
          processedAt: "2026-08-26T02:00:00.000Z",
        },
      ],
    });
    await adapter.sessionThreadArchived({
      workspaceId: "workspace_01",
      sessionId: session.id,
      threadId: "thread_01",
      session,
      thread: {
        id: "thread_01",
        agent: {
          type: "agent",
          id: "agent_01",
          description: null,
          mcpServers: [],
          model: { id: "claude-opus-5" },
          name: "Coding agent",
          skills: [],
          system: null,
          tools: [],
          version: 3,
        },
        archivedAt: "2026-08-26T03:00:00.000Z",
        createdAt: "2026-08-26T01:00:00.000Z",
        parentThreadId: null,
        sessionId: session.id,
        stats: null,
        status: "terminated",
        updatedAt: "2026-08-26T03:00:00.000Z",
        usage: null,
      },
    });
    await adapter.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: { ...session, archivedAt: "2026-08-26T04:00:00.000Z" },
      reason: "archived",
    });

    expect(
      requests.map((request) => request.headers.get("x-oma-workspace-id")),
    ).toEqual([
      "workspace_01",
      "workspace_01",
      "workspace_01",
      "workspace_01",
    ]);

    expect(
      await Promise.all(
        requests.map(async (request) => ({
          method: request.method,
          path: new URL(request.url).pathname,
          body:
            request.method === "DELETE" ? null : await request.clone().json(),
        })),
      ),
    ).toEqual([
      {
        method: "PUT",
        path: "/sessions/session_01/init",
        body: {
          agent_id: "agent_01",
          environment_id: "env_01",
          title: "Ship runtime",
          session_id: "session_01",
          tenant_id: "workspace_01",
          vault_ids: ["vault_01"],
          agent_snapshot: {
            id: "agent_01",
            name: "Coding agent",
            description: "Runtime snapshot",
            model: { id: "claude-opus-5", effort: "high", speed: "fast" },
            system: "Work carefully",
            tools: [
              {
                type: "agent_toolset_20260401",
                configs: [],
                default_config: {
                  enabled: true,
                  permission_policy: { type: "always_allow" },
                },
              },
            ],
            mcp_servers: [
              { type: "url", name: "docs", url: "https://mcp.test" },
            ],
            skills: [
              { type: "anthropic", skill_id: "pdf", version: "latest" },
            ],
            version: 3,
            created_at: "2026-08-26T01:00:00.000Z",
            updated_at: "2026-08-26T01:00:00.000Z",
          },
          environment_snapshot: {
            type: "environment",
            id: "env_01",
            name: "Default cloud",
            description: "Cloud sandbox",
            config: {
              type: "cloud",
              networking: {
                type: "limited",
                allow_mcp_servers: true,
                allow_package_managers: false,
                allowed_hosts: ["api.example.com"],
              },
              packages: {
                apt: ["git"],
                cargo: [],
                gem: [],
                go: [],
                npm: ["tsx"],
                pip: ["httpx"],
              },
            },
            metadata: { owner: "runtime" },
            created_at: "2026-08-26T00:00:00.000Z",
            updated_at: "2026-08-26T00:00:00.000Z",
          },
          init_events: [
            { type: "user.message", content: [{ type: "text", text: "Start" }] },
          ],
        },
      },
      {
        method: "POST",
        path: "/sessions/session_01/event",
        body: {
          id: "event_01",
          type: "user.tool_confirmation",
          result: "deny",
          tool_use_id: "toolu_01",
          deny_message: "Not allowed",
          session_thread_id: "thread_01",
          processed_at: "2026-08-26T02:00:00.000Z",
        },
      },
      {
        method: "POST",
        path: "/sessions/session_01/threads/thread_01/archive",
        body: {},
      },
      {
        method: "DELETE",
        path: "/sessions/session_01/destroy",
        body: null,
      },
    ]);
  });

  it("decodes the runtime WebSocket into protocol-neutral official stream events", async () => {
    const socket = new FakeWebSocket([
      {
        id: "event_status_01",
        type: "session.status_running",
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        type: "agent.message_stream_start",
        message_id: "event_message_01",
      },
      {
        type: "agent.message_chunk",
        message_id: "event_message_01",
        delta: "Hello",
      },
      {
        type: "agent.message_stream_end",
        message_id: "event_message_01",
        status: "completed",
      },
      {
        id: "event_message_01",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processed_at: "2026-08-26T02:00:01.000Z",
      },
      {
        id: "event_idle_01",
        type: "session.status_idle",
        processed_at: "2026-08-26T02:00:02.000Z",
        stop_reason: { type: "end_turn" },
      },
    ]);
    const adapter = new CfManagedSessionRuntimeAdapter({
      fetch: async () =>
        ({ ok: true, status: 101, webSocket: socket }) as unknown as Response,
    });

    const received = [];
    for await (const event of adapter.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      deltaEventTypes: ["agent.message"],
    })) {
      received.push(event);
    }

    expect(received).toEqual([
      {
        id: "event_status_01",
        type: "session.status_running",
        processedAt: "2026-08-26T02:00:00.000Z",
      },
      {
        type: "event_start",
        event: { id: "event_message_01", type: "agent.message" },
      },
      {
        type: "event_delta",
        eventId: "event_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Hello" },
        },
      },
      {
        id: "event_message_01",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processedAt: "2026-08-26T02:00:01.000Z",
      },
      {
        id: "event_idle_01",
        type: "session.status_idle",
        processedAt: "2026-08-26T02:00:02.000Z",
        stopReason: { type: "end_turn" },
      },
    ]);
  });

  it("reconnects a dropped runtime WebSocket with replay and deduplicates canonical events", async () => {
    const requests: Request[] = [];
    const sockets = [
      new FakeWebSocket([
        {
          id: "event_user_01",
          type: "user.message",
          content: [{ type: "text", text: "Hello" }],
          processed_at: "2026-08-26T02:00:00.000Z",
        },
      ]),
      new FakeWebSocket([
        {
          id: "event_user_01",
          type: "user.message",
          content: [{ type: "text", text: "Hello" }],
          processed_at: "2026-08-26T02:00:00.000Z",
        },
        {
          id: "event_running_01",
          type: "session.status_running",
          processed_at: "2026-08-26T02:00:01.000Z",
        },
        {
          id: "event_message_01",
          type: "agent.message",
          content: [{ type: "text", text: "E2E_OK" }],
          processed_at: "2026-08-26T02:00:02.000Z",
        },
        {
          id: "event_idle_01",
          type: "session.status_idle",
          processed_at: "2026-08-26T02:00:03.000Z",
          stop_reason: { type: "end_turn" },
        },
      ]),
    ];
    let attempt = 0;
    const adapter = new CfManagedSessionRuntimeAdapter({
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        attempt += 1;
        if (attempt === 2) return new Response("runtime restarting", { status: 503 });
        const socket = sockets.shift();
        if (socket === undefined) throw new Error("unexpected reconnect");
        return ({ ok: true, status: 101, webSocket: socket }) as unknown as Response;
      },
    });

    const received = [];
    for await (const event of adapter.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })) {
      received.push(event);
    }

    expect(requests.map((request) => request.headers.get("x-oma-replay"))).toEqual([
      null,
      "1",
      "1",
    ]);
    expect(received.map(({ type }) => type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
  });

  it("depends inward on application ports without importing legacy routing or stores", () => {
    expect(Object.keys(runtimeAdapterSources)).toEqual([
      "../../apps/main/src/lib/cf-managed-session-runtime.ts",
    ]);
    const source = Object.values(runtimeAdapterSources)[0] ?? "";
    expect(source).toContain("@open-managed-agents/managed-agents-application");
    expect(source).not.toMatch(/@open-managed-agents\/(?:managed-agents-api|session-runtime(?:["/])|services|sessions-store|environments-store|shared)/);
    expect(source).not.toMatch(/@anthropic-ai\/sdk/);
    expect(source).not.toMatch(/CfSessionRouter|SessionRouter|managed_sessions|session_events/);
  });
});

class FakeWebSocket {
  private readonly listeners = new Map<string, Array<(event: object) => void>>();
  private peerClosed = false;

  constructor(private readonly frames: object[]) {}

  addEventListener(type: string, listener: (event: object) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  accept(): void {
    queueMicrotask(() => {
      for (const frame of this.frames) {
        this.emit("message", { data: JSON.stringify(frame) });
      }
      this.peerClosed = true;
      this.emit("close", {});
    });
  }

  close(): void {
    if (this.peerClosed) throw new Error("WebSocket is already closed");
  }

  private emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
