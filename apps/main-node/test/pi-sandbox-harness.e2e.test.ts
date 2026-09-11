import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { PiHarness } from "@open-managed-agents/agent/harness/pi-loop";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";
import type {
  Environment,
  Session,
  SessionEventView,
} from "@open-managed-agents/managed-agents-application";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { DefaultNodeManagedSessionRunner } from "../src/lib/node-managed-session-runner";

describe(
  "PiHarness over SandboxPort",
  () => {
    it("executes a real local sandbox tool while only the LLM provider is mocked", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "oma-pi-harness-"));
      const sandbox = new LocalSubprocessSandbox({ workdir });

      try {
        const agent: AgentConfig = {
          id: "agent_pi_sandbox",
          name: "Pi sandbox agent",
          model: "faux-model",
          system: "Use the provided write tool.",
          tools: [
            {
              type: "agent_toolset_20260401",
              default_config: { enabled: false },
              configs: [{ name: "write", enabled: true }],
            },
          ],
          harness: "pi",
          version: 1,
          created_at: "2026-08-30T00:00:00.000Z",
        };
        const userMessage = {
          type: "user.message",
          content: [{ type: "text", text: "Write the sandbox marker." }],
        } as UserMessageEvent;
        const events: SessionEvent[] = [userMessage];

        const faux = fauxProvider({ tokensPerSecond: 100_000 });
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              "write",
              {
                file_path: "/workspace/openma-pi-harness.txt",
                content: "pi-harness-sandbox-port-ok",
              },
              { id: "tool-write-sandbox" },
            ),
            { stopReason: "toolUse", responseId: "response-write" },
          ),
          fauxAssistantMessage("Sandbox marker written.", {
            responseId: "response-final",
          }),
        ]);
        const models = createModels();
        models.setProvider(faux.provider);

        const runtime = {
          history: {
            getEvents: () => events,
            getMessages: () => [],
            append: (event: SessionEvent) => events.push(event),
          },
          sandbox,
          broadcast: (event: SessionEvent) => events.push(event),
          broadcastStreamStart: vi.fn(async () => {}),
          broadcastChunk: vi.fn(async () => {}),
          broadcastStreamEnd: vi.fn(async () => {}),
          broadcastThinkingStart: vi.fn(async () => {}),
          broadcastThinkingChunk: vi.fn(async () => {}),
          broadcastThinkingEnd: vi.fn(async () => {}),
          broadcastToolInputStart: vi.fn(async () => {}),
          broadcastToolInputChunk: vi.fn(async () => {}),
          broadcastToolInputEnd: vi.fn(async () => {}),
          reportUsage: vi.fn(async () => {}),
          pendingConfirmations: [],
        } as unknown as HarnessRuntime;

        const tools = await buildTools(agent, sandbox);
        const context = {
          agent,
          userMessage,
          session_id: "session_pi_sandbox",
          tools,
          model: {} as HarnessContext["model"],
          pi: { models, model: faux.getModel() },
          systemPrompt: agent.system,
          env: { ANTHROPIC_API_KEY: "mocked-by-faux-provider" },
          runtime,
        } satisfies HarnessContext;

        registerCoreHarnesses();
        await resolveHarness("pi").run(context);

        expect(await sandbox.readFile("/workspace/openma-pi-harness.txt")).toBe(
          "pi-harness-sandbox-port-ok",
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_use",
            id: "tool-write-sandbox",
            name: "write",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.tool_result",
            tool_use_id: "tool-write-sandbox",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "agent.message",
            content: [{ type: "text", text: "Sandbox marker written." }],
          }),
        );
      } finally {
        await sandbox.destroy();
      }
    });

    it("preserves a threshold-triggered Pi summary across managed runtime turns", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "oma-pi-compaction-"));
      const sandbox = new LocalSubprocessSandbox({ workdir });
      const faux = fauxProvider({ tokensPerSecond: 100_000 });
      const models = createModels();
      models.setProvider(faux.provider);
      const model = { ...faux.getModel(), contextWindow: 10_000 };
      const requests: Array<{ systemPrompt?: string; messages: unknown[]; tools?: unknown[] }> = [];
      faux.setResponses([
        (context) => {
          requests.push({
            systemPrompt: context.systemPrompt,
            messages: structuredClone(context.messages),
            tools: structuredClone(context.tools),
          });
          return fauxAssistantMessage("The user requires durable Pi compaction across managed turns.");
        },
        (context) => {
          requests.push({
            systemPrompt: context.systemPrompt,
            messages: structuredClone(context.messages),
            tools: structuredClone(context.tools),
          });
          return fauxAssistantMessage("First answer after compaction.");
        },
        (context) => {
          requests.push({
            systemPrompt: context.systemPrompt,
            messages: structuredClone(context.messages),
            tools: structuredClone(context.tools),
          });
          return fauxAssistantMessage("Second answer retained the summary.");
        },
      ]);

      const session = managedSessionFixture();
      const environment = managedEnvironmentFixture();
      const runner = createManagedPiRunner({
        sandbox,
        session,
        pi: { models, model },
        triggerFraction: (contextBuild) => contextBuild === 1 ? 0.01 : 0.95,
        eventPrefix: "event_pi_compaction",
      });

      const firstUser = userEvent("event_user_current", "What remains to ship?");
      const firstHistory: SessionEventView[] = [
        userEvent("event_user_old_1", "A".repeat(1_200)),
        assistantEvent("event_agent_old_1", "B".repeat(1_200)),
        userEvent("event_user_old_2", "C".repeat(1_200)),
        assistantEvent("event_agent_old_2", "D".repeat(1_200)),
        firstUser,
      ];
      const firstOutput: unknown[] = [];

      try {
        await runner.start({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
          initialEvents: [],
        });
        await runner.accept({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
          events: [firstUser],
          initialEvents: [],
          historyEvents: firstHistory,
          output: async (frame) => { firstOutput.push(structuredClone(frame)); },
        });

        const boundaryIndex = firstOutput.findIndex(
          (event) => (event as { type?: string }).type === "agent.thread_context_compacted",
        );
        const answerIndex = firstOutput.findIndex(
          (event) => (event as { type?: string }).type === "agent.message",
        );
        expect(boundaryIndex).toBeGreaterThan(-1);
        expect(boundaryIndex).toBeLessThan(answerIndex);
        expect(firstOutput[boundaryIndex]).toMatchObject({
          type: "agent.thread_context_compacted",
          trigger: "auto",
          summary: [{
            type: "text",
            text: "The user requires durable Pi compaction across managed turns.",
          }],
        });
        expect(requests[0]).toMatchObject({
          tools: [],
          systemPrompt: "You are a helpful AI assistant tasked with summarizing conversations.",
        });
        expect(JSON.stringify(requests[1]?.messages)).toContain("<conversation-summary>");

        const persistedFirstOutput = firstOutput.flatMap((frame) => {
          const event = decodeRuntimeProducedSessionEvent(frame);
          return event === null ? [] : [event];
        });
        const secondUser = userEvent("event_user_second", "Continue from that state.");
        const secondOutput: unknown[] = [];
        await runner.accept({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
          events: [secondUser],
          initialEvents: [],
          historyEvents: [...firstHistory, ...persistedFirstOutput, secondUser],
          output: async (frame) => { secondOutput.push(structuredClone(frame)); },
        });

        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[2]?.messages)).toContain(
          "The user requires durable Pi compaction across managed turns.",
        );
        expect(secondOutput).toContainEqual(expect.objectContaining({
          type: "agent.message",
          content: [{ type: "text", text: "Second answer retained the summary." }],
        }));
      } finally {
        await runner.stop({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
        });
      }
    });

    it("compacts and retries once when a managed Pi turn overflows", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "oma-pi-overflow-"));
      const sandbox = new LocalSubprocessSandbox({ workdir });
      const faux = fauxProvider({ tokensPerSecond: 100_000 });
      const models = createModels();
      models.setProvider(faux.provider);
      const model = { ...faux.getModel(), contextWindow: 10_000 };
      const requests: string[] = [];
      faux.setResponses([
        (context) => {
          requests.push(JSON.stringify(context.messages));
          return fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
          });
        },
        (context) => {
          requests.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Overflow recovery summary.");
        },
        (context) => {
          requests.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Recovered after one compact-and-retry.");
        },
      ]);

      const session = managedSessionFixture();
      const environment = managedEnvironmentFixture();
      const runner = createManagedPiRunner({
        sandbox,
        session,
        pi: { models, model },
        // Keep proactive compaction off: this case must enter through Pi's
        // overflow classification and forced recovery branch.
        triggerFraction: () => 0.95,
        eventPrefix: "event_pi_overflow",
      });
      const currentUser = userEvent("event_user_overflow", "Please continue.");
      const history: SessionEventView[] = [
        userEvent("event_user_overflow_old_1", "old question one"),
        assistantEvent("event_agent_overflow_old_1", "old answer one"),
        userEvent("event_user_overflow_old_2", "old question two"),
        assistantEvent("event_agent_overflow_old_2", "old answer two"),
        currentUser,
      ];
      const output: unknown[] = [];

      try {
        await runner.start({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
          initialEvents: [],
        });
        await runner.accept({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
          events: [currentUser],
          initialEvents: [],
          historyEvents: history,
          output: async (frame) => { output.push(structuredClone(frame)); },
        });

        expect(requests).toHaveLength(3);
        expect(requests[0]).not.toContain("<conversation-summary>");
        expect(requests[2]).toContain("Overflow recovery summary.");
        expect(output.filter(
          (event) => (event as { type?: string }).type === "agent.thread_context_compacted",
        )).toHaveLength(1);
        expect(output).toContainEqual(expect.objectContaining({
          type: "agent.message",
          content: [{
            type: "text",
            text: "Recovered after one compact-and-retry.",
          }],
        }));
        expect(output.some(
          (event) => (event as { type?: string }).type === "session.error",
        )).toBe(false);
      } finally {
        await runner.stop({
          workspaceId: "workspace_pi",
          sessionId: session.id,
          session,
          environment,
        });
      }
    });
  },
);

