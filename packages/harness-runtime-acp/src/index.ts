import type { AcpRuntime } from "@open-managed-agents/acp-runtime";
import type { HarnessSupervisorHarness } from "@open-managed-agents/harness-supervisor";
import {
  createManagedAgentsRuntime,
  type ManagedAgentsSessionSteerCommand,
  type ManagedAgentsSessionPreparationPort,
} from "@open-managed-agents/runtime";
import type {
  SessionCommand,
  SessionHostEvent,
  SessionStartCommand,
} from "@openma/common/session-kernel";

export * from "./semantic-recovery.js";
export * from "./managed-event-projector.js";
export * from "./http-control.js";

export type ManagedHarnessRecoveryReason =
  | "native-state-missing"
  | "native-state-stale";

/** Local supervisor extension. This never changes Anthropic's Session or
 * Environment Worker wire shapes; it carries the canonical completion fence
 * from the HTTP control adapter to the native-state adapter. */
export type ManagedHarnessSessionStartCommand = SessionStartCommand & {
  canonicalCompletedTurnId?: string;
};

export type ManagedHarnessControlMessage =
  | SessionCommand
  | ManagedAgentsSessionSteerCommand
  | ManagedHarnessSessionStartCommand
  | {
      type: "control.complete";
      workId: string;
    };

export interface ManagedHarnessRecoveryWarning {
  type: "session.warning";
  sessionId: string;
  source: "acp_semantic_recovery";
  message: string;
  details: { reason: ManagedHarnessRecoveryReason };
}

export type ManagedHarnessPublishedEvent =
  | SessionHostEvent
  | ManagedHarnessRecoveryWarning;

