import {
  withSandboxExecutionGuard,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import { randomUUID } from "node:crypto";
import type {
  HarnessContext,
  HarnessInterface,
} from "@open-managed-agents/agent/harness/interface";
import type {
  Environment,
  Session,
  SessionEventView,
  SpanModelUsageView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import type {
  NodeManagedSessionRunner,
  NodeManagedSessionRunnerAcceptInput,
  StartNodeManagedSessionRuntime,
  StopNodeManagedSessionRuntime,
  ArchiveNodeManagedSessionThread,
} from "./node-managed-session-runtime.js";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { ManagedNodeHarnessRuntime } from "./node-managed-harness-runtime.js";
import { ScopedSessionMap } from "./scoped-session-map.js";
import {
  ManagedNodeSubagents,
  managedEventThread,
  type ManagedNodeCreateSubagent,
  type ManagedNodeSubagentControl,
  type ManagedNodeSubagentPolicy,
  type ManagedNodeSubagentThreads,
} from "./node-managed-subagents.js";

export type { ManagedNodeSubagentControl } from "./node-managed-subagents.js";

interface ManagedRunnerSubagentContext {
  subagents?: ManagedNodeSubagentControl;
  delegateToAgent?: (agentId: string, message: string) => Promise<string>;
}

interface ManagedRunnerContext {
  workspaceId: string;
  session: Session;
  environment: Environment;
}

export type ManagedNodeToolConfirmation = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.tool_confirmation" }
>;

export type ManagedNodeConfirmableToolUse = Extract<
  SessionEventView,
  { type: "agent.tool_use" | "agent.mcp_tool_use" }
>;

export interface ExecuteManagedNodeConfirmedTool {
  workspaceId: string;
  session: Session;
  environment: Environment;
  sandbox: SandboxExecutor;
  confirmation: ManagedNodeToolConfirmation;
  toolUse: ManagedNodeConfirmableToolUse;
  abortSignal: AbortSignal;
}

export interface ManagedNodeConfirmedToolExecutionResult {
  content?: ToolResultContentBlock[];
  isError?: boolean | null;
}

export interface ManagedNodeConfirmedToolExecutionPort {
  execute(
    input: ExecuteManagedNodeConfirmedTool,
  ): Promise<ManagedNodeConfirmedToolExecutionResult>;
}

export type ManagedNodeDefinedOutcome = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.define_outcome" }
>;

export interface EvaluateManagedNodeOutcome {
  workspaceId: string;
  session: Session;
  environment: Environment;
  outcome: ManagedNodeDefinedOutcome;
  historyEvents: SessionEventView[];
  iteration: number;
  abortSignal: AbortSignal;
}

export interface ManagedNodeOutcomeEvaluationResult {
  result: "satisfied" | "needs_revision" | "failed";
  explanation: string;
  usage: SpanModelUsageView;
}

export interface ManagedNodeOutcomeEvaluationPort {
  evaluate(
    input: EvaluateManagedNodeOutcome,
  ): Promise<ManagedNodeOutcomeEvaluationResult>;
}

export interface DefaultNodeManagedSessionRunnerDependencies {
  subagentThreads?: ManagedNodeSubagentThreads;
  subagentPolicy?(input: ManagedRunnerContext): ManagedNodeSubagentPolicy | Promise<ManagedNodeSubagentPolicy>;
  resolveSubagentSession?(input: ManagedRunnerContext & { request: ManagedNodeCreateSubagent }): Promise<Session>;
  confirmedTools: ManagedNodeConfirmedToolExecutionPort;
  outcomes: ManagedNodeOutcomeEvaluationPort;
  buildSandbox(input: ManagedRunnerContext): Promise<SandboxExecutor>;
  prepareSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
  }): Promise<void>;
  /** Runs after all terminal facts have committed, while the execution still
   * owns its existing fence. Suitable for immutable output publication. */
  afterExecution?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  buildModel(input: ManagedRunnerContext): Promise<HarnessContext["model"]>;
  buildTools(
    input: ManagedRunnerContext & ManagedRunnerSubagentContext & { sandbox: SandboxExecutor },
  ): Promise<HarnessContext["tools"]>;
  disposeTools?(tools: HarnessContext["tools"]): Promise<void>;
  buildHarness(): HarnessInterface;
  buildHarnessContext(input: ManagedRunnerContext & ManagedRunnerSubagentContext & {
    acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
    sandbox: SandboxExecutor;
    runtime: ManagedNodeHarnessRuntime;
    model: HarnessContext["model"];
    tools: HarnessContext["tools"];
  }): Promise<HarnessContext>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
  runtimeGenerations?: { next(): string };
}