function createManagedPiRunner(input: {
  sandbox: LocalSubprocessSandbox;
  session: Session;
  pi: NonNullable<HarnessContext["pi"]>;
  triggerFraction(contextBuild: number): number;
  eventPrefix: string;
}): DefaultNodeManagedSessionRunner {
  let contextBuilds = 0;
  let nextEventId = 0;
  return new DefaultNodeManagedSessionRunner({
    buildSandbox: async () => input.sandbox,
    buildModel: async () => ({}) as HarnessContext["model"],
    buildTools: async () => ({}),
    buildHarness: () => new PiHarness(),
    buildHarnessContext: async (context) => {
      contextBuilds += 1;
      return {
        agent: {
          id: input.session.agent.id,
          name: input.session.agent.name,
          model: input.session.agent.model.id,
          system: input.session.agent.system ?? "",
          tools: [],
          harness: "pi",
          version: input.session.agent.version,
          created_at: input.session.createdAt,
          metadata: {
            compaction_trigger_fraction: input.triggerFraction(contextBuilds),
          },
        },
        userMessage: { type: "user.message", content: [] },
        session_id: input.session.id,
        tenant_id: "workspace_pi",
        tools: context.tools,
        model: context.model,
        pi: input.pi,
        systemPrompt: input.session.agent.system ?? "",
        env: { ANTHROPIC_API_KEY: "mocked-by-faux-provider" },
        runtime: context.runtime,
      } satisfies HarnessContext;
    },
    confirmedTools: {
      execute: async () => {
        throw new Error("unexpected confirmed tool execution");
      },
    },
    outcomes: {
      evaluate: async () => {
        throw new Error("unexpected outcome evaluation");
      },
    },
    clock: { now: () => new Date("2026-09-03T00:00:00.000Z") },
    ids: { nextEventId: () => `${input.eventPrefix}_${++nextEventId}` },
  });
}

