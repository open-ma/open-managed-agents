import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/bridge/lib/session-manager";
import { acpSessionFixture } from "../../managed-agents-runtime/test/acp-fixtures";

describe("SessionManager runtime adapter", () => {
  it("prepares a tenant-scoped start through the shared runtime", async () => {
    const messages: unknown[] = [];
    const prepared: unknown[] = [];
    const started: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message),
      {
        acpRuntime: {
          async start(options: unknown) {
            started.push(options);
            return acpSessionFixture({ acpSessionId: "acp-cli-runtime" });
          },
        },
        async prepareSession(input: unknown) {
          prepared.push(input);
          return {
            agent: { command: "fixture-agent", cwd: "/fixture/session" },
            resumeAcpSessionId: "acp-resume",
          };
        },
      },
    );
    manager.setTenantKeys([{
      id: "workspace-1",
      agentApiKey: "oma_fixture_key",
    }]);
    manager.setSpawnEnv({
      apiUrl: "https://managed.example.test",
      runtimeToken: "sk_machine_fixture",
    });

    await manager.start({
      session_id: "session-cli-runtime",
      agent_id: "fixture-agent",
      tenant_id: "workspace-1",
      resume: { acp_session_id: "acp-resume" },
    });

    expect(prepared).toEqual([{
      command: {
        type: "session.start",
        sessionId: "session-cli-runtime",
        agentId: "fixture-agent",
        runtime: "local",
        acpSessionId: "acp-resume",
      },
      scope: {
        id: "workspace-1",
        agentApiKey: "oma_fixture_key",
      },
      environment: {
        apiUrl: "https://managed.example.test",
        runtimeToken: "sk_machine_fixture",
      },
    }]);
    expect(started).toEqual([{
      agent: { command: "fixture-agent", cwd: "/fixture/session" },
      resumeAcpSessionId: "acp-resume",
    }]);
    expect(messages).toEqual([{
      type: "session.ready",
      session_id: "session-cli-runtime",
      tenant_id: "workspace-1",
      acp_session_id: "acp-cli-runtime",
    }]);
  });

  it("keeps the original scope when an idempotent start is replayed", async () => {
    const messages: unknown[] = [];
    let preparations = 0;
    const manager = new SessionManager(
      (message) => messages.push(message),
      {
        acpRuntime: {
          async start() {
            return acpSessionFixture({ acpSessionId: "acp-cli-pinned" });
          },
        },
        async prepareSession() {
          preparations += 1;
          return { agent: { command: "fixture-agent" } };
        },
      },
    );
    manager.setTenantKeys([
      { id: "workspace-original", agentApiKey: "oma_original" },
      { id: "workspace-replay", agentApiKey: "oma_replay" },
    ]);
    await manager.start({
      session_id: "session-cli-pinned",
      agent_id: "fixture-agent",
      tenant_id: "workspace-original",
    });
    messages.length = 0;

    await manager.start({
      session_id: "session-cli-pinned",
      agent_id: "fixture-agent",
      tenant_id: "workspace-replay",
    });

    expect(preparations).toBe(1);
    expect(messages).toEqual([{
      type: "session.ready",
      session_id: "session-cli-pinned",
      tenant_id: "workspace-original",
      acp_session_id: "acp-cli-pinned",
    }]);
  });

  it("routes prompt events through the shared runtime wire codec", async () => {
    const messages: unknown[] = [];
    const manager = new SessionManager(
      (message) => messages.push(message),
      {
        acpRuntime: {
          async start() {
            return acpSessionFixture({
              acpSessionId: "acp-cli-prompt",
              async *prompt(text: string) {
                yield { type: "agent_message_chunk", text: `reply:${text}` };
                yield {
                  type: "promptComplete",
                  response: {
                    stopReason: "end_turn",
                    usage: {
                      totalTokens: 110,
                      inputTokens: 10,
                      outputTokens: 5,
                      cachedReadTokens: 95,
                    },
                  },
                };
              },
            });
          },
        },
        async prepareSession() {
          return { agent: { command: "fixture-agent" } };
        },
      },
    );
    manager.setTenantKeys([{
      id: "workspace-prompt",
      agentApiKey: "oma_prompt_key",
    }]);
    await manager.start({
      session_id: "session-cli-prompt",
      agent_id: "fixture-agent",
      tenant_id: "workspace-prompt",
    });
    messages.length = 0;

    await manager.prompt({
      session_id: "session-cli-prompt",
      turn_id: "turn-cli-prompt",
      text: "hello",
    });

    expect(messages).toEqual([
      {
        type: "session.event",
        session_id: "session-cli-prompt",
        tenant_id: "workspace-prompt",
        turn_id: "turn-cli-prompt",
        event: { type: "agent_message_chunk", text: "reply:hello" },
      },
      {
        type: "session.event",
        session_id: "session-cli-prompt",
        tenant_id: "workspace-prompt",
        turn_id: "turn-cli-prompt",
        event: {
          type: "promptComplete",
          response: {
            stopReason: "end_turn",
            usage: {
              totalTokens: 110,
              inputTokens: 10,
              outputTokens: 5,
              cachedReadTokens: 95,
            },
          },
        },
      },
      {
        type: "session.complete",
        session_id: "session-cli-prompt",
        tenant_id: "workspace-prompt",
        turn_id: "turn-cli-prompt",
      },
    ]);
  });

  it("routes cancellation to the shared runtime turn", async () => {
    let promptSignal: AbortSignal | undefined;
    const manager = new SessionManager(
      () => {},
      {
        acpRuntime: {
          async start() {
            return acpSessionFixture({
              acpSessionId: "acp-cli-cancel",
              async *prompt(_text: string, options?: { abortSignal?: AbortSignal }) {
                promptSignal = options?.abortSignal;
                await new Promise<void>((resolve) => {
                  if (promptSignal?.aborted) resolve();
                  else promptSignal?.addEventListener("abort", () => resolve(), { once: true });
                });
              },
            });
          },
        },
        async prepareSession() {
          return { agent: { command: "fixture-agent" } };
        },
      },
    );
    manager.setTenantKeys([{
      id: "workspace-cancel",
      agentApiKey: "oma_cancel_key",
    }]);
    await manager.start({
      session_id: "session-cli-cancel",
      agent_id: "fixture-agent",
      tenant_id: "workspace-cancel",
    });
    void manager.prompt({
      session_id: "session-cli-cancel",
      turn_id: "turn-cli-cancel",
      text: "wait",
    });
    await Promise.resolve();

    manager.cancel("session-cli-cancel", "turn-cli-cancel");

    expect(promptSignal?.aborted).toBe(true);
  });

  it("escalates a cancellation ignored by an ACP child after the PC grace", async () => {
    let releasePrompt: (() => void) | undefined;
    let disposeCount = 0;
    const sleeps: number[] = [];
    const manager = new SessionManager(
      () => {},
      {
        acpRuntime: {
          async start() {
            return acpSessionFixture({
              acpSessionId: "acp-cli-stuck-cancel",
              async *prompt() {
                await new Promise<void>((resolve) => { releasePrompt = resolve; });
              },
              async dispose() {
                disposeCount += 1;
                releasePrompt?.();
              },
            });
          },
        },
        async prepareSession() {
          return { agent: { command: "fixture-agent" } };
        },
        runtimeScheduler: {
          now: () => 0,
          async sleep(ms: number) { sleeps.push(ms); },
        },
        cancelGraceMs: 25,
      },
    );
    manager.setTenantKeys([{
      id: "workspace-stuck-cancel",
      agentApiKey: "oma_stuck_cancel_key",
    }]);
    await manager.start({
      session_id: "session-cli-stuck-cancel",
      agent_id: "fixture-agent",
      tenant_id: "workspace-stuck-cancel",
    });
    void manager.prompt({
      session_id: "session-cli-stuck-cancel",
      turn_id: "turn-cli-stuck-cancel",
      text: "wait forever",
    });
    await Promise.resolve();

    manager.cancel("session-cli-stuck-cancel", "turn-cli-stuck-cancel");
    await expect.poll(() => disposeCount).toBe(1);

    expect(sleeps).toEqual([25]);
    expect(manager.has("session-cli-stuck-cancel")).toBe(false);
  });

  it("disposes the shared runtime session and releases Node resources", async () => {
    const messages: unknown[] = [];
    const released: string[] = [];
    let disposeCount = 0;
    const manager = new SessionManager(
      (message) => messages.push(message),
      {
        acpRuntime: {
          async start() {
            return acpSessionFixture({
              acpSessionId: "acp-cli-dispose",
              async dispose() { disposeCount += 1; },
            });
          },
        },
        async prepareSession() {
          return { agent: { command: "fixture-agent" } };
        },
        async releaseSession(sessionId: string) {
          released.push(sessionId);
        },
      },
    );
    manager.setTenantKeys([{
      id: "workspace-dispose",
      agentApiKey: "oma_dispose_key",
    }]);
    await manager.start({
      session_id: "session-cli-dispose",
      agent_id: "fixture-agent",
      tenant_id: "workspace-dispose",
    });
    messages.length = 0;

    await manager.dispose("session-cli-dispose");

    expect(disposeCount).toBe(1);
    expect(released).toEqual(["session-cli-dispose"]);
    expect(messages).toEqual([{
      type: "session.disposed",
      session_id: "session-cli-dispose",
      tenant_id: "workspace-dispose",
    }]);
  });
});
