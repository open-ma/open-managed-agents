import { describe, expect, it } from "vitest";

import { createManagedAgentsRuntime } from "../src/index";
import { acpSessionFixture } from "./acp-fixtures";

describe("createManagedAgentsRuntime", () => {
  it("prepares and starts a typed local session command", async () => {
    const events: unknown[] = [];
    const preparedCommands: unknown[] = [];
    const startedOptions: unknown[] = [];
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start(options: unknown) {
          startedOptions.push(options);
          return acpSessionFixture({
            acpSessionId: "acp-runtime-1",
            async *prompt() {},
            async dispose() {},
          });
        },
      },
      sessionPreparation: {
        async prepare(command: unknown) {
          preparedCommands.push(command);
          return {
            agent: { command: "claude-agent-acp", cwd: "/sessions/runtime-1" },
            resumeAcpSessionId: "acp-previous",
          };
        },
      },
    });
    runtime.attach({ publish: (event: unknown) => events.push(event) });

    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-1",
      agentId: "claude-acp",
      runtime: "local",
      acpSessionId: "acp-previous",
    });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-1",
      agentId: "claude-acp",
      runtime: "local",
      acpSessionId: "acp-previous",
    });

    expect(preparedCommands).toEqual([{
      type: "session.start",
      sessionId: "session-runtime-1",
      agentId: "claude-acp",
      runtime: "local",
      acpSessionId: "acp-previous",
    }]);
    expect(startedOptions).toEqual([{
      agent: { command: "claude-agent-acp", cwd: "/sessions/runtime-1" },
      resumeAcpSessionId: "acp-previous",
    }]);
    expect(events).toEqual([
      {
        type: "session.ready",
        sessionId: "session-runtime-1",
        acpSessionId: "acp-runtime-1",
      },
      {
        type: "session.ready",
        sessionId: "session-runtime-1",
        acpSessionId: "acp-runtime-1",
      },
    ]);
  });

  it("reports a preparation failure as a session error", async () => {
    const events: unknown[] = [];
    let starts = 0;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          starts += 1;
          return acpSessionFixture({ acpSessionId: "must-not-start" });
        },
      },
      sessionPreparation: {
        async prepare() {
          throw new Error("agent binary is unavailable");
        },
      },
    });
    runtime.attach({ publish: (event: unknown) => events.push(event) });

    await expect(runtime.dispatch({
      type: "session.start",
      sessionId: "session-prepare-error",
      agentId: "missing-agent",
      runtime: "local",
    })).resolves.toBeUndefined();

    expect(starts).toBe(0);
    expect(events).toEqual([{
      type: "session.error",
      sessionId: "session-prepare-error",
      message: "agent binary is unavailable",
    }]);
  });

  it("routes a prompt command to its live ACP session without preparing again", async () => {
    const events: unknown[] = [];
    let preparations = 0;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          return acpSessionFixture({
            acpSessionId: "acp-runtime-prompt",
            async *prompt(text: string) {
              yield { type: "agent_message_chunk", text: `answer:${text}` };
            },
            async dispose() {},
          });
        },
      },
      sessionPreparation: {
        async prepare() {
          preparations += 1;
          return { agent: { command: "prompt-agent" } };
        },
      },
    });
    runtime.attach({ publish: (event: unknown) => events.push(event) });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-prompt",
      agentId: "prompt-agent",
      runtime: "local",
    });
    events.length = 0;

    await runtime.dispatch({
      type: "session.prompt",
      sessionId: "session-runtime-prompt",
      turnId: "turn-runtime-prompt",
      text: "hello",
    });

    expect(preparations).toBe(1);
    expect(events).toEqual([
      {
        type: "session.event",
        sessionId: "session-runtime-prompt",
        turnId: "turn-runtime-prompt",
        event: { type: "agent_message_chunk", text: "answer:hello" },
      },
      {
        type: "session.complete",
        sessionId: "session-runtime-prompt",
        turnId: "turn-runtime-prompt",
      },
    ]);
  });

  it("replays completion without running ACP again when a completed turn is redelivered", async () => {
    const events: unknown[] = [];
    let promptCount = 0;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          return acpSessionFixture({
            acpSessionId: "acp-runtime-idempotent",
            async *prompt() {
              promptCount += 1;
              yield { type: "agent_message_chunk", text: "only once" };
            },
          });
        },
      },
      sessionPreparation: {
        async prepare() {
          return { agent: { command: "idempotent-agent" } };
        },
      },
    });
    runtime.attach({ publish: (event: unknown) => events.push(event) });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-idempotent",
      agentId: "idempotent-agent",
      runtime: "cloud",
    });
    events.length = 0;
    const command = {
      type: "session.prompt" as const,
      sessionId: "session-runtime-idempotent",
      turnId: "turn-runtime-idempotent",
      text: "apply the change",
    };

    await runtime.dispatch(command);
    await runtime.dispatch(command);

    expect(promptCount).toBe(1);
    expect(events).toEqual([
      {
        type: "session.event",
        sessionId: "session-runtime-idempotent",
        turnId: "turn-runtime-idempotent",
        event: { type: "agent_message_chunk", text: "only once" },
      },
      {
        type: "session.complete",
        sessionId: "session-runtime-idempotent",
        turnId: "turn-runtime-idempotent",
      },
      {
        type: "session.complete",
        sessionId: "session-runtime-idempotent",
        turnId: "turn-runtime-idempotent",
      },
    ]);
  });

  it("routes cancel to the selected active turn", async () => {
    let promptSignal: AbortSignal | undefined;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          return acpSessionFixture({
            acpSessionId: "acp-runtime-cancel",
            async *prompt(text: string, options?: { abortSignal?: AbortSignal }) {
              if (text !== "wait") throw new Error("cancel was routed as a prompt");
              promptSignal = options?.abortSignal;
              await new Promise<void>((resolve) => {
                if (promptSignal?.aborted) resolve();
                else promptSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
            },
            async dispose() {},
          });
        },
      },
      sessionPreparation: {
        async prepare() {
          return { agent: { command: "cancel-agent" } };
        },
      },
    });
    runtime.attach({ publish() {} });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-cancel",
      agentId: "cancel-agent",
      runtime: "local",
    });
    void runtime.dispatch({
      type: "session.prompt",
      sessionId: "session-runtime-cancel",
      turnId: "turn-runtime-cancel",
      text: "wait",
    });
    await Promise.resolve();

    await expect(runtime.dispatch({
      type: "session.cancel",
      sessionId: "session-runtime-cancel",
      turnId: "turn-runtime-cancel",
    })).resolves.toBeUndefined();
    expect(promptSignal?.aborted).toBe(true);
  });

  it("routes dispose and emits the matching host event", async () => {
    const events: unknown[] = [];
    let disposeCount = 0;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          return acpSessionFixture({
            acpSessionId: "acp-runtime-dispose",
            async *prompt() {},
            async dispose() { disposeCount += 1; },
          });
        },
      },
      sessionPreparation: {
        async prepare() {
          return { agent: { command: "dispose-agent" } };
        },
      },
    });
    runtime.attach({ publish: (event: unknown) => events.push(event) });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-dispose",
      agentId: "dispose-agent",
      runtime: "local",
    });
    events.length = 0;

    await runtime.dispatch({
      type: "session.dispose",
      sessionId: "session-runtime-dispose",
    });

    expect(disposeCount).toBe(1);
    expect(events).toEqual([{
      type: "session.disposed",
      sessionId: "session-runtime-dispose",
    }]);
  });

  it("drains live sessions through the top-level runtime lifecycle", async () => {
    let disposeCount = 0;
    const runtime = createManagedAgentsRuntime({
      acpRuntime: {
        async start() {
          return acpSessionFixture({
            acpSessionId: "acp-runtime-drain",
            async dispose() { disposeCount += 1; },
          });
        },
      },
      sessionPreparation: {
        async prepare() {
          return { agent: { command: "drain-agent" } };
        },
      },
    });
    runtime.attach({ publish() {} });
    await runtime.dispatch({
      type: "session.start",
      sessionId: "session-runtime-drain",
      agentId: "drain-agent",
      runtime: "local",
    });

    const report = await runtime.drain({ deadlineMs: 0, abortGraceMs: 0 });

    expect(report).toEqual({
      initialTurns: 0,
      abortedTurns: 0,
      sessions: 1,
    });
    expect(disposeCount).toBe(1);
  });
});