export interface ManagedHarnessControlChannel {
  commands(signal: AbortSignal): AsyncIterable<ManagedHarnessControlMessage>;
  publish(event: ManagedHarnessPublishedEvent): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedHarnessSessionStatePreparation {
  command: SessionStartCommand;
  semanticRecoveryReason?: ManagedHarnessRecoveryReason;
}

/** Durable state belongs to OpenMA. Implementations may copy a Harbor-derived
 * native-session allowlist, but publication and lifecycle are driven here. */
export interface ManagedHarnessSessionStatePort {
  beforeStart(
    command: ManagedHarnessSessionStartCommand,
  ): Promise<ManagedHarnessSessionStatePreparation>;
  onReady(event: Extract<SessionHostEvent, { type: "session.ready" }>): Promise<void>;
  checkpoint(input: { sessionId: string; turnId?: string }): Promise<void>;
  release(input: {
    sessionId: string;
    reason: "shutdown" | "destroy";
  }): Promise<void>;
}

export interface ManagedHarnessSemanticRecoveryPort {
  build(input: {
    sessionId: string;
    reason: ManagedHarnessRecoveryReason;
    currentPrompt: string;
  }): Promise<string>;
}

export interface ManagedAcpSupervisorHarnessOptions {
  connect(input: {
    scope: Parameters<HarnessSupervisorHarness["start"]>[0]["scope"];
    harness: Parameters<HarnessSupervisorHarness["start"]>[0]["harness"];
    workspacePath: string;
    outputPath: string | null;
    signal: AbortSignal;
  }): Promise<ManagedHarnessControlChannel>;
  acpRuntime: AcpRuntime;
  sessionPreparation: ManagedAgentsSessionPreparationPort;
  sessionState: ManagedHarnessSessionStatePort;
  semanticRecovery?: ManagedHarnessSemanticRecoveryPort;
  drainDeadlineMs?: number;
  drainPollIntervalMs?: number;
  abortGraceMs?: number;
}

/**
 * Whole-brain ACP harness for the `openma_supervised` lane.
 *
 * The Session command stream, ACP runtime, native state hooks and event sink
 * all live in the supervisor process. The outer Runtime Host still owns the
 * Work claim, resource fence, workspace/output publication and hard kill.
 */
export function createManagedAcpSupervisorHarness(
  options: ManagedAcpSupervisorHarnessOptions,
): HarnessSupervisorHarness {
  const drainDeadlineMs = options.drainDeadlineMs ?? 5_000;
  const drainPollIntervalMs = options.drainPollIntervalMs ?? 25;
  const abortGraceMs = options.abortGraceMs ?? 1_000;
  assertNonNegativeInteger(drainDeadlineMs, "drainDeadlineMs");
  assertPositiveInteger(drainPollIntervalMs, "drainPollIntervalMs");
  assertNonNegativeInteger(abortGraceMs, "abortGraceMs");

  return {
    async start(input) {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) forwardAbort();
      else input.signal.addEventListener("abort", forwardAbort, { once: true });

      const channel = await options.connect({
        scope: input.scope,
        harness: input.harness,
        workspacePath: input.workspacePath,
        outputPath: input.outputPath,
        signal: controller.signal,
      });
      const runtime = createManagedAgentsRuntime({
        acpRuntime: options.acpRuntime,
        sessionPreparation: options.sessionPreparation,
      });
      const liveSessions = new Set<string>();
      const ownedSessions = new Set<string>();
      const recoveryReasons = new Map<string, ManagedHarnessRecoveryReason>();
      let eventChain = Promise.resolve();
      let finalized = false;
      let queuedPrompts = 0;
      let promptTail = Promise.resolve();

      runtime.attach({
        publish(event) {
          eventChain = eventChain.then(async () => {
            if (event.type === "session.ready") {
              liveSessions.add(event.sessionId);
              await options.sessionState.onReady(event);
            } else if (event.type === "session.complete") {
              await options.sessionState.checkpoint({
                sessionId: event.sessionId,
                turnId: event.turnId,
              });
            } else if (event.type === "session.disposed") {
              await options.sessionState.release({
                sessionId: event.sessionId,
                reason: "destroy",
              });
              liveSessions.delete(event.sessionId);
              ownedSessions.delete(event.sessionId);
              recoveryReasons.delete(event.sessionId);
            }
            await channel.publish(event);
            if (event.type === "session.complete") {
              await input.checkpoint({
                sessionId: event.sessionId,
                turnId: event.turnId,
              });
            }
          });
        },
      });

      const closeChannel = async () => {
        await channel.close();
      };

      const quiesce = async () => {
        if (finalized) return;
        finalized = true;
        await runtime.drain({
          deadlineMs: drainDeadlineMs,
          pollIntervalMs: drainPollIntervalMs,
          abortGraceMs,
        });
        // drain() reaches here only after completed has already observed the
        // event chain; stop() aborts first. A remaining rejection is therefore
        // necessarily a late result from fenced work and must not escape.
        await eventChain.catch(() => undefined);
        for (const sessionId of ownedSessions) {
          if (liveSessions.has(sessionId)) {
            await options.sessionState.checkpoint({ sessionId });
          }
          await options.sessionState.release({ sessionId, reason: "shutdown" });
        }
        liveSessions.clear();
        ownedSessions.clear();
        recoveryReasons.clear();
        await closeChannel();
      };

      const completed = (async (): Promise<{ exitCode: number }> => {
        try {
          let cleanCompletion = false;
          for await (const originalCommand of channel.commands(controller.signal)) {
            controller.signal.throwIfAborted();
            if (originalCommand.type === "control.complete") {
              if (originalCommand.workId !== input.scope.workId) {
                throw new Error(
                  `Harness control attempted cross-work completion ${originalCommand.workId}`,
                );
              }
              cleanCompletion = true;
              break;
            }
            if (originalCommand.sessionId !== input.scope.sessionId) {
              throw new Error(
                `Harness control attempted cross-session command ${originalCommand.sessionId}`,
              );
            }
            let command = originalCommand;
            if (command.type === "session.start") {
              const prepared = await options.sessionState.beforeStart(command);
              ownedSessions.add(command.sessionId);
              command = prepared.command;
              if (prepared.semanticRecoveryReason !== undefined) {
                recoveryReasons.set(command.sessionId, prepared.semanticRecoveryReason);
              }
            } else if (command.type === "session.prompt") {
              const reason = recoveryReasons.get(command.sessionId);
              if (reason !== undefined) {
                if (options.semanticRecovery === undefined) {
                  throw new Error(
                    "Native ACP state is unavailable and no semantic recovery Port is configured",
                  );
                }
                command = {
                  ...command,
                  text: await options.semanticRecovery.build({
                    sessionId: command.sessionId,
                    reason,
                    currentPrompt: command.text,
                  }),
                };
                await channel.publish({
                  type: "session.warning",
                  sessionId: command.sessionId,
                  source: "acp_semantic_recovery",
                  message: "Agent-native session state was unavailable; continued from canonical OpenMA history.",
                  details: { reason },
                });
                recoveryReasons.delete(command.sessionId);
              }
            }
            if (command.type === "session.prompt") {
              // A prompt can run for minutes. Keep the control stream live so
              // steer and cancel commands reach that same ACP session while
              // the turn is in flight. True next-turn prompts remain ordered.
              const dispatched = queuedPrompts === 0
                ? runtime.dispatch(command)
                : promptTail.then(() => runtime.dispatch(command));
              queuedPrompts += 1;
              promptTail = dispatched.finally(() => {
                queuedPrompts -= 1;
              });
            } else {
              if (command.type === "session.dispose") {
                await promptTail;
                await eventChain;
              }
              await runtime.dispatch(command);
              await eventChain;
            }
          }
          if (!cleanCompletion) {
            throw new Error("Harness control stream closed before control.complete");
          }
          await promptTail;
          await eventChain;
          return { exitCode: 0 };
        } catch (error) {
          if (controller.signal.aborted) return { exitCode: 0 };
          throw error;
        }
      })();

      return {
        completed,
        async drain() {
          await completed;
          await quiesce();
          input.signal.removeEventListener("abort", forwardAbort);
        },
        async stop() {
          controller.abort(new Error("Managed ACP harness stopped"));
          await quiesce();
          input.signal.removeEventListener("abort", forwardAbort);
        },
      };
    },
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}
