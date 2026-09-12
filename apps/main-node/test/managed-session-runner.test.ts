import { describe, expect, it, vi } from "vitest";
import { withReportedArtifactPublication } from "../src/openai-artifact-publication";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionEvent } from "@open-managed-agents/shared";
import type {
  Environment,
  Session,
  SessionEventView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import type {
  NodeManagedSessionRunner,
  NodeManagedSessionRunnerAcceptInput,
} from "../src/lib/node-managed-session-runtime.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

interface RunnerConstructor {
  new (dependencies: {
    buildSandbox(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
    }): Promise<SandboxExecutor>;
    prepareSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
    }): Promise<void>;
    synchronizeSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    afterExecution?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    buildModel(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
    }): Promise<unknown>;
    buildTools(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
    }): Promise<unknown>;
    disposeTools?(tools: unknown): Promise<void>;
    buildHarness(): { run(context: unknown): Promise<void> };
    buildHarnessContext(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
      sandbox: SandboxExecutor;
      runtime: {
        broadcast(event: SessionEvent): void;
      };
      model: unknown;
      tools: unknown;
    }): Promise<unknown>;
    confirmedTools: {
      execute(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        sandbox: SandboxExecutor;
        confirmation: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.tool_confirmation" }
        >;
        toolUse: Extract<
          SessionEventView,
          { type: "agent.tool_use" | "agent.mcp_tool_use" }
        >;
        abortSignal: AbortSignal;
      }): Promise<{
        content?: ToolResultContentBlock[];
        isError?: boolean | null;
      }>;
    };
    outcomes: {
      evaluate(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        outcome: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.define_outcome" }
        >;
        historyEvents: SessionEventView[];
        iteration: number;
        abortSignal: AbortSignal;
      }): Promise<{
        result: "satisfied" | "needs_revision" | "failed";
        explanation: string;
        usage: {
          cacheCreationInputTokens: number;
          cacheReadInputTokens: number;
          inputTokens: number;
          outputTokens: number;
        };
      }>;
    };
    clock: { now(): Date };
    ids: { nextEventId(): string };
    runtimeGenerations?: { next(): string };
  }): NodeManagedSessionRunner & { connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null };
}