export class DefaultNodeManagedSessionRunner
  implements NodeManagedSessionRunner
{
  private readonly sandboxes = new ScopedSessionMap<SandboxExecutor>();
  private readonly runtimeGenerations = new ScopedSessionMap<string>();
  private readonly sandboxConfigurationFingerprints = new ScopedSessionMap<string>();
  private readonly abortControllers = new ScopedSessionMap<AbortController>();
  private readonly subagentExecutions = new ScopedSessionMap<ManagedNodeSubagents>();

  constructor(
    private readonly dependencies: DefaultNodeManagedSessionRunnerDependencies,
  ) {}

  cancel(input: { workspaceId: string; sessionId: string }): void {
    this.abortControllers.get(input)?.abort();
  }

  /** Returns only a prepared live runtime, scoped exactly like execution. */
  connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null {
    return this.sandboxes.get(input) ?? null;
  }

  async start(input: StartNodeManagedSessionRuntime): Promise<void> {
    const fingerprint = JSON.stringify({
      resources: input.session.resources,
      skills: input.session.agent.skills,
      environment: input.environment.config,
    });
    const existing = this.sandboxes.get(input);
    if (
      existing !== undefined &&
      this.sandboxConfigurationFingerprints.get(input) === fingerprint
    ) return;
    if (existing !== undefined) {
      this.abortControllers.get(input)?.abort();
      this.abortControllers.delete(input);
      this.sandboxes.delete(input);
      this.runtimeGenerations.delete(input);
      this.sandboxConfigurationFingerprints.delete(input);
      await existing.destroy?.();
    }
    const sandbox = await this.dependencies.buildSandbox({
      workspaceId: input.workspaceId,
      session: input.session,
      environment: input.environment,
    });
    const runtimeGeneration = this.dependencies.runtimeGenerations?.next()
      ?? `runtime_${randomUUID()}`;
    try {
      await this.dependencies.prepareSandbox?.({
        workspaceId: input.workspaceId,
        session: input.session,
        environment: input.environment,
        sandbox,
        runtimeGeneration,
      });
    } catch (error) {
      await sandbox.destroy?.().catch(() => undefined);
      throw error;
    }
    this.sandboxes.set(input, sandbox);
    this.runtimeGenerations.set(input, runtimeGeneration);
    this.sandboxConfigurationFingerprints.set(input, fingerprint);
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    this.abortControllers.get(input)?.abort();
    this.abortControllers.delete(input);
    const sandbox = this.sandboxes.get(input);
    this.sandboxes.delete(input);
    this.runtimeGenerations.delete(input);
    this.sandboxConfigurationFingerprints.delete(input);
    await sandbox?.destroy?.();
  }

  async accept(input: NodeManagedSessionRunnerAcceptInput): Promise<void> {
    if (input.events.some((event) => event.type === "user.interrupt")) {
      this.abortControllers.get(input)?.abort();
      return;
    }
    const event = input.events.findLast(
      (candidate) => candidate.type !== "system.message",
    );
    if (event === undefined) {
      throw new Error("Managed Node runner received no actionable event");
    }
    if (
      event.type !== "user.message" &&
      event.type !== "user.custom_tool_result" &&
      event.type !== "user.tool_result" &&
      event.type !== "user.tool_confirmation" &&
      event.type !== "user.define_outcome"
    ) {
      throw new Error(
        `Managed Node runner does not yet support ${event.type}`,
      );
    }
    const rawSandbox = this.sandboxes.get(input);
    if (rawSandbox === undefined) {
      throw new Error(`Session ${input.sessionId} sandbox was not started`);
    }
    const runtimeGeneration = this.runtimeGenerations.get(input);
    if (runtimeGeneration === undefined) {
      throw new Error(`Session ${input.sessionId} runtime generation was not started`);
    }
    const abortController = new AbortController();
    this.abortControllers.set(input, abortController);
    // The Node execution worker owns the durable fence and cancels this
    // controller when renewal fails. The guard keeps provider calls from a
    // stale runner from continuing after that cancellation; canonical frame
    // writes are fenced separately by DefaultNodeManagedSessionRuntimeDriver.
    const sandbox = input.executionFence === undefined
      ? rawSandbox
      : withSandboxExecutionGuard(rawSandbox, {
          signal: abortController.signal,
        });
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: input.initialEvents,
      events: input.historyEvents.filter((event) => managedEventThread(event) === "sthr_primary"),
      sandbox,
      abortSignal: abortController.signal,
      output: input.output,
      clock: this.dependencies.clock,
      ids: this.dependencies.ids,
    });
    runtime.broadcastProducedEvent({ type: "session.status_running" });
    let turnTools: HarnessContext["tools"] | undefined;
    let runFailed = false;
    try {
      if (event.type === "user.tool_confirmation") {
        const toolUse = input.historyEvents.findLast(
          (candidate): candidate is ManagedNodeConfirmableToolUse =>
            (candidate.type === "agent.tool_use" ||
              candidate.type === "agent.mcp_tool_use") &&
            candidate.id === event.toolUseId,
        );
        if (toolUse === undefined) {
          throw new Error(
            `Tool use ${event.toolUseId} was not found in session history`,
          );
        }
        const result = event.result === "deny"
          ? {
              content: [{
                type: "text" as const,
                text: `Denied: ${event.denyMessage ?? "Tool execution was denied by the user."}`,
              }],
              isError: true,
            }
          : await this.dependencies.confirmedTools.execute({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox,
              confirmation: event,
              toolUse,
              abortSignal: abortController.signal,
            });
        runtime.broadcastProducedEvent(
          toolUse.type === "agent.mcp_tool_use"
            ? {
                type: "agent.mcp_tool_result",
                mcpToolUseId: toolUse.id,
                ...result,
              }
            : {
                type: "agent.tool_result",
                toolUseId: toolUse.id,
                ...result,
              },
        );
      }
      const context = {
        workspaceId: input.workspaceId,
        session: input.session,
        environment: input.environment,
      };
      const policy = await this.dependencies.subagentPolicy?.(context);
      let subagentContext: ManagedRunnerSubagentContext = {};
      if (policy?.enabled && this.dependencies.subagentThreads !== undefined) {
        const subagents = new ManagedNodeSubagents({
          ...context,
          parentThreadId: "sthr_primary",
          sandbox,
          abortSignal: abortController.signal,
          executionFence: input.executionFence,
          historyEvents: input.historyEvents,
          threads: this.dependencies.subagentThreads,
          policy,
          resolveSession: this.dependencies.resolveSubagentSession === undefined ? undefined :
            (request) => this.dependencies.resolveSubagentSession!({ ...context, request }),
          run: async ({ session, runtime: childRuntime, sandbox: childSandbox }) => {
            const childContext = { ...context, session };
            let childTools: HarnessContext["tools"] | undefined;
            try {
              const model = await this.dependencies.buildModel(childContext);
              childTools = await this.dependencies.buildTools({ ...childContext, sandbox: childSandbox });
              const harnessContext = await this.dependencies.buildHarnessContext({
                ...childContext, acceptedEvents: [], sandbox: childSandbox,
                runtime: childRuntime, model, tools: childTools,
              });
              await this.dependencies.buildHarness().run(harnessContext);
            } finally {
              if (childTools !== undefined) await this.dependencies.disposeTools?.(childTools);
            }
          },
          output: input.output,
          clock: this.dependencies.clock,
          ids: this.dependencies.ids,
        });
        this.subagentExecutions.set(input, subagents);
        subagentContext = {
          subagents,
          delegateToAgent: async (agentId, message) => {
            const child = await subagents.create({ agentId, message });
            const result = (await subagents.wait({ threadIds: [child.threadId] })).subagents[0]!;
            if (result.status === "failed") throw new Error(`Subagent ${child.threadId} failed`);
            return result.output ?? "(sub-agent produced no text output)";
          },
        };
      }
      const toolsPromise = this.dependencies
        .buildTools({ ...context, ...subagentContext, sandbox })
        .then((tools) => {
          turnTools = tools;
          return tools;
        });
      const [model, tools] = await Promise.all([
        this.dependencies.buildModel(context),
        toolsPromise,
      ]);
      const runHarness = async (): Promise<void> => {
        const harnessContext = await this.dependencies.buildHarnessContext({
          ...context,
          ...subagentContext,
          acceptedEvents: input.events,
          sandbox,
          runtime,
          model,
          tools,
        });
        await this.dependencies.buildHarness().run(harnessContext);
      };
      await runHarness();
      if (event.type === "user.define_outcome") {
        const maxIterations = Math.min(
          20,
          Math.max(1, event.maxIterations ?? 3),
        );
        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
          const evaluationHistory = runtime.getApplicationHistoryEvents();
          const startId = runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_start",
            outcomeId: event.outcomeId,
            iteration,
          });
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_ongoing",
            outcomeId: event.outcomeId,
            iteration,
          });
          let evaluation: ManagedNodeOutcomeEvaluationResult;
          try {
            evaluation = await this.dependencies.outcomes.evaluate({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              outcome: event,
              historyEvents: evaluationHistory,
              iteration,
              abortSignal: abortController.signal,
            });
          } catch (error) {
            const interrupted = abortController.signal.aborted ||
              (error instanceof Error && error.name === "AbortError");
            evaluation = {
              result: "failed",
              explanation: interrupted
                ? "outcome evaluation interrupted by user"
                : `outcome evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
              usage: {
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            };
            runtime.broadcastProducedEvent({
              type: "span.outcome_evaluation_end",
              outcomeId: event.outcomeId,
              outcomeEvaluationStartId: startId,
              iteration,
              result: interrupted ? "interrupted" : "failed",
              explanation: evaluation.explanation,
              usage: evaluation.usage,
            });
            break;
          }
          const needsRevision = evaluation.result === "needs_revision";
          const result = needsRevision && iteration === maxIterations - 1
            ? "max_iterations_reached"
            : evaluation.result;
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_end",
            outcomeId: event.outcomeId,
            outcomeEvaluationStartId: startId,
            iteration,
            result,
            explanation: evaluation.explanation,
            usage: evaluation.usage,
          });
          if (!needsRevision || result === "max_iterations_reached") break;
          runtime.appendOutcomeFeedback(iteration, evaluation.explanation);
          await runHarness();
        }
      }
    } catch (error) {
      runFailed = true;
      runtime.broadcastProducedEvent({
        type: "session.error",
        error: {
          type: "unknown_error",
          message: error instanceof Error ? error.message : String(error),
          retryStatus: "terminal",
        },
      });
      throw error;
    } finally {
      let finalizationError: Error | undefined;
      const subagents = this.subagentExecutions.get(input);
      try {
        if (runFailed) abortController.abort();
        await subagents?.drain();
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (this.subagentExecutions.get(input) === subagents) this.subagentExecutions.delete(input);
      }
      try {
        if (turnTools !== undefined) {
          await this.dependencies.disposeTools?.(turnTools);
        }
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      }
      if (finalizationError !== undefined && !runFailed) {
        runtime.broadcastProducedEvent({
          type: "session.error",
          error: {
            type: "unknown_error",
            message: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
            retryStatus: "terminal",
          },
        });
      }
      runtime.broadcastProducedEvent({
        type: "session.status_idle",
        stopReason: { type: "end_turn" },
      });
      try {
        await runtime.drain();
        if (input.executionFence !== undefined) {
          await this.dependencies.afterExecution?.({
            workspaceId: input.workspaceId,
            session: input.session,
            environment: input.environment,
            sandbox: rawSandbox,
            runtimeGeneration,
            executionFence: input.executionFence,
          });
        }
      } finally {
        if (this.abortControllers.get(input) === abortController) {
          this.abortControllers.delete(input);
        }
      }
      if (finalizationError !== undefined && !runFailed) {
        throw finalizationError;
      }
    }
  }

  async archiveThread(
    input: ArchiveNodeManagedSessionThread,
  ): Promise<void> {
    await this.subagentExecutions.get(input)?.archiveThread(input.threadId);
  }
}