function managedSessionFixture(): Session {
  return {
    id: "session_pi_compaction",
    agent: {
      id: "agent_pi_compaction",
      description: null,
      mcpServers: [],
      model: { id: "faux-model" },
      multiagent: null,
      name: "Pi compaction agent",
      skills: [],
      system: "Keep the managed session concise.",
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    environmentId: "environment_pi_local",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "running",
    title: "Compaction integration",
    updatedAt: "2026-09-03T00:00:00.000Z",
    usage: {},
    vaultIds: [],
  };
}

function managedEnvironmentFixture(): Environment {
  return {
    id: "environment_pi_local",
    archivedAt: null,
    config: { type: "self_hosted" },
    createdAt: "2026-09-03T00:00:00.000Z",
    description: "Local compaction runtime",
    metadata: {},
    name: "Local compaction runtime",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function userEvent(id: string, text: string): Extract<SessionEventView, { type: "user.message" }> {
  return {
    id,
    type: "user.message",
    content: [{ type: "text", text }],
    processedAt: "2026-09-03T00:00:00.000Z",
  };
}

function assistantEvent(
  id: string,
  text: string,
): Extract<SessionEventView, { type: "agent.message" }> {
  return {
    id,
    type: "agent.message",
    content: [{ type: "text", text }],
    processedAt: "2026-09-03T00:00:00.000Z",
  };
}