describe("DefaultNodeManagedSessionRunner", () => {
  it("prepares Session inputs after sandbox creation and before it becomes executable", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const order: string[] = [];
    const sandbox = {
      destroy: vi.fn(async () => { order.push("destroy"); }),
    } as unknown as SandboxExecutor;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        order.push("build");
        return sandbox;
      },
      prepareSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
        });
        order.push("prepare");
      },
      buildModel: async () => {
        order.push("model");
        return {};
      },
      buildTools: async () => {
        order.push("tools");
        return {};
      },
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    expect(order).toEqual(["build", "prepare"]);
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBe(sandbox);
    expect(runner.connectedSandbox({ workspaceId: "workspace_other", sessionId: session.id })).toBeNull();
    await runner.stop({ workspaceId: "workspace_01", sessionId: session.id });
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
  });

  it("destroys a new sandbox when Session input preparation fails", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroy = vi.fn(async () => undefined);
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({ destroy } as unknown as SandboxExecutor),
      prepareSandbox: async () => { throw new Error("input staging failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    await expect(runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    })).rejects.toThrow("input staging failed");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("replaces a prepared sandbox when the Session resource snapshot changes", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroyed: number[] = [];
    const preparedResourceCounts: number[] = [];
    let generation = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        generation += 1;
        const current = generation;
        return {
          destroy: async () => { destroyed.push(current); },
        } as SandboxExecutor;
      },
      prepareSandbox: async ({ session }) => {
        preparedResourceCounts.push(session.resources.length);
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_resource_refresh" },
    });
    const changedSession: Session = {
      ...session,
      resources: [{
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T03:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T03:00:00.000Z",
      }],
    };

    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: changedSession,
      environment,
      initialEvents: [],
    });

    expect(preparedResourceCounts).toEqual([0, 1]);
    expect(destroyed).toEqual([1]);
  });

  it("runs a user message between official lifecycle events", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(
      () => ({}),
    ) as { DefaultNodeManagedSessionRunner?: RunnerConstructor };
    const Runner = runnerModule.DefaultNodeManagedSessionRunner ?? class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async accept(): Promise<void> {}
      async archiveThread(): Promise<void> {}
    } as RunnerConstructor;
    const sandbox = {} as SandboxExecutor;
    const contexts: unknown[] = [];
    const lifecycle: string[] = [];
    const builtTools = { bash: { type: "tool" } };
    let nextId = 0;
    const runner = new Runner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({ type: "model" }),
      buildTools: async () => builtTools,
      disposeTools: async (tools) => {
        expect(tools).toBe(builtTools);
        lifecycle.push("dispose");
      },
      synchronizeSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
          runtimeGeneration: "runtime_generation_01",
          executionFence: {
            executionId: "event_user_01",
            attemptId: "attempt_01",
            ownerId: "worker_01",
            generation: 1,
          },
        });
        lifecycle.push("synchronize");
      },
      afterExecution: withReportedArtifactPublication(async input => {
        expect(input.executionFence.executionId).toBe("event_user_01");
        expect(lifecycle.at(-1)).toBe("idle");
        lifecycle.push("afterExecution");
        throw new Error("Output copy failed after completion");
      }, (error, input) => {
        expect(error).toMatchObject({ message: "Output copy failed after completion" });
        expect(input.session.id).toBe(session.id);
        lifecycle.push("publicationReported");
      }),
      buildHarness: () => ({
        run: async (context) => {
          lifecycle.push("run");
          const runtime = (context as {
            runtime: { broadcast(event: SessionEvent): void };
          }).runtime;
          runtime.broadcast({
            type: "agent.message",
            content: [{ type: "text", text: "Hello" }],
          } as SessionEvent);
        },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => `event_runtime_0${++nextId}` },
      runtimeGenerations: { next: () => "runtime_generation_01" },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_01",
      type: "user.message",
      content: [{ type: "text", text: "Continue" }],
      processedAt: "2026-08-26T01:00:00.000Z",
    };
    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        workspaceId: "workspace_01",
        sessionId: session.id,
        executionId: "event_user_01",
        attemptId: "attempt_01",
        ownerId: "worker_01",
        generation: 1,
        expiresAt: "2026-08-26T02:01:00.000Z",
      },
      output: async (frame) => {
        output.push(frame);
        if ((frame as { type?: string }).type === "session.status_idle") {
          lifecycle.push("idle");
        }
      },
    });

    expect(contexts).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        session,
        environment,
        acceptedEvents: [event],
        sandbox,
        model: { type: "model" },
        tools: { bash: { type: "tool" } },
        runtime: expect.any(Object),
      }),
    ]);
    expect(output).toEqual([
      {
        id: "event_runtime_01",
        type: "session.status_running",
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        id: "event_runtime_02",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        id: "event_runtime_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T02:00:00.000Z",
      },
    ]);
    expect(lifecycle).toEqual(["run", "dispose", "synchronize", "idle", "afterExecution", "publicationReported"]);
  });

  it("projects a terminal session error before returning a harness failure", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async () => { throw new Error("model unavailable"); },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
      ids: { nextEventId: () => `event_error_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_02",
      type: "user.message",
      content: [{ type: "text", text: "Retry" }],
      processedAt: "2026-08-26T02:30:00.000Z",
    };

    await expect(
      runner.accept({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        initialEvents: [],
        events: [event],
        historyEvents: [event],
        output: async (frame) => { output.push(frame); },
      }),
    ).rejects.toThrow("model unavailable");

    expect(output).toEqual([
      {
        id: "event_error_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:00:00.000Z",
      },
      {
        id: "event_error_02",
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "model unavailable",
          retry_status: "terminal",
        },
        processed_at: "2026-08-26T03:00:00.000Z",
      },
      {
        id: "event_error_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:00:00.000Z",
      },
    ]);
  });

  it("projects a terminal error and idle state when fenced final collection fails", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      synchronizeSandbox: async () => { throw new Error("final collect failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:15:00.000Z") },
      ids: { nextEventId: () => `event_collect_failure_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_collect_failure",
      type: "user.message",
      content: [{ type: "text", text: "Collect" }],
      processedAt: "2026-08-26T03:14:00.000Z",
    };

    await expect(runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        executionId: "execution_collect_failure",
        workspaceId: "workspace_01",
        sessionId: session.id,
        attemptId: "attempt_collect_failure",
        ownerId: "node_01",
        generation: 1,
        expiresAt: "2026-08-26T03:16:00.000Z",
      },
      output: async (frame) => { output.push(frame); },
    })).rejects.toThrow("final collect failed");

    expect(output).toEqual([
      {
        id: "event_collect_failure_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:15:00.000Z",
      },
      {
        id: "event_collect_failure_02",
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "final collect failed",
          retry_status: "terminal",
        },
        processed_at: "2026-08-26T03:15:00.000Z",
      },
      {
        id: "event_collect_failure_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:15:00.000Z",
      },
    ]);
  });

  it.each([
    {
      type: "user.custom_tool_result" as const,
      customToolUseId: "event_custom_tool_01",
    },
    {
      type: "user.tool_result" as const,
      toolUseId: "event_custom_tool_01",
    },
  ])("resumes one turn for $type", async (result) => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const contexts: Array<{ acceptedEvents: unknown[] }> = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async () => { runs += 1; },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T03:30:00.000Z") },
      ids: { nextEventId: () => `event_resume_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_result_01",
      ...result,
      content: [{ type: "text", text: "Sunny" }],
      isError: false,
      processedAt: "2026-08-26T03:15:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [event],
      initialEvents: [],
      historyEvents: [
        {
          id: "event_custom_tool_01",
          type: "agent.custom_tool_use",
          name: "weather",
          input: { city: "Shanghai" },
          processedAt: "2026-08-26T03:00:00.000Z",
        },
        event,
      ],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(contexts).toEqual([
      expect.objectContaining({ acceptedEvents: [event] }),
    ]);
    expect(output).toEqual([
      {
        id: "event_resume_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:30:00.000Z",
      },
      {
        id: "event_resume_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:30:00.000Z",
      },
    ]);
  });

  it.each([
    {
      result: "allow" as const,
      expectedContent: [{ type: "text" as const, text: "command completed" }],
      expectedIsError: false,
      expectedExecutions: 1,
    },
    {
      result: "deny" as const,
      denyMessage: "Do not run destructive commands",
      expectedContent: [{
        type: "text" as const,
        text: "Denied: Do not run destructive commands",
      }],
      expectedIsError: true,
      expectedExecutions: 0,
    },
  ])("handles a $result tool confirmation before resuming", async (verdict) => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    const executions: object[] = [];
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: {
        execute: async (input) => {
          executions.push(input);
          return {
            content: [{ type: "text", text: "command completed" }],
            isError: false,
          };
        },
      },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:45:00.000Z") },
      ids: { nextEventId: () => `event_confirmation_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const toolUse: Extract<
      SessionEventView,
      { type: "agent.tool_use" }
    > = {
      id: "event_tool_use_01",
      type: "agent.tool_use",
      name: "bash",
      input: { command: "pwd" },
      evaluatedPermission: "ask",
      processedAt: "2026-08-26T03:35:00.000Z",
    };
    const confirmation: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_confirmation_01",
      type: "user.tool_confirmation",
      result: verdict.result,
      toolUseId: toolUse.id,
      ...(verdict.denyMessage !== undefined && {
        denyMessage: verdict.denyMessage,
      }),
      processedAt: "2026-08-26T03:40:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [confirmation],
      initialEvents: [],
      historyEvents: [toolUse, confirmation],
      output: async (frame) => { output.push(frame); },
    });

    expect(executions).toHaveLength(verdict.expectedExecutions);
    if (verdict.result === "allow") {
      expect(executions[0]).toEqual({
        workspaceId: "workspace_01",
        session,
        environment,
        sandbox,
        confirmation,
        toolUse,
        abortSignal: expect.any(AbortSignal),
      });
    }
    expect(runs).toBe(1);
    expect(output).toEqual([
      {
        id: "event_confirmation_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:45:00.000Z",
      },
      {
        id: "event_confirmation_02",
        type: "agent.tool_result",
        tool_use_id: toolUse.id,
        content: verdict.expectedContent,
        is_error: verdict.expectedIsError,
        processed_at: "2026-08-26T03:45:00.000Z",
      },
      {
        id: "event_confirmation_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:45:00.000Z",
      },
    ]);
  });

  it("runs and evaluates a defined outcome through official spans", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const evaluations: object[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          evaluations.push(input);
          return {
            result: "satisfied",
            explanation: "All contract checks pass",
            usage: {
              cacheCreationInputTokens: 1,
              cacheReadInputTokens: 2,
              inputTokens: 30,
              outputTokens: 4,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T05:30:00.000Z") },
      ids: { nextEventId: () => `event_outcome_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_01",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 3,
      outcomeId: "outc_01",
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(evaluations).toEqual([{
      workspaceId: "workspace_01",
      session,
      environment,
      outcome,
      historyEvents: [
        outcome,
        {
          id: "event_outcome_01",
          type: "session.status_running",
          processedAt: "2026-08-26T05:30:00.000Z",
        },
      ],
      iteration: 0,
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(output).toEqual([
      {
        id: "event_outcome_01",
        type: "session.status_running",
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_02",
        type: "span.outcome_evaluation_start",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_03",
        type: "span.outcome_evaluation_ongoing",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_04",
        type: "span.outcome_evaluation_end",
        explanation: "All contract checks pass",
        iteration: 0,
        outcome_evaluation_start_id: "event_outcome_02",
        outcome_id: "outc_01",
        result: "satisfied",
        usage: {
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
          input_tokens: 30,
          output_tokens: 4,
        },
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_05",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T05:30:00.000Z",
      },
    ]);
  });

  it("revises an outcome until max_iterations_reached", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const iterations: number[] = [];
    const contexts: unknown[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          iterations.push(input.iteration);
          return {
            result: "needs_revision",
            explanation: `revision ${input.iteration} required`,
            usage: {
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              inputTokens: 1,
              outputTokens: 1,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          contexts.push(context);
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T06:00:00.000Z") },
      ids: { nextEventId: () => `event_revision_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_02",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 2,
      outcomeId: "outc_02",
      processedAt: "2026-08-26T05:45:00.000Z",
    };
    const output: Array<{ type?: string; result?: string }> = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => {
        output.push(frame as { type?: string; result?: string });
      },
    });

    expect(runs).toBe(2);
    expect(iterations).toEqual([0, 1]);
    expect(output
      .filter((event) => event.type === "span.outcome_evaluation_end")
      .map((event) => event.result)).toEqual([
        "needs_revision",
        "max_iterations_reached",
      ]);
    const revisionContext = contexts[1] as {
      runtime: { history: { getMessages(): Array<{ role: string; content: unknown }> } };
    };
    expect(revisionContext.runtime.history.getMessages().at(-1)).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: [
          '<outcome_feedback iteration="0">',
          "revision 0 required",
          "",
          "Address the feedback and try again.",
          "</outcome_feedback>",
        ].join("\n"),
      }],
    });
  });

  it("interrupts the active turn without starting another harness run", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          const signal = (context as {
            runtime: { abortSignal?: AbortSignal };
          }).runtime.abortSignal;
          markStarted?.();
          if (signal === undefined) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => `event_interrupt_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_03",
      type: "user.message",
      content: [{ type: "text", text: "Long task" }],
      processedAt: "2026-08-26T03:30:00.000Z",
    };
    const turn = runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [message],
      historyEvents: [message],
      output: async (frame) => { output.push(frame); },
    });
    await started;
    const interrupt: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_interrupt_input_01",
      type: "user.interrupt",
      processedAt: "2026-08-26T03:31:00.000Z",
    };

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [interrupt],
      historyEvents: [message, interrupt],
      output: async (frame) => { output.push(frame); },
    });
    await turn;

    expect(runs).toBe(1);
    expect(aborted).toBe(true);
    expect(output).toEqual([
      {
        id: "event_interrupt_01",
        type: "session.status_running",
        processed_at: "2026-08-26T04:00:00.000Z",
      },
      {
        id: "event_interrupt_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T04:00:00.000Z",
      },
    ]);
  });

  it("owns and destroys sandboxes by workspace and session scope", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const built: string[] = [];
    const destroyed: string[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async ({ workspaceId }) => {
        built.push(workspaceId);
        return {
          destroy: async () => { destroyed.push(workspaceId); },
        } as SandboxExecutor;
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_scope" },
    });
    const start = (workspaceId: string) => runner.start({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await start("workspace_a");
    await start("workspace_b");
    expect(built).toEqual(["workspace_a", "workspace_b"]);

    await runner.stop({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a"]);
    await runner.stop({
      workspaceId: "workspace_b",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a", "workspace_b"]);
  });
});
